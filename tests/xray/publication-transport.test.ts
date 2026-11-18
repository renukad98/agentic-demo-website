import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { objectDigest } from "../../tools/agentic/artifacts.js";
import { journalReservationRequestSchema } from "../../tools/agentic/journal-reservation.js";
import { TrustedHumanApprovalBoundary } from "../../tools/agentic/approval-authority.js";
import { executionProposal, importProposal } from "../../tools/xray/planner.js";
import {
  XrayPublicationTransport,
  JiraMcpLinkAdapter,
  publicationRequest,
  validatePublicationReservation,
} from "../../tools/xray/publication-transport.js";
import {
  verifyExecutionMembership,
  verifyImportedRuns,
} from "../../tools/xray/publication-readback.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import {
  writeOperationId,
  createProductionWriteExecutor,
} from "../../tools/xray/write-integration.js";
import { XrayHttpReadTransport } from "../../tools/xray/clients/transport.js";
import { readOperations } from "../../tools/xray/clients/operations.js";
import { jsonFixture, fixtureNow } from "./support/json-journal-fixtures.js";
import { SyntheticHumanAuthority } from "./support/human-authority-fixture.js";
import { identityKey } from "../../tools/xray/identity.js";
import { mockCreation } from "./publication-fixtures.js";
import type { Result } from "../../tools/agentic/contracts/index.js";
import type { HttpFetch } from "../../tools/xray/clients/http.js";

const base = "https://xray.cloud.getxray.app";
const tokens = {
  getToken: async () => "synthetic-token",
  invalidate: () => {
    throw new Error("must not refresh mutations");
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
function fixture() {
  const f = jsonFixture(),
    identity = structuredClone(f.identity);
  identity.xray = {
    key: "SYN-2",
    issueId: "101",
    behaviorDigest: identity.behaviorDigest,
    verifiedAt: new Date(fixtureNow).toISOString(),
  };
  const c = executionProposal(
    "SYN-1",
    "SYN",
    [identity],
    "synthetic-chromium",
    f.proposal.evidenceDigest,
    { ...mockCreation, issueTypeId: "105" },
  );
  const result: Result = {
    identity: identityKey(identity),
    runner: "playwright",
    outcome: "passed",
    attempt: 0,
    startedAt: new Date(fixtureNow).toISOString(),
    durationMs: 10,
    failures: [],
    evidence: ["synthetic.json"],
    artifactDigest: objectDigest({ synthetic: true }),
  };
  const d = importProposal(
    "SYN-1",
    "SYN-3",
    [result],
    [identity],
    f.proposal.evidenceDigest,
  );
  const request = (p: typeof c) =>
    journalReservationRequestSchema.parse({
      ...f.request,
      operation: p.operation,
      scope: [p.operation],
      payloadDigest: p.payloadDigest,
      operationId: writeOperationId({
        tenant: f.request.tenant,
        projectKey: "SYN",
        operation: p.operation as "xray.execution.create",
        payloadDigest: p.payloadDigest,
      }),
      testKey: "SYN-2",
      testIssueId: "101",
      ...(p.operation === "xray.results.import"
        ? { executionKey: "SYN-3", executionIssueId: "102" }
        : {}),
    });
  return { ...f, identity, c, d, request };
}
test("official A/C/D requests use exact paths and allowlisted GraphQL; B uses existing MCP argument direction", async () => {
  const f = fixture(),
    tr = new XrayPublicationTransport(base);
  for (const p of [f.proposal, f.c, f.d]) {
    let calls = 0;
    const response = await tr.exchangeForOfflineValidation(p, {
      tokens,
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, base + publicationRequest(p).path);
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body, publicationRequest(p).body);
        return json({ accepted: true });
      },
    });
    assert.deepEqual(response, { accepted: true });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await new JiraMcpLinkAdapter().exchangeForOfflineValidation(
    f.link,
    { id: "10037", name: "Test", inward: "is tested by", outward: "tests" },
    async (inputs) => {
      calls++;
      assert.deepEqual(inputs, {
        linkType: "Test",
        inwardIssue: "SYN-2",
        outwardIssue: "SYN-1",
      });
    },
  );
  assert.equal(calls, 1);
});
for (const mode of [
  "401",
  "redirect",
  "network",
  "graphql",
  "body",
  "timeout",
] as const) {
  test(`mutation ${mode}: one attempt, no refresh/retry, fixed redacted error`, async () => {
    const f = fixture();
    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls++;
      if (mode === "network") throw new Error("SYNTHETIC_SECRET");
      if (mode === "timeout") return new Promise(() => {});
      if (mode === "401")
        return new Response("SYNTHETIC_SECRET", { status: 401 });
      if (mode === "redirect")
        return new Response("SYNTHETIC_SECRET", { status: 302 });
      if (mode === "body")
        return new Response("SYNTHETIC_SECRET", {
          headers: { "content-type": "application/json" },
        });
      return json({
        errors: [{ message: "SYNTHETIC_SECRET" }],
        data: { partialId: "102" },
      });
    };
    await assert.rejects(
      new XrayPublicationTransport(base, 20).exchangeForOfflineValidation(f.c, {
        tokens,
        fetch,
      }),
      (e) => {
        assert.equal(String(e), "PublicationTransportError: WRITE_UNCERTAIN");
        assert.doesNotMatch(JSON.stringify(e), /SYNTHETIC_SECRET/);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}
test("auth failure is redacted and never reaches mutation", async () => {
  let calls = 0;
  await assert.rejects(
    new XrayPublicationTransport(base).exchangeForOfflineValidation(
      fixture().c,
      {
        tokens: {
          getToken: async () => {
            throw new Error("SYNTHETIC_SECRET");
          },
          invalidate() {},
        },
        fetch: async () => {
          calls++;
          return json({});
        },
      },
    ),
    /AUTH_FAILED/,
  );
  assert.equal(calls, 0);
});
test("arbitrary endpoints, GraphQL, implicit import creation and digest tampering rejected before authentication", async () => {
  const f = fixture();
  let calls = 0;
  for (const change of [
    "query",
    "digest",
    "info",
    "testInfo",
    "other-project",
  ]) {
    const p = structuredClone(
      change === "info" || change === "testInfo" || change === "other-project"
        ? f.d
        : f.c,
    );
    if (change === "query")
      p.payload.query = 'mutation Arbitrary { deleteTest(issueId: "101") }';
    if (change === "info")
      (p.payload.body as Record<string, unknown>).info = { project: "SYN" };
    if (change === "testInfo")
      (
        p.payload.body as { tests: Record<string, unknown>[] }
      ).tests[0]!.testInfo = {};
    if (change === "other-project")
      (p.payload.body as { testExecutionKey: string }).testExecutionKey =
        "OTHER-3";
    if (change !== "digest") p.payloadDigest = objectDigest(p.payload);
    else p.payloadDigest = objectDigest({ changed: true });
    await assert.rejects(
      new XrayPublicationTransport(base).exchangeForOfflineValidation(p, {
        tokens: {
          getToken: async () => {
            calls++;
            return "synthetic-token";
          },
          invalidate() {},
        },
        fetch: async () => {
          calls++;
          return json({});
        },
      }),
      /INVALID_REQUEST/,
    );
  }
  assert.equal(calls, 0);
  assert.throws(() => new XrayPublicationTransport("https://evil.example"));
  assert.throws(() => new XrayPublicationTransport(base + "?token=synthetic"));
});
test("C/D exact scope, identity, target and membership bindings cannot be exchanged", () => {
  const f = fixture();
  for (const p of [f.c, f.d]) {
    const r = f.request(p);
    validatePublicationReservation(r, p.payload);
    for (const edit of [
      { scope: ["jira.test.link"] },
      { testKey: "OTHER-2" },
      { executionKey: "OTHER-3", executionIssueId: "102" },
    ])
      assert.equal(
        journalReservationRequestSchema.safeParse({ ...r, ...edit }).success,
        false,
      );
    assert.throws(() =>
      validatePublicationReservation(
        { ...r, testIssueId: "999", testKey: "SYN-99" },
        p.payload,
      ),
    );
  }
  assert.throws(() =>
    validatePublicationReservation(f.request(f.c), f.d.payload),
  );
});
test("execution membership rejects missing/duplicate/wrong execution pages", () => {
  const expected = { issueId: "102", key: "SYN-3", testIssueIds: ["101"] };
  const page = {
    issueId: "102",
    jira: { key: "SYN-3" },
    tests: { total: 1, start: 0, results: [{ issueId: "101" }] },
  };
  assert.equal(verifyExecutionMembership(expected, [page]), true);
  for (const pages of [
    [],
    [page, page],
    [{ ...page, issueId: "999" }],
    [{ ...page, tests: { ...page.tests, total: 2 } }],
  ])
    assert.throws(
      () => verifyExecutionMembership(expected, pages),
      /RESPONSE_UNVERIFIED/,
    );
});
test("Test Run verification requires exact complete execution membership and statuses", () => {
  const expected = [{ testIssueId: "101", status: "PASSED" }];
  const page = {
    total: 1,
    start: 0,
    results: [
      {
        id: "run-1",
        status: { name: "PASSED" },
        test: { issueId: "101" },
        testExecution: { issueId: "102" },
      },
    ],
  };
  assert.equal(verifyImportedRuns(expected, "102", [page]), true);
  for (const pages of [[], [page, page], [{ ...page, total: 2 }]])
    assert.throws(() => verifyImportedRuns(expected, "102", pages));
  assert.throws(() => verifyImportedRuns(expected, "999", [page]));
  assert.throws(() =>
    verifyImportedRuns([{ testIssueId: "101", status: "FAILED" }], "102", [
      page,
    ]),
  );
});
test("new execution membership operation remains in read-only transport allowlist", async () => {
  const op = readOperations.executionMembers;
  const read = new XrayHttpReadTransport({
    apiBase: base,
    tokens,
    retries: 0,
    fetch: async () =>
      json({
        data: {
          getTestExecution: {
            issueId: "102",
            jira: { key: "SYN-3" },
            tests: {
              total: 1,
              start: 0,
              limit: 100,
              results: [{ issueId: "101", jira: { key: "SYN-2" } }],
            },
          },
        },
      }),
  });
  await read.request(op.query, { id: "102", limit: 100, start: 0 });
});
test("synthetic human C/D approvals reserve separately; replay and absent dependencies fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "phase6d-"));
  const journal = new OperationJournal(root, () => fixtureNow);
  t.after(async () => {
    await journal.close();
    assert.equal(dirname(root), tmpdir());
    assert.ok(basename(root).startsWith("phase6d-"));
    await rm(root, { recursive: true, force: true });
  });
  const f = fixture(),
    authority = new SyntheticHumanAuthority(),
    boundary = new TrustedHumanApprovalBoundary(authority, () => fixtureNow);
  const seed = async (
    operation: "xray.test.create" | "xray.execution.create",
    remoteId: string,
    remoteKey: string,
    targetJournal = journal,
  ) => {
    const entry = {
      schemaVersion: "1.0.0" as const,
      operationId: "synthetic-seed-" + remoteId,
      storyKey: "SYN-1",
      operation,
      payloadDigest: objectDigest({ remoteId }),
      tenant: f.request(f.c).tenant,
      projectKey: "SYN",
      automationIdentity: identityKey(f.identity),
      sourceDigest: f.identity.sourceDigest,
      evidenceDigest: f.c.evidenceDigest,
      remoteIds: [] as string[],
      at: new Date(fixtureNow).toISOString(),
    };
    for (const status of [
      "Planned",
      "Awaiting approval",
      "Approved",
      "Attempted",
      "Confirmed",
    ] as const)
      await targetJournal.record({
        ...entry,
        status,
        ...(["Approved", "Attempted", "Confirmed"].includes(status)
          ? {
              approvalReference: "seed-" + remoteId,
              approvalConsumptionId: "seed-consumption-" + remoteId,
            }
          : {}),
        ...(status === "Confirmed"
          ? {
              remoteIds: [remoteId],
              ...(operation === "xray.test.create"
                ? { remoteTestKey: remoteKey }
                : { remoteExecutionKey: remoteKey }),
            }
          : {}),
      });
  };
  const cr = f.request(f.c),
    dr = f.request(f.d);
  authority.grant("synthetic-c", cr);
  authority.grant("synthetic-d", dr);
  await assert.rejects(
    boundary.authorizeAndReserve(journal, "synthetic-c", cr, f.c.payload),
    /CONFIRMED_TEST/,
  );
  assert.equal(authority.consumeCalls, 0);
  await seed("xray.test.create", "101", "SYN-2");
  await boundary.authorizeAndReserve(journal, "synthetic-c", cr, f.c.payload);
  assert.equal(authority.consumeCalls, 1);
  await assert.rejects(
    boundary.authorizeAndReserve(journal, "synthetic-c", cr, f.c.payload),
  );
  const changed = structuredClone(f.c);
  (
    changed.payload.variables as { jira: { fields: { summary: string } } }
  ).jira.fields.summary = "Changed synthetic summary";
  changed.payloadDigest = objectDigest(changed.payload);
  const changedRequest = f.request(changed);
  authority.grant("synthetic-c-changed", changedRequest);
  await assert.rejects(
    boundary.authorizeAndReserve(
      journal,
      "synthetic-c-changed",
      changedRequest,
      changed.payload,
    ),
    /Existing execution\/result evidence scope/,
  );
  assert.equal(authority.consumeCalls, 1);
  await assert.rejects(
    boundary.authorizeAndReserve(journal, "synthetic-d", dr, f.d.payload),
    /CONFIRMED_EXECUTION/,
  );
  // A separately verified synthetic execution represents completed read-back; it is not a real API result.
  const otherRoot = await mkdtemp(join(tmpdir(), "phase6d-"));
  const otherJournal = new OperationJournal(otherRoot, () => fixtureNow);
  t.after(async () => {
    await otherJournal.close();
    assert.equal(dirname(otherRoot), tmpdir());
    assert.ok(basename(otherRoot).startsWith("phase6d-"));
    await rm(otherRoot, { recursive: true, force: true });
  });
  await seed("xray.test.create", "101", "SYN-2", otherJournal);
  await seed("xray.execution.create", "102", "SYN-3", otherJournal);
  await boundary.authorizeAndReserve(
    otherJournal,
    "synthetic-d",
    dr,
    f.d.payload,
  );
  assert.equal(authority.consumeCalls, 2);
  await assert.rejects(
    boundary.authorizeAndReserve(otherJournal, "synthetic-d", dr, f.d.payload),
  );
  const changedImport = structuredClone(f.d);
  (
    changedImport.payload.body as { tests: { comment: string }[] }
  ).tests[0]!.comment = "Changed synthetic import comment";
  changedImport.payloadDigest = objectDigest(changedImport.payload);
  const changedImportRequest = f.request(changedImport);
  authority.grant("synthetic-d-changed", changedImportRequest);
  const reopened = new OperationJournal(otherRoot, () => fixtureNow);
  try {
    await assert.rejects(
      boundary.authorizeAndReserve(
        reopened,
        "synthetic-d-changed",
        changedImportRequest,
        changedImport.payload,
      ),
      /Existing execution\/result evidence scope/,
    );
    assert.equal(authority.consumeCalls, 2);
  } finally {
    await reopened.close();
  }
  const c = (await journal.entries(cr.operationId)).at(-1)!;
  await assert.rejects(
    journal.record({ ...c, status: "Attempted" }),
    /PRODUCTION_AUTHORITY_EXECUTION_DISABLED/,
  );
});
test("all production execution entry points remain unconditionally disabled", () => {
  assert.throws(
    () => createProductionWriteExecutor(),
    /PRODUCTION_WRITES_DISABLED/,
  );
  assert.throws(
    () => new XrayPublicationTransport(base).execute(),
    /PRODUCTION_WRITES_DISABLED/,
  );
  assert.throws(
    () => new JiraMcpLinkAdapter().execute(),
    /PRODUCTION_WRITES_DISABLED/,
  );
});
