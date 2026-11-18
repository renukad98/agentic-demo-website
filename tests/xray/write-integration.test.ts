import test, { before, after, mock } from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  TrustedApprovalGate,
  type TrustedApprovalAuthority,
  type TrustedApprovalRequest,
} from "../../tools/agentic/approvals.js";
import { objectDigest } from "../../tools/agentic/artifacts.js";
import { IdentityRegistry, identityKey } from "../../tools/xray/identity.js";
import { genericProposal, linkProposal } from "../../tools/xray/planner.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import { createProductionWriteExecutor } from "../../tools/xray/write-integration.js";
import { Publisher } from "../../tools/xray/publisher.js";
import {
  boundFixture,
  fixtureReport,
  fixtureSource,
  mockCreation,
} from "./publication-fixtures.js";
import {
  MockWriteExecutors,
  MockWriteTransport,
  type ReadBack,
  type Clearance,
} from "./support/mock-write-executors.js";

const now = Date.parse("2026-11-16T12:00:00Z");
let networkAttempts = 0;
before(() => {
  const deny = () => {
    networkAttempts++;
    throw new Error("NETWORK_FORBIDDEN_IN_MOCK_TEST");
  };
  mock.method(globalThis, "fetch", deny);
  mock.method(http, "request", deny);
  mock.method(https, "request", deny);
  mock.method(net.Socket.prototype, "connect", deny);
});
after(() => {
  assert.equal(networkAttempts, 0);
  mock.restoreAll();
});
const linkType = {
  id: "10037",
  name: "Test",
  inward: "is tested by",
  outward: "tests",
};
/** Synthetic authority only. Reserving before await is atomic within this JS process,
 * NOT a production distributed approval store or crash-durable authority. */
class MockAuthority implements TrustedApprovalAuthority {
  used = new Set<string>();
  grants = new Map<string, TrustedApprovalRequest>();
  expired = false;
  async consume(
    reference: string,
    request: TrustedApprovalRequest,
    digest: string,
  ) {
    if (
      this.used.has(reference) ||
      objectDigest(this.grants.get(reference) ?? null) !== digest
    )
      throw new Error("MOCK_DENIED");
    this.used.add(reference);
    await Promise.resolve();
    return {
      schemaVersion: "1.0.0",
      approvalId: reference,
      consumptionId: `consumed-${reference}`,
      authorityId: "test-only",
      humanReference: "synthetic-human",
      decision: "approved",
      issuedAt: new Date(now - 1000).toISOString(),
      consumedAt: new Date(now).toISOString(),
      expiresAt: new Date(this.expired ? now - 1 : now + 60000).toISOString(),
      request,
      requestDigest: digest,
    };
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "write-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = boundFixture();
  for (const [path, body] of [
    [identity.sourceLocation, fixtureSource],
    [identity.binding!.historicalExecutions[0]!.artifactPath, fixtureReport],
  ]) {
    await mkdir(dirname(join(root, path!)), { recursive: true });
    await writeFile(join(root, path!), body!);
  }
  const registry = new IdentityRegistry();
  registry.register(identity);
  const journal = new OperationJournal(root);
  const authority = new MockAuthority();
  const gate = new TrustedApprovalGate(authority, () => now);
  const proposal = genericProposal(
    "SYN-1",
    "SYN",
    identity,
    "Synthetic behavior",
    mockCreation,
  );
  const read: ReadBack = {
    issueId: "101",
    testKey: "SYN-2",
    projectKey: "SYN",
    storyKey: "SYN-1",
    identity: identityKey(identity),
    testType: "Generic",
    payloadDigest: proposal.payloadDigest,
    links: [],
  };
  const response = {
    data: {
      createTest: {
        test: {
          issueId: "101",
          jira: { key: "SYN-2" },
          testType: { name: "Generic" },
          unstructured: identityKey(identity),
        },
      },
    },
  };
  const transport = new MockWriteTransport(response, read);
  const engine = (tr = transport) =>
    new MockWriteExecutors(
      root,
      "synthetic-tenant",
      "SYN",
      registry,
      journal,
      gate,
      tr,
      () => now,
    );
  const executor = engine();
  const request = executor.request(proposal, identity);
  authority.grants.set("create", request);
  const clearance = {
    tenant: "synthetic-tenant",
    projectKey: "SYN",
    storyKey: "SYN-1",
    identity: identityKey(identity),
    sourceDigest: identity.sourceDigest,
    evidenceDigest: proposal.evidenceDigest,
    checkedAt: now,
    complete: true,
    matches: 0,
  };
  const create = () =>
    executor.create(proposal, identity, clearance, request, "create");
  const linkedRead = {
    ...read,
    links: [
      {
        testKey: "SYN-2",
        storyKey: "SYN-1",
        typeId: "10037",
        direction: "tests",
      },
    ],
  };
  const link = linkProposal(
    "SYN-1",
    "SYN-2",
    linkType,
    proposal.evidenceDigest,
  );
  const linkRequest = executor.request(link, identity, "SYN-2");
  authority.grants.set("link", linkRequest);
  return {
    root,
    identity,
    registry,
    journal,
    authority,
    gate,
    proposal,
    read,
    response,
    transport,
    engine,
    executor,
    request,
    clearance,
    create,
    link,
    linkRequest,
    linkedRead,
  };
}

test("creation: successful mocked creation and read-back preserve ID/key", async (t) => {
  const f = await fixture(t);
  const result = await f.create();
  assert.equal(result.kind, "MOCK_ONLY");
  assert.equal(result.testKey, "SYN-2");
  const last = (await f.journal.entries(f.request.operationId)).at(-1)!;
  assert.equal(last.status, "Confirmed");
  assert.deepEqual(last.remoteIds, ["101"]);
  assert.equal(last.remoteTestKey, "SYN-2");
  assert.equal(f.transport.createCalls, 1);
});
for (const field of [
  "tenant",
  "projectKey",
  "target",
  "automationIdentity",
  "evidenceDigest",
  "payloadDigest",
  "operationId",
  "scope",
] as const) {
  test(`approval: reject altered ${field} before transport`, async (t) => {
    const f = await fixture(t);
    const request = structuredClone(f.request);
    if (field === "scope") request.scope = ["jira.test.link"];
    else request[field] = "wrong";
    await assert.rejects(
      f.executor.create(f.proposal, f.identity, f.clearance, request, "create"),
    );
    assert.equal(f.transport.createCalls, 0);
  });
}
test("approval: missing reference denied", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.executor.create(f.proposal, f.identity, f.clearance, f.request, ""),
  );
  assert.equal(f.transport.createCalls, 0);
});
test("approval: absent authority grant denied", async (t) => {
  const f = await fixture(t);
  f.authority.grants.clear();
  await assert.rejects(f.create());
  assert.equal(f.transport.createCalls, 0);
});
test("approval: expired receipt denied", async (t) => {
  const f = await fixture(t);
  f.authority.expired = true;
  await assert.rejects(f.create());
  assert.equal(f.transport.createCalls, 0);
});
test("approval: shared mock authority atomically rejects concurrent cross-gate consumption", async (t) => {
  const f = await fixture(t);
  const other = new TrustedApprovalGate(f.authority, () => now);
  const results = await Promise.allSettled([
    f.gate.consume("create", f.request, f.proposal.payload),
    other.consume("create", f.request, f.proposal.payload),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.authority.used.size, 1);
});
test("approval: consumed grant cannot replay in another gate", async (t) => {
  const f = await fixture(t);
  await f.gate.consume("create", f.request, f.proposal.payload);
  await assert.rejects(
    new TrustedApprovalGate(f.authority, () => now).consume(
      "create",
      f.request,
      f.proposal.payload,
    ),
  );
});
for (const mode of [
  "missing Reporter",
  "invalid project",
  "invalid identity",
  "changed query",
  "changed payload",
  "changed evidence",
  "stale clearance",
  "missing clearance",
  "conflicting duplicate",
  "incomplete clearance",
  "wrong clearance tenant",
  "future clearance",
] as const) {
  test(`creation: ${mode} fails closed`, async (t) => {
    const f = await fixture(t);
    const p = structuredClone(f.proposal);
    const identity = structuredClone(f.identity);
    const clearance = structuredClone(f.clearance);
    const variables = p.payload.variables as {
      jira: { fields: { reporter?: unknown; project: { id: string } } };
    };
    if (mode === "missing Reporter") delete variables.jira.fields.reporter;
    if (mode === "invalid project") variables.jira.fields.project.id = "not-id";
    if (mode === "invalid identity") identity.automationId = "conflict";
    if (mode === "changed query") p.payload.query = "mutation forbidden {}";
    if (mode === "changed payload")
      p.payloadDigest = "sha256:" + "0".repeat(64);
    if (mode === "changed evidence")
      p.evidenceDigest = "sha256:" + "0".repeat(64);
    if (mode === "stale clearance") clearance.checkedAt = now - 300001;
    if (mode === "missing clearance")
      Object.assign(clearance, { complete: false });
    if (mode === "conflicting duplicate") clearance.matches = 1;
    if (mode === "incomplete clearance") clearance.complete = false;
    if (mode === "wrong clearance tenant") clearance.tenant = "other";
    if (mode === "future clearance") clearance.checkedAt = now + 1;
    if (["missing Reporter", "invalid project", "changed query"].includes(mode))
      p.payloadDigest = objectDigest(p.payload);
    await assert.rejects(
      f.executor.create(
        p,
        identity,
        mode === "missing clearance"
          ? (undefined as unknown as Clearance)
          : clearance,
        f.request,
        "create",
      ),
    );
    assert.equal(f.transport.createCalls, 0);
  });
}
for (const mode of [
  "missing ID",
  "missing key",
  "invalid key",
  "timeout",
  "conflicting read ID",
  "missing read-back",
  "invalid type",
] as const) {
  test(`recovery: ${mode} becomes uncertain without retry`, async (t) => {
    const f = await fixture(t);
    const response = structuredClone(f.response);
    const read = structuredClone(f.read);
    if (mode === "missing ID") response.data.createTest.test.issueId = "";
    if (mode === "missing key") response.data.createTest.test.jira.key = "";
    if (mode === "invalid key")
      response.data.createTest.test.jira.key = "OTHER-3";
    if (mode === "invalid type")
      response.data.createTest.test.testType.name = "Manual";
    if (mode === "conflicting read ID") read.issueId = "999";
    const tr = new MockWriteTransport(
      response,
      mode === "missing read-back" ? null : read,
      mode === "timeout",
    );
    const engine = f.engine(tr);
    await assert.rejects(
      engine.create(f.proposal, f.identity, f.clearance, f.request, "create"),
    );
    const last = (await f.journal.entries(f.request.operationId)).at(-1)!;
    assert.equal(last.status, "Uncertain");
    if (!["missing ID", "timeout"].includes(mode))
      assert.deepEqual(last.remoteIds, ["101"]);
    await assert.rejects(
      engine.create(f.proposal, f.identity, f.clearance, f.request, "create"),
    );
    assert.equal(tr.createCalls, 1);
  });
}
test("recovery: repeated confirmed operation never creates another Test", async (t) => {
  const f = await fixture(t);
  await f.create();
  await assert.rejects(f.create());
  assert.equal(f.transport.createCalls, 1);
});
test("recovery: changed proposal cannot create a second Test for the same identity", async (t) => {
  const f = await fixture(t);
  await f.create();
  const changed = genericProposal(
    "SYN-1",
    "SYN",
    f.identity,
    "Changed summary",
    mockCreation,
  );
  const request = f.executor.request(changed, f.identity);
  f.authority.grants.set("another", request);
  await assert.rejects(
    f.executor.create(changed, f.identity, f.clearance, request, "another"),
  );
  assert.equal(f.transport.createCalls, 1);
  assert.equal(f.authority.used.has("another"), false);
});
test("recovery: new approval cannot bypass uncertain creation reconciliation", async (t) => {
  const f = await fixture(t);
  const transport = new MockWriteTransport(f.response, f.read, true);
  const executor = f.engine(transport);
  await assert.rejects(
    executor.create(f.proposal, f.identity, f.clearance, f.request, "create"),
  );
  const changed = genericProposal(
    "SYN-1",
    "SYN",
    f.identity,
    "Changed summary",
    mockCreation,
  );
  const request = executor.request(changed, f.identity);
  f.authority.grants.set("another", request);
  await assert.rejects(
    executor.create(changed, f.identity, f.clearance, request, "another"),
  );
  assert.equal(transport.createCalls, 1);
  assert.equal(f.authority.used.has("another"), false);
});
test("recovery: concurrent journal attempts allow at most one transport call", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.transport.createCalls, 1);
});
test("recovery: confirmed ID and key cannot be changed or discarded", async (t) => {
  const f = await fixture(t);
  await f.create();
  const confirmed = (await f.journal.entries(f.request.operationId)).at(-1)!;
  await assert.rejects(
    f.journal.record({
      ...confirmed,
      status: "Uncertain",
      remoteIds: ["999"],
      remoteTestKey: "SYN-99",
    }),
  );
  assert.deepEqual(
    (await f.journal.entries(f.request.operationId)).at(-1)!.remoteIds,
    ["101"],
  );
});
test("link: successful separate mocked approval and post-link read-back", async (t) => {
  const f = await fixture(t);
  await f.create();
  const tr = new MockWriteTransport(f.response, f.read, false, f.linkedRead);
  assert.equal(
    (await f.engine(tr).link(f.proposal, f.identity, f.linkRequest, "link"))
      .kind,
    "MOCK_ONLY",
  );
  assert.equal(tr.linkCalls, 1);
  assert.equal(tr.createCalls, 0);
});
for (const mode of [
  "no confirmed creation",
  "missing read-back",
  "wrong read-back Story",
  "equivalent link",
  "conflicting link",
  "wrong direction",
  "missing approval",
  "creation approval",
  "timeout",
  "missing post-link read-back",
] as const) {
  test(`link: ${mode}`, async (t) => {
    const f = await fixture(t);
    if (mode !== "no confirmed creation") await f.create();
    const read = structuredClone(f.read);
    const request = structuredClone(f.linkRequest);
    if (mode === "equivalent link") read.links = f.linkedRead.links;
    if (mode === "conflicting link")
      read.links = [{ ...f.linkedRead.links[0]!, storyKey: "SYN-99" }];
    if (mode === "wrong direction")
      read.links = [{ ...f.linkedRead.links[0]!, direction: "is tested by" }];
    if (mode === "wrong read-back Story") read.storyKey = "SYN-99";
    const tr = new MockWriteTransport(
      f.response,
      mode === "missing read-back" ? null : read,
      mode === "timeout",
    );
    const engine = f.engine(tr);
    if (mode === "equivalent link") {
      assert.equal(
        (await engine.link(f.proposal, f.identity, request, "link")).kind,
        "MOCK_ALREADY_LINKED",
      );
      assert.equal(tr.linkCalls, 0);
      return;
    }
    await assert.rejects(
      engine.link(
        f.proposal,
        f.identity,
        mode === "creation approval" ? f.request : request,
        mode === "missing approval" ? "" : "link",
      ),
    );
    if (mode !== "no confirmed creation")
      assert.deepEqual(
        (await f.journal.entries(f.request.operationId)).at(-1)!.remoteIds,
        ["101"],
      );
    if (mode === "timeout" || mode === "missing post-link read-back") {
      await assert.rejects(
        engine.link(f.proposal, f.identity, request, "link"),
      );
      assert.equal(tr.linkCalls, 1);
    } else assert.equal(tr.linkCalls, 0);
    assert.equal(tr.createCalls, 0);
  });
}
test("approval: link authorization cannot create a Test", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.executor.create(
      f.proposal,
      f.identity,
      f.clearance,
      f.linkRequest,
      "link",
    ),
  );
  assert.equal(f.transport.createCalls, 0);
});
test("link: consumed link approval and confirmed operation cannot replay", async (t) => {
  const f = await fixture(t);
  await f.create();
  const tr = new MockWriteTransport(f.response, f.read, false, f.linkedRead);
  await f.engine(tr).link(f.proposal, f.identity, f.linkRequest, "link");
  const replay = new MockWriteTransport(
    f.response,
    f.read,
    false,
    f.linkedRead,
  );
  await assert.rejects(
    f.engine(replay).link(f.proposal, f.identity, f.linkRequest, "link"),
  );
  assert.equal(replay.linkCalls, 0);
});
test("boundary: production factory and existing publisher unconditionally deny", async () => {
  assert.throws(() => createProductionWriteExecutor(), /DISABLED/);
  assert.equal(new Publisher().remoteWritesEnabled, false);
});
test("boundary: environment and command-line flags cannot enable production", () => {
  const prior = process.env.XRAY_ENABLE_PUBLICATION;
  const length = process.argv.length;
  try {
    process.env.XRAY_ENABLE_PUBLICATION = "true";
    process.argv.push("--enable-publication", "--enable-write");
    assert.throws(() => createProductionWriteExecutor(), /DISABLED/);
    assert.equal(new Publisher().remoteWritesEnabled, false);
  } finally {
    process.argv.length = length;
    if (prior === undefined) delete process.env.XRAY_ENABLE_PUBLICATION;
    else process.env.XRAY_ENABLE_PUBLICATION = prior;
  }
});
test("boundary: no production import reaches test-only harness or live registrations", async () => {
  async function scan(path: string): Promise<string[]> {
    const files = await readdir(path, { withFileTypes: true });
    return (
      await Promise.all(
        files.map((f) =>
          f.isDirectory()
            ? scan(join(path, f.name))
            : f.name.endsWith(".ts")
              ? [join(path, f.name)]
              : [],
        ),
      )
    ).flat();
  }
  for (const file of [...(await scan("tools")), ...(await scan("src"))])
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /import[^;]*(?:mock-write-executors|write-integration\.test)/,
    );
  const source = await readFile("tools/xray/write-integration.ts", "utf8");
  assert.doesNotMatch(
    source,
    /process\.env|process\.argv|fetch\(|https?:|mcp__/,
  );
  const harness = await readFile(
    "tests/xray/support/mock-write-executors.ts",
    "utf8",
  );
  assert.doesNotMatch(
    harness,
    /process\.env|process\.argv|fetch\(|node:https|node:http|mcp__|authentication/,
  );
});
