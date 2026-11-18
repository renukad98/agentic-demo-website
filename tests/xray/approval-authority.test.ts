import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { TrustedHumanApprovalBoundary } from "../../tools/agentic/approval-authority.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import { objectDigest } from "../../tools/agentic/artifacts.js";
import { Publisher } from "../../tools/xray/publisher.js";
import { createProductionWriteExecutor } from "../../tools/xray/write-integration.js";
import {
  fixtureNow,
  jsonFixture,
  syntheticGate,
} from "./support/json-journal-fixtures.js";
import { SyntheticHumanAuthority } from "./support/human-authority-fixture.js";
let network = 0;
before(() => {
  const deny = () => {
    network++;
    throw new Error("NETWORK_FORBIDDEN");
  };
  mock.method(globalThis, "fetch", deny);
  mock.method(http, "request", deny);
  mock.method(https, "request", deny);
  mock.method(net.Socket.prototype, "connect", deny);
});
after(() => {
  assert.equal(network, 0);
  mock.restoreAll();
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(join(tmpdir(), "human-approval-")),
    instances: OperationJournal[] = [];
  const open = () => {
    const journal = new OperationJournal(root, () => fixtureNow);
    instances.push(journal);
    return journal;
  };
  const journal = open(),
    data = jsonFixture(),
    authority = new SyntheticHumanAuthority();
  authority.grant("create", data.request);
  authority.grant("link", data.linkRequest);
  const boundary = new TrustedHumanApprovalBoundary(
    authority,
    () => fixtureNow,
  );
  const reserve = () =>
    boundary.authorizeAndReserve(
      journal,
      "create",
      data.request,
      data.proposal.payload,
    );
  const snapshot = async () =>
    JSON.parse(
      await fs.readFile(join(root, "journal", "operations.json"), "utf8"),
    );
  t.after(async () => {
    for (const item of instances)
      try {
        await item.close();
      } catch {
        /* fixture already closed/failed */
      }
    assert(root.startsWith(join(tmpdir(), "human-approval-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    ...data,
    root,
    open,
    journal,
    authority,
    boundary,
    reserve,
    snapshot,
  };
}
test("human authority: valid synthetic decision consumes once and audits authenticated source identity", async (t) => {
  const f = await fixture(t),
    result = await f.reserve();
  assert.equal(result.authorityState, "consumed");
  assert.equal(result.productionExecution, "BLOCKED");
  assert.equal(f.authority.consumeCalls, 1);
  const row = (await f.snapshot()).consumptions[0];
  assert.equal(row.authority.approverSubject, "synthetic-person");
  assert.deepEqual(
    row.authority.events.map((e: { state: string }) => e.state),
    ["pending", "consumed"],
  );
  assert.equal(
    row.authority.events[1].externalConsumptionId,
    "external-create",
  );
  await assert.rejects(f.reserve(), /REPLAY/);
  assert.equal(f.authority.consumeCalls, 1);
});
test("human authority: default source denies and JSON identity is not an API input", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new TrustedHumanApprovalBoundary().authorizeAndReserve(
      f.journal,
      "create",
      f.request,
      f.proposal.payload,
    ),
    /UNAVAILABLE/,
  );
  await assert.rejects(
    f.journal.applyAuthorityTransition({
      operationId: f.request.operationId,
      event: { state: "consumed" },
    }),
    /UNVERIFIED/,
  );
  assert.equal(f.authority.consumeCalls, 0);
});
for (const mode of [
  "missing",
  "expired",
  "revoked",
  "unavailable",
  "denied",
  "wrong identity reference",
  "future authentication",
] as const) {
  test("human authority: " + mode + " decision fails closed", async (t) => {
    const f = await fixture(t),
      decision = f.authority.decisions.get("create")!;
    if (mode === "missing") f.authority.decisions.clear();
    if (mode === "expired")
      decision.expiresAt = new Date(fixtureNow - 1).toISOString();
    if (mode === "revoked")
      await f.authority.revokeApproval("create", objectDigest(f.request));
    if (mode === "unavailable") f.authority.unavailable = true;
    if (mode === "denied") decision.decision = "denied";
    if (mode === "wrong identity reference")
      decision.humanReference = "agent-declared";
    if (mode === "future authentication")
      decision.approver.authenticatedAt = new Date(
        fixtureNow + 1000,
      ).toISOString();
    await assert.rejects(f.reserve());
    assert.equal(f.authority.consumeCalls, 0);
    assert.deepEqual(await f.journal.latestEntries(), []);
  });
}
for (const field of [
  "tenant",
  "projectKey",
  "target",
  "automationIdentity",
  "payloadDigest",
  "evidenceDigest",
  "sourceDigest",
  "preflightDigest",
  "operationId",
  "executorPrincipal",
  "authorityEpoch",
] as const) {
  test(
    "human authority: exact " + field + " binding rejects substitutions",
    async (t) => {
      const f = await fixture(t),
        request = structuredClone(f.request);
      if (field.endsWith("Digest")) request[field] = "sha256:" + "0".repeat(64);
      else if (field === "projectKey") request[field] = "OTHER";
      else if (field === "target") request[field] = "OTHER-1";
      else request[field] = "other";
      await assert.rejects(
        f.boundary.authorizeAndReserve(
          f.journal,
          "create",
          request,
          f.proposal.payload,
        ),
      );
      assert.equal(f.authority.consumeCalls, 0);
    },
  );
}
test("human authority: payload changes rejected before reservation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.boundary.authorizeAndReserve(f.journal, "create", f.request, {
      changed: true,
    }),
    /PAYLOAD/,
  );
  assert.equal(f.authority.consumeCalls, 0);
});
test("human authority: duplicate operation with another approval cannot consume again", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  f.authority.grant("another", f.request);
  await assert.rejects(
    f.boundary.authorizeAndReserve(
      f.journal,
      "another",
      f.request,
      f.proposal.payload,
    ),
  );
  assert.equal(f.authority.consumeCalls, 1);
});
test("human authority: concurrent boundaries cannot consume the same operation twice", async (t) => {
  const f = await fixture(t),
    other = new TrustedHumanApprovalBoundary(f.authority, () => fixtureNow);
  const results = await Promise.allSettled([
    f.reserve(),
    other.authorizeAndReserve(
      f.journal,
      "create",
      f.request,
      f.proposal.payload,
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.authority.consumeCalls, 1);
});
test("human authority: revocation after consumption is audited and blocks operation", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  await f.authority.revokeApproval("create", objectDigest(f.request));
  await f.boundary.refreshRevocation(f.journal, "create", f.request);
  const row = (await f.snapshot()).consumptions[0];
  assert.deepEqual(
    row.authority.events.map((e: { state: string }) => e.state),
    ["pending", "consumed", "revoked"],
  );
  assert.equal(
    (await f.journal.entries(f.request.operationId)).at(-1)!.status,
    "Uncertain",
  );
  await assert.rejects(f.journal.assertNoUncertainOperations());
  const audit = await f.authority.readAudit("create", objectDigest(f.request));
  assert.equal((audit as unknown[]).length, 4);
});
test("human authority: unavailable revocation read cannot authorize or change operation", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const before = await f.snapshot();
  f.authority.unavailable = true;
  await assert.rejects(
    f.boundary.refreshRevocation(f.journal, "create", f.request),
  );
  assert.deepEqual(await f.snapshot(), before);
});
test("human authority: consumed reservation cannot attempt production execution", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const entry = (await f.journal.entries(f.request.operationId)).at(-1)!;
  await assert.rejects(
    f.journal.record({ ...entry, status: "Attempted" }),
    /PRODUCTION_AUTHORITY_EXECUTION_DISABLED/,
  );
});
test("human authority: lost consumption response persists uncertainty and never retries", async (t) => {
  const f = await fixture(t);
  f.authority.consumeFailure = true;
  await assert.rejects(f.reserve(), /CONSUMPTION_UNCERTAIN/);
  assert.equal(f.authority.used.has("create"), true);
  assert.equal(
    (await f.snapshot()).consumptions[0].authority.events.at(-1).state,
    "uncertain",
  );
  await assert.rejects(f.reserve());
  assert.equal(f.authority.consumeCalls, 1);
});
test("human authority: journal reservation failure prevents external consumption", async (t) => {
  const f = await fixture(t),
    fault = mock.method(fs, "rename", async () => {
      throw new Error("SYNTHETIC_FS");
    });
  try {
    await assert.rejects(f.reserve());
  } finally {
    fault.mock.restore();
  }
  assert.equal(f.authority.consumeCalls, 0);
});
test("human authority: journal failure after consumption retains pending recovery state", async (t) => {
  const f = await fixture(t),
    rename = fs.rename;
  let calls = 0;
  const fault = mock.method(
    fs,
    "rename",
    async (...args: Parameters<typeof fs.rename>) => {
      calls++;
      if (calls === 2) throw new Error("SYNTHETIC_FS");
      await rename(...args);
    },
  );
  try {
    await assert.rejects(f.reserve(), /JOURNAL_RECONCILIATION/);
  } finally {
    fault.mock.restore();
  }
  assert.equal(f.authority.consumeCalls, 1);
  assert.equal(f.authority.used.has("create"), true);
  assert.equal(
    (await f.snapshot()).consumptions[0].authority.events.at(-1).state,
    "pending",
  );
  await assert.rejects(f.reserve());
  assert.equal(f.authority.consumeCalls, 1);
});
test("human authority: restart preserves consumed approval and never resumes a write", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  await f.journal.close();
  const journal = f.open();
  await assert.rejects(
    f.boundary.authorizeAndReserve(
      journal,
      "create",
      f.request,
      f.proposal.payload,
    ),
  );
  const entry = (await journal.entries(f.request.operationId)).at(-1)!;
  await assert.rejects(journal.record({ ...entry, status: "Attempted" }));
  assert.equal(f.authority.consumeCalls, 1);
});
test("human authority: creation and linking require separately bound decisions", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.boundary.authorizeAndReserve(
      f.journal,
      "create",
      f.linkRequest,
      f.link.payload,
    ),
  );
  await assert.rejects(
    f.boundary.authorizeAndReserve(
      f.journal,
      "link",
      f.request,
      f.proposal.payload,
    ),
  );
  assert.equal(f.authority.consumeCalls, 0);
  // A pre-existing locally confirmed Test fixture is audit data, not a real remote write.
  const reserved = await f.journal.consumeAndReserve(
    f.request,
    f.proposal.payload,
    await syntheticGate(f.request).verify("legacy-create", f.request),
  );
  await f.journal.record({ ...reserved.entry, status: "Attempted" });
  await f.journal.record({
    ...reserved.entry,
    status: "Confirmed",
    remoteIds: ["101"],
    remoteTestKey: "SYN-2",
  });
  const link = await f.boundary.authorizeAndReserve(
    f.journal,
    "link",
    f.linkRequest,
    f.link.payload,
  );
  assert.equal(link.authorityState, "consumed");
  assert.equal(
    (await f.journal.entries(f.request.operationId)).at(-1)!.remoteTestKey,
    "SYN-2",
  );
});
test("human authority boundary: synthetic fixtures are not imported by production and publisher stays disabled", async () => {
  async function scan(path: string): Promise<string[]> {
    return (
      await Promise.all(
        (await fs.readdir(path, { withFileTypes: true })).map((f) =>
          f.isDirectory()
            ? scan(join(path, f.name))
            : f.name.endsWith(".ts")
              ? [join(path, f.name)]
              : [],
        ),
      )
    ).flat();
  }
  for (const file of await scan("tools"))
    assert.doesNotMatch(
      await fs.readFile(file, "utf8"),
      /import[^;]*(?:human-authority-fixture|approval-authority\.test)/,
    );
  assert.equal(new Publisher().remoteWritesEnabled, false);
  assert.throws(() => createProductionWriteExecutor(), /DISABLED/);
  const source = await fs.readFile(
    "tools/agentic/approval-authority.ts",
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /process\.env|process\.argv|fetch\(|https?:|node:sqlite/,
  );
});
test("human authority: missing authentication metadata and agent-declared approver are rejected", async (t) => {
  const f = await fixture(t);
  const response = structuredClone(f.authority.decisions.get("create")!);
  const fault = mock.method(f.authority, "verify", async () => ({
    ...response,
    approver: undefined,
  }));
  try {
    await assert.rejects(f.reserve(), /INVALID/);
  } finally {
    fault.mock.restore();
  }
  const agentRequest = {
    ...f.request,
    approver: { subject: "agent-declared" },
  };
  await assert.rejects(
    f.boundary.authorizeAndReserve(
      f.journal,
      "create",
      agentRequest,
      f.proposal.payload,
    ),
  );
  assert.equal(f.authority.consumeCalls, 0);
});
test("human authority: reused external consumption audit ID blocks a second binding", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const payload = { differentSyntheticIdentity: true };
  const request = {
    ...f.request,
    operationId: "other-operation",
    automationIdentity: "synthetic:playwright:other",
    payloadDigest: objectDigest(payload),
  };
  f.authority.grant("other", request);
  f.authority.returnedConsumptionId = "external-create";
  await assert.rejects(
    f.boundary.authorizeAndReserve(f.journal, "other", request, payload),
    /JOURNAL_RECONCILIATION/,
  );
  const document = await f.snapshot();
  assert.equal(
    document.consumptions[0].authority.events.at(-1).externalConsumptionId,
    "external-create",
  );
  assert.equal(
    document.consumptions[1].authority.events.at(-1).state,
    "pending",
  );
});
