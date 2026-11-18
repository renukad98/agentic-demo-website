import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  IdentityRegistry,
  identityKey,
  verifyBinding,
  bindingBehaviorDigest,
} from "../../tools/xray/identity.js";
import {
  genericProposal,
  genericProposalPreview,
  genericVariablesSchema,
  pendingLinkProposal,
  linkProposal,
  consumeGenericProposalApproval,
} from "../../tools/xray/planner.js";
import { objectDigest, fingerprint } from "../../tools/agentic/artifacts.js";
import {
  TrustedApprovalGate,
  requireApproval,
  type TrustedApprovalRequest,
  type TrustedApprovalAuthority,
} from "../../tools/agentic/approvals.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import { Publisher } from "../../tools/xray/publisher.js";
import {
  boundFixture,
  mockCreation,
  fixtureSource,
  fixtureReport,
} from "./publication-fixtures.js";
import {
  createDemoEvidenceFixture,
  registryFile,
} from "./support/local-demo-evidence.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "generic-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = boundFixture();
  const sourcePath = join(root, identity.sourceLocation);
  const evidencePath = join(
    root,
    identity.binding!.historicalExecutions[0]!.artifactPath,
  );
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, fixtureSource);
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, fixtureReport);
  return { root, identity, sourcePath, evidencePath };
}
test("durable identity persists independently of native IDs and supports two Story memberships", async (t) => {
  const { root, identity } = await fixture(t);
  const registry = new IdentityRegistry();
  registry.register(identity);
  registry.register(identity);
  registry.register({
    ...identity,
    associations: [{ ...identity.associations[0]!, storyKey: "SYN-2" }],
  });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]!.associations.length, 2);
  assert.notEqual(identity.automationId, identity.binding!.runnerIds[0]);
  await registry.save(root, "v1");
  const loaded = await IdentityRegistry.load(root, "registry-v1.json");
  assert.equal(
    identityKey(
      loaded.resolveRunner(
        identity.repository,
        "playwright",
        "historical-runner-1",
        "SYN-2",
      ),
    ),
    identityKey(identity),
  );
  assert.throws(
    () =>
      loaded.resolveRunner(
        identity.repository,
        "playwright",
        "historical-runner-1",
        "OTHER-1",
      ),
    /Story/,
  );
  await assert.rejects(loaded.save(root, "v1"), /EEXIST/);
});
test("alias identity, duplicate runner binding and conflicting confirmed Xray IDs are rejected", () => {
  const identity = boundFixture();
  const registry = new IdentityRegistry();
  registry.register(identity);
  assert.throws(
    () => registry.register({ ...identity, automationId: "another-id" }),
    /Conflicting/,
  );
  const mapped = {
    ...identity,
    xray: {
      key: "SYN-51",
      issueId: "51",
      verifiedAt: "2026-11-16T00:00:00Z",
      behaviorDigest: identity.behaviorDigest,
    },
  };
  registry.register(mapped);
  assert.throws(
    () =>
      registry.register({ ...mapped, xray: { ...mapped.xray, issueId: "52" } }),
    /Ambiguous/,
  );
  assert.throws(
    () =>
      registry.register({
        ...identity,
        binding: {
          ...identity.binding!,
          runnerIds: ["historical-runner-1", "historical-runner-1"],
        },
      }),
    /Duplicate/,
  );
});
test("source and evidence fingerprints are independent and stale edits block planning", async (t) => {
  const { root, identity, sourcePath, evidencePath } = await fixture(t);
  const proof = await verifyBinding(root, identity);
  assert.notEqual(proof.sourceDigest, proof.evidenceDigest);
  await writeFile(sourcePath, "changed source");
  await assert.rejects(verifyBinding(root, identity), /Stale source/);
  await writeFile(sourcePath, fixtureSource);
  await writeFile(evidencePath, "changed evidence");
  await assert.rejects(
    genericProposalPreview(
      root,
      "SYN-1",
      "SYN",
      identity,
      "Synthetic",
      mockCreation,
    ),
    /Stale execution/,
  );
});
test("matching artifact bytes cannot disguise a missing or failed historical test", async (t) => {
  const { root, identity, evidencePath } = await fixture(t);
  const report = JSON.parse(fixtureReport);
  report.suites[0].specs[0].tests[0].results[0].status = "failed";
  const body = JSON.stringify(report);
  await writeFile(evidencePath, body);
  identity.binding!.historicalExecutions[0]!.artifactDigest = fingerprint(body);
  await assert.rejects(
    verifyBinding(root, identity),
    /not an unqualified pass/,
  );
  identity.binding!.runnerIds = ["missing-runner"];
  identity.binding!.historicalExecutions[0]!.runnerId = "missing-runner";
  await assert.rejects(verifyBinding(root, identity), /missing or ambiguous/);
});
test("binding cannot fingerprint secrets or escape the repository", async (t) => {
  const { root, identity } = await fixture(t);
  identity.sourceLocation = "../outside.spec.ts";
  identity.binding!.sourceFiles = {
    "../outside.spec.ts": fingerprint(fixtureSource),
  };
  identity.sourceDigest = objectDigest(identity.binding!.sourceFiles);
  identity.behaviorDigest = bindingBehaviorDigest(identity);
  await assert.rejects(verifyBinding(root, identity), /Unsafe/);
});
for (const creation of [
  undefined,
  {},
  { ...mockCreation, reporter: undefined },
  { ...mockCreation, reporter: { accountId: "" } },
  { ...mockCreation, reporter: { accountId: "<UNRESOLVED>" } },
  { ...mockCreation, reporter: { accountId: " spaces " } },
  { ...mockCreation, projectId: "invalid" },
  { ...mockCreation, issueTypeId: "0" },
]) {
  test(`required Jira fields fail closed: ${JSON.stringify(creation)}`, () => {
    assert.throws(
      () =>
        genericProposal(
          "SYN-1",
          "SYN",
          boundFixture(),
          "Synthetic",
          creation as typeof mockCreation,
        ),
      /required Jira/,
    );
  });
}
test("Generic proposal contains required fields, traceability, fingerprints and deterministic exact-payload digest", async (t) => {
  const { root, identity } = await fixture(t);
  const result = await genericProposalPreview(
    root,
    "SYN-1",
    "SYN",
    identity,
    "Synthetic",
    mockCreation,
  );
  assert.equal(result.status, "READY_LOCALLY");
  if (result.status !== "READY_LOCALLY") assert.fail();
  const variables = genericVariablesSchema.parse(
    result.proposal.payload.variables,
  );
  assert.equal(
    variables.jira.fields.reporter.accountId,
    mockCreation.reporter.accountId,
  );
  assert.equal(variables.jira.fields.project.id, "100");
  assert.equal(variables.jira.fields.issuetype.id, "104");
  assert.equal(variables.unstructured, identityKey(identity));
  assert.match(
    variables.jira.fields.description,
    /Historical pass \(not a new execution\)/,
  );
  for (const value of [
    "R1",
    "A1",
    "C1",
    identity.sourceLocation,
    identity.sourceDigest,
  ])
    assert.ok(variables.jira.fields.description.includes(value));
  assert.equal(
    result.proposal.payloadDigest,
    objectDigest(result.proposal.payload),
  );
  assert.notEqual(
    result.proposal.evidenceDigest,
    result.proposal.payloadDigest,
  );
  assert.equal(
    genericProposal("SYN-1", "SYN", identity, "Synthetic", mockCreation)
      .payloadDigest,
    result.proposal.payloadDigest,
  );
  await assert.rejects(new Publisher().publish(result.proposal), /disabled/);
});
test("missing Reporter produces only a blocked inert preview; its digest cannot stand in for an approval payload", async (t) => {
  const { root, identity } = await fixture(t);
  const result = await genericProposalPreview(
    root,
    "SYN-1",
    "SYN",
    identity,
    "Synthetic",
    { projectId: "100", issueTypeId: "104" },
  );
  assert.equal(result.status, "BLOCKED");
  if (result.status !== "BLOCKED") assert.fail();
  assert.equal(result.payloadDigest, null);
  assert.equal(result.approvableStructure, false);
  assert.ok(result.blockers.includes("reporter"));
  assert.equal(result.previewPayload.variables.jira.fields.reporter, null);
  assert.throws(
    () =>
      genericProposal(
        "SYN-1",
        "SYN",
        { ...identity, binding: undefined },
        "Synthetic",
        mockCreation,
      ),
    /binding required/,
  );
});
test("link remains separately approved and unresolved until a real Test key is available", () => {
  const type = {
    id: "37",
    name: "Test",
    inward: "is tested by",
    outward: "tests",
  };
  const pending = pendingLinkProposal("SYN-1", type, fingerprint("evidence"));
  assert.equal(pending.status, "BLOCKED");
  assert.equal(pending.previewPayload.inwardIssue.key, null);
  assert.equal(pending.payloadDigest, null);
  const link = linkProposal("SYN-1", "SYN-51", type, fingerprint("evidence"));
  assert.equal(link.operation, "jira.test.link");
  assert.deepEqual(link.payload.outwardIssue, { key: "SYN-1" });
});

const instant = Date.parse("2026-11-16T12:00:00Z");
const payload = { operation: "synthetic-create", field: "value" };
const request: TrustedApprovalRequest = {
  schemaVersion: "1.0.0",
  operation: "xray.test.create",
  target: "SYN-1",
  payloadDigest: objectDigest(payload),
  evidenceDigest: fingerprint("evidence"),
  sourceDigest: fingerprint("source"),
  scope: ["one-test-only"],
  tenant: "synthetic-tenant",
  projectKey: "SYN",
  operationId: "create-1",
};
function authority(
  patch: Record<string, unknown> = {},
): TrustedApprovalAuthority {
  const consumed = new Set<string>();
  return {
    async consume(reference) {
      if (consumed.has(reference)) throw new Error("already consumed");
      consumed.add(reference);
      return {
        schemaVersion: "1.0.0",
        approvalId: reference,
        consumptionId: "mock-consumption-1",
        authorityId: "TEST-ONLY",
        humanReference: "MOCK-HUMAN",
        decision: "approved",
        issuedAt: new Date(instant - 1000).toISOString(),
        expiresAt: new Date(instant + 60000).toISOString(),
        consumedAt: new Date(instant).toISOString(),
        request,
        requestDigest: objectDigest(request),
        ...patch,
      };
    },
  };
}
test("default authority denies; editable receipt objects and legacy external approvals do not authorize", async () => {
  await assert.rejects(
    new TrustedApprovalGate().consume("a", request, payload),
    /denied or consumption uncertain/,
  );
  await assert.rejects(
    new TrustedApprovalGate({
      decision: "approved",
    } as unknown as TrustedApprovalAuthority).consume("a", request, payload),
    /denied or consumption uncertain/,
  );
  await assert.rejects(
    requireApproval(
      {
        async verify() {
          throw new Error("must not reach");
        },
      },
      "a",
      {
        schemaVersion: request.schemaVersion,
        operation: request.operation,
        target: request.target,
        payloadDigest: request.payloadDigest,
        evidenceDigest: request.evidenceDigest,
        scope: request.scope,
      },
    ),
    /External operations/,
  );
});
test("valid mock consumption is auditable and cannot replay, including through another gate", async () => {
  const host = authority();
  const gate = new TrustedApprovalGate(host, () => instant);
  const receipt = await gate.consume("a", request, payload);
  assert.equal(receipt.consumptionId, "mock-consumption-1");
  await assert.rejects(gate.consume("a", request, payload), /replay/);
  await assert.rejects(
    new TrustedApprovalGate(host, () => instant).consume("a", request, payload),
    /denied or consumption uncertain/,
  );
});
for (const field of [
  "tenant",
  "projectKey",
  "operationId",
  "sourceDigest",
  "evidenceDigest",
  "target",
  "scope",
  "operation",
] as const) {
  test(`trusted approval rejects altered ${field}`, async () => {
    const changed = {
      ...request,
      [field]:
        field === "scope"
          ? ["another-scope"]
          : field === "operation"
            ? "jira.test.link"
            : field === "sourceDigest" || field === "evidenceDigest"
              ? fingerprint("changed")
              : field === "projectKey"
                ? "OTHER"
                : "other-value",
    } as TrustedApprovalRequest;
    await assert.rejects(
      new TrustedApprovalGate(authority(), () => instant).consume(
        "a",
        changed,
        payload,
      ),
      /binding mismatch/,
    );
  });
}
test("missing, expired, future, changed-payload and concurrent approvals fail closed", async () => {
  await assert.rejects(
    new TrustedApprovalGate(authority(), () => instant).consume(
      "",
      request,
      payload,
    ),
    /Missing/,
  );
  await assert.rejects(
    new TrustedApprovalGate(
      authority({ expiresAt: new Date(instant - 1).toISOString() }),
      () => instant,
    ).consume("a", request, payload),
    /expired/,
  );
  await assert.rejects(
    new TrustedApprovalGate(
      authority({ issuedAt: new Date(instant + 1).toISOString() }),
      () => instant,
    ).consume("a", request, payload),
    /expired/,
  );
  await assert.rejects(
    new TrustedApprovalGate(authority(), () => instant).consume("a", request, {
      changed: true,
    }),
    /payload digest/,
  );
  const gate = new TrustedApprovalGate(authority(), () => instant);
  const attempts = await Promise.allSettled([
    gate.consume("a", request, payload),
    gate.consume("a", request, payload),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
});

function entry(id = "create-1") {
  return {
    schemaVersion: "1.0.0" as const,
    operationId: id,
    storyKey: "SYN-1",
    operation: "xray.test.create" as const,
    payloadDigest: objectDigest(payload),
    tenant: "synthetic-tenant",
    projectKey: "SYN",
    automationIdentity: "repo:playwright:synthetic-behavior-v1",
    sourceDigest: fingerprint("source"),
    evidenceDigest: fingerprint("evidence"),
    remoteIds: [] as string[],
    at: new Date().toISOString(),
  };
}
async function attempted(journal: OperationJournal, data = entry()) {
  await journal.record({ ...data, status: "Planned" });
  await journal.record({ ...data, status: "Awaiting approval" });
  const approved = {
    ...data,
    approvalReference: "mock-approval",
    approvalConsumptionId: "mock-consumption",
  };
  await journal.record({ ...approved, status: "Approved" });
  await journal.record({ ...approved, status: "Attempted" });
  return approved;
}
test("journal blocks duplicate identities and duplicate payloads even across Stories", async (t) => {
  const { root } = await fixture(t);
  const journal = new OperationJournal(root);
  await journal.record({ ...entry(), status: "Planned" });
  await assert.rejects(
    journal.record({
      ...entry("create-2"),
      storyKey: "SYN-2",
      payloadDigest: fingerprint("different"),
      status: "Planned",
    }),
    /Existing creation identity/,
  );
  await assert.rejects(
    journal.record({
      ...entry("create-3"),
      automationIdentity: "repo:playwright:another",
      status: "Planned",
    }),
    /Duplicate operation/,
  );
  assert.equal(
    (
      await journal.findCreation(
        "synthetic-tenant",
        "SYN",
        entry().automationIdentity,
      )
    ).length,
    1,
  );
});
test("uncertain creation cannot retry; absent reconciliation allows only a new reviewed plan", async (t) => {
  const { root } = await fixture(t);
  const journal = new OperationJournal(root);
  const data = await attempted(journal);
  await journal.record({
    ...data,
    status: "Uncertain",
    errorCode: "TIMEOUT",
    reconciliation: "pending",
  });
  await assert.rejects(
    journal.record({ ...data, status: "Attempted" }),
    /Unsafe/,
  );
  await assert.rejects(
    journal.record({
      ...entry("retry-1"),
      retryOf: "create-1",
      status: "Planned",
    }),
    /Retry requires/,
  );
  await assert.rejects(
    journal.record({ ...data, status: "Reconciled", reconciliation: "absent" }),
    /evidence digest/,
  );
  await journal.record({
    ...data,
    status: "Reconciled",
    reconciliation: "absent",
    reconciliationEvidenceDigest: fingerprint("mock read-back absent"),
  });
  await journal.record({
    ...entry("retry-1"),
    retryOf: "create-1",
    status: "Planned",
  });
  assert.equal(
    (await journal.entries("retry-1")).at(-1)?.approvalReference,
    undefined,
  );
});
test("confirmed Test creation survives failed linking and cannot create a second Test", async (t) => {
  const { root } = await fixture(t);
  const journal = new OperationJournal(root);
  const data = await attempted(journal);
  await journal.record({ ...data, status: "Confirmed", remoteIds: ["51"] });
  await assert.rejects(
    journal.record({ ...data, status: "Attempted" }),
    /Unsafe/,
  );
  await assert.rejects(
    journal.record({
      ...entry("create-again"),
      retryOf: "create-1",
      status: "Planned",
    }),
    /Retry requires/,
  );
  const link = {
    ...entry("link-1"),
    operation: "jira.test.link" as const,
    payloadDigest: fingerprint("link payload"),
  };
  await journal.record({ ...link, status: "Planned" });
  await journal.record({ ...link, status: "Awaiting approval" });
  await assert.rejects(
    journal.record({
      ...link,
      status: "Approved",
      approvalReference: "creation-approval",
    }),
    /consumption/,
  );
  const linkApproved = {
    ...link,
    approvalReference: "separate-link-mock",
    approvalConsumptionId: "link-consumption",
  };
  await journal.record({ ...linkApproved, status: "Approved" });
  await journal.record({ ...linkApproved, status: "Attempted" });
  await journal.record({
    ...linkApproved,
    status: "Failed",
    errorCode: "DENIED",
  });
  assert.deepEqual((await journal.entries("create-1")).at(-1)?.remoteIds, [
    "51",
  ]);
  await assert.rejects(
    journal.record({ ...entry("new-id"), status: "Planned" }),
    /Duplicate|Existing/,
  );
});
test("journal refuses conflicting confirmed IDs, changed contexts and competing writers", async (t) => {
  const { root } = await fixture(t);
  const journal = new OperationJournal(root);
  const data = await attempted(journal);
  await assert.rejects(
    journal.record({ ...data, status: "Confirmed", remoteIds: ["51", "52"] }),
    /Conflicting/,
  );
  await assert.rejects(
    journal.record({
      ...data,
      status: "Confirmed",
      remoteIds: ["51"],
      tenant: "another-tenant",
    }),
    /Immutable/,
  );
  const competing = await Promise.allSettled([
    journal.record({ ...data, status: "Confirmed", remoteIds: ["51"] }),
    journal.record({ ...data, status: "Confirmed", remoteIds: ["51"] }),
  ]);
  assert.equal(
    competing.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.deepEqual((await journal.entries("create-1")).at(-1)?.remoteIds, [
    "51",
  ]);
});

test("approval consumption rehashes actual source/evidence and validates the complete proposal first", async (t) => {
  const { root, identity, sourcePath } = await fixture(t);
  const preview = await genericProposalPreview(
    root,
    "SYN-1",
    "SYN",
    identity,
    "Synthetic",
    mockCreation,
  );
  if (preview.status !== "READY_LOCALLY") assert.fail();
  const boundRequest = {
    ...request,
    payloadDigest: preview.proposal.payloadDigest,
    sourceDigest: preview.sourceDigest,
    evidenceDigest: preview.evidenceDigest,
  };
  const host = authority({
    request: boundRequest,
    requestDigest: objectDigest(boundRequest),
  });
  const receipt = await consumeGenericProposalApproval(
    root,
    identity,
    preview.proposal,
    boundRequest,
    "a",
    new TrustedApprovalGate(host, () => instant),
  );
  assert.equal(receipt.request.operation, "xray.test.create");
  await assert.rejects(
    consumeGenericProposalApproval(
      root,
      identity,
      { ...preview.proposal, target: "SYN-2" },
      { ...boundRequest, target: "SYN-2" },
      "b",
      new TrustedApprovalGate(host, () => instant),
    ),
    /binding mismatch/,
  );
  await writeFile(sourcePath, "changed after proposal");
  await assert.rejects(
    consumeGenericProposalApproval(
      root,
      identity,
      preview.proposal,
      boundRequest,
      "b",
      new TrustedApprovalGate(host, () => instant),
    ),
    /Stale source/,
  );
});

test("registered identity verifies its separate, immutable synthetic source and report", async () => {
  const root = await createDemoEvidenceFixture();
  const registry = await IdentityRegistry.load(root, registryFile);
  const identity = registry
    .list()
    .find(
      (entry) => entry.automationId === "task-create-inflight-single-submit-v1",
    );
  assert.ok(identity);
  assert.equal(
    identityKey(identity),
    "agentic-demo-website:playwright:task-create-inflight-single-submit-v1",
  );
  assert.equal(identity.binding!.runnerIds[0], "synthetic-playwright-case-22");
  assert.equal(identity.binding!.historicalExecutions.length, 1);
  await verifyBinding(root, identity);
});

test("consumption audit identifiers cannot be recycled for another approved operation", async () => {
  const host: TrustedApprovalAuthority = {
    async consume(reference, bound, requestDigest) {
      return {
        schemaVersion: "1.0.0",
        approvalId: reference,
        consumptionId: "same-consumption-id",
        authorityId: "MOCK",
        humanReference: "MOCK-HUMAN",
        decision: "approved",
        issuedAt: new Date(instant - 1).toISOString(),
        expiresAt: new Date(instant + 60000).toISOString(),
        consumedAt: new Date(instant).toISOString(),
        request: bound,
        requestDigest,
      };
    },
  };
  const gate = new TrustedApprovalGate(host, () => instant);
  await gate.consume("first", request, payload);
  await assert.rejects(
    gate.consume("second", { ...request, operationId: "create-2" }, payload),
    /audit ID replay/,
  );
});

test("a Story link needs its own exact grant; a creation grant cannot authorize it", async () => {
  const link = linkProposal(
    "SYN-1",
    "SYN-51",
    { id: "37", name: "Test", inward: "is tested by", outward: "tests" },
    request.evidenceDigest,
  );
  const linkRequest: TrustedApprovalRequest = {
    ...request,
    operation: "jira.test.link",
    operationId: "link-1",
    payloadDigest: link.payloadDigest,
    scope: ["one-story-link-only"],
  };
  await assert.rejects(
    new TrustedApprovalGate(authority(), () => instant).consume(
      "create-grant",
      linkRequest,
      link.payload,
    ),
    /binding mismatch/,
  );
  const linkHost = authority({
    request: linkRequest,
    requestDigest: objectDigest(linkRequest),
    consumptionId: "mock-link-consumption",
  });
  const receipt = await new TrustedApprovalGate(
    linkHost,
    () => instant,
  ).consume("link-grant", linkRequest, link.payload);
  assert.equal(receipt.request.operation, "jira.test.link");
  assert.equal(receipt.approvalId, "link-grant");
});
