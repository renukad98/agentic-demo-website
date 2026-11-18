import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../../tools/agentic/artifacts.js";
import {
  type Identity,
  type Result,
} from "../../tools/agentic/contracts/index.js";
import { IdentityRegistry, identityKey } from "../../tools/xray/identity.js";
import {
  normalizeNodeXml,
  normalizePlaywrightJson,
} from "../../tools/xray/normalizers/index.js";
import {
  genericProposal,
  duplicateDecision,
  linkProposal,
  executionProposal,
  importProposal,
} from "../../tools/xray/planner.js";
import { Publisher } from "../../tools/xray/publisher.js";
import {
  DisabledWriteTransport,
  XrayReadClient,
} from "../../tools/xray/clients/index.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import { boundFixture, mockCreation } from "./publication-fixtures.js";
import {
  syntheticBrowserReport,
  syntheticNodeReport,
} from "./support/local-demo-evidence.js";
import {
  verifyCoverage,
  verifyJiraLink,
  verifyResults,
} from "../../tools/xray/verification.js";

const digest = fingerprint("synthetic");
const identity: Identity = {
  schemaVersion: "1.0.0",
  repository: "demo",
  runner: "node",
  automationId: "shared-regression",
  sourceLocation: "tests/synthetic.test.ts",
  behaviorDigest: digest,
  sourceDigest: digest,
  associations: [
    {
      storyKey: "SYN-1",
      scenarioIds: ["C1"],
      requirementIds: ["R1"],
      acceptanceIds: ["A1"],
    },
  ],
  xray: {
    key: "SYN-51",
    issueId: "51",
    verifiedAt: "2026-11-15T00:00:00Z",
    behaviorDigest: digest,
  },
};
const result: Result = {
  identity: identityKey(identity),
  runner: "node",
  outcome: "passed",
  attempt: 0,
  failures: [],
  evidence: ["synthetic.xml"],
  artifactDigest: digest,
};
test("registry deduplicates shared identity across Stories, persists and rejects behavior conflicts", async (t) => {
  const registry = new IdentityRegistry();
  registry.register(identity);
  registry.register({
    ...identity,
    associations: [{ ...identity.associations[0]!, storyKey: "SYN-2" }],
  });
  registry.register(identity);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]!.associations.length, 2);
  assert.throws(
    () =>
      registry.register({
        ...identity,
        behaviorDigest: fingerprint("changed"),
      }),
    /behavior/,
  );
  const root = await mkdtemp(join(tmpdir(), "registry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await registry.save(root, "one");
  assert.equal(
    (await IdentityRegistry.load(root, "registry-one.json")).list().length,
    1,
  );
  await assert.rejects(registry.save(root, "one"), /EEXIST/);
});
test("Node XML preserves failure/skip/duration and absent timestamps without inventing metadata", () => {
  const xml =
    '<testsuites><testcase name="pass" file="a"/><testcase name="fail" time="0.25"><failure message="bad">details</failure></testcase><testcase name="skip"><skipped message="why"/></testcase></testsuites>';
  const results = normalizeNodeXml(
    xml,
    "raw.xml",
    (_r, _f, title) => `stable:${title}`,
  );
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["passed", "failed", "skipped"],
  );
  assert.equal(results[0]!.durationMs, undefined);
  assert.equal(results[0]!.startedAt, undefined);
  assert.equal(results[1]!.durationMs, 250);
  assert.match(results[1]!.failures[0]!, /bad/);
  assert.equal(results[2]!.skipReason, "why");
});
test("Node XML rejects unmapped cases, malformed XML, entities and invalid durations", () => {
  assert.throws(
    () =>
      normalizeNodeXml(
        '<testsuite><testcase name="a"/></testsuite>',
        "x",
        () => undefined,
      ),
    /Unmapped/,
  );
  assert.throws(() => normalizeNodeXml("<testsuite>", "x", () => "id"));
  assert.throws(
    () => normalizeNodeXml("<!DOCTYPE foo><testsuite/>", "x", () => "id"),
    /forbidden/,
  );
  assert.throws(
    () =>
      normalizeNodeXml(
        '<testsuite><testcase name="a" time="bad"/></testsuite>',
        "x",
        () => "id",
      ),
    /duration/,
  );
});

test("JUnit testcase timestamps are retained and unsupported retry extensions block normalization", () => {
  const normalized = normalizeNodeXml(
    '<testsuite><testcase name="a" timestamp="2026-11-15T00:00:00Z"/></testsuite>',
    "x",
    () => "stable",
  );
  assert.equal(normalized[0]!.startedAt, "2026-11-15T00:00:00.000Z");
  assert.throws(
    () =>
      normalizeNodeXml(
        '<testsuite><testcase name="a"><flakyFailure>first failure</flakyFailure></testcase></testsuite>',
        "x",
        () => "stable",
      ),
    /retry extension/,
  );
});
function browser(results: unknown[]) {
  return JSON.stringify({
    suites: [
      {
        title: "file",
        specs: [
          {
            title: "case",
            file: "test.spec.ts",
            tests: [{ projectName: "chromium", results }],
          },
        ],
      },
    ],
  });
}
test("Playwright preserves retry failure then pass, timing and attachment references", () => {
  const normalized = normalizePlaywrightJson(
    browser([
      {
        status: "failed",
        retry: 0,
        duration: 5,
        errors: [{ message: "first failure" }],
      },
      {
        status: "passed",
        retry: 1,
        startTime: "2026-11-15T00:00:00Z",
        duration: 8,
        attachments: [{ path: "trace.zip" }],
      },
    ]),
    "browser.json",
    () => "stable",
  );
  assert.deepEqual(
    normalized.map((r) => r.outcome),
    ["failed", "passed"],
  );
  assert.deepEqual(
    normalized.map((r) => r.attempt),
    [0, 1],
  );
  assert.equal(normalized[1]!.evidence[1], "trace.zip");
});
test("Playwright missing/unknown metadata stays unknown or blocks rather than passing", () => {
  const normalized = normalizePlaywrightJson(
    browser([{ status: "unexpected-state" }]),
    "x",
    () => "stable",
  );
  assert.equal(normalized[0]!.outcome, "unknown");
  assert.equal(normalized[0]!.durationMs, undefined);
  assert.throws(
    () => normalizePlaywrightJson(browser([]), "x", () => "stable"),
    /No Playwright execution/,
  );
  assert.throws(
    () =>
      normalizePlaywrightJson(
        browser([{ status: "passed" }]),
        "x",
        () => undefined,
      ),
    /Unmapped/,
  );
});
test("Generic proposal uses stable identity and arbitrary selected Story", () => {
  const proposal = genericProposal(
    "SYN-1",
    "SYN",
    boundFixture(identity),
    "Synthetic automated Test",
    mockCreation,
  );
  const variables = proposal.payload.variables as {
    testType: { name: string };
    unstructured: string;
  };
  assert.equal(variables.testType.name, "Generic");
  assert.equal(variables.unstructured, identityKey(identity));
  assert.equal(proposal.remoteWritesEnabled, false);
  assert.throws(
    () =>
      genericProposal(
        "OTHER-9",
        "OTHER",
        boundFixture(identity),
        "wrong Story",
        mockCreation,
      ),
    /associated/,
  );
});
test("duplicate detection requires complete search, exact identity and behavior", () => {
  assert.equal(duplicateDecision(identity, [], true).disposition, "new");
  const candidate = {
    key: "SYN-51",
    issueId: "51",
    identity: identityKey(identity),
    behaviorDigest: digest,
    type: "Generic",
  };
  assert.equal(
    duplicateDecision(identity, [candidate], true).disposition,
    "reuse",
  );
  assert.throws(() => duplicateDecision(identity, [], false), /Incomplete/);
  assert.throws(
    () => duplicateDecision(identity, [candidate, candidate], true),
    /Ambiguous/,
  );
  assert.throws(
    () => duplicateDecision(identity, [{ ...candidate, type: "Manual" }], true),
    /Ambiguous/,
  );
});
test("link proposals and independent Jira/Xray read-back detect missing associations", () => {
  const proposal = linkProposal(
    "SYN-1",
    "SYN-51",
    { id: "37", name: "Test", inward: "is tested by", outward: "tests" },
    digest,
  );
  assert.deepEqual(proposal.payload.inwardIssue, { key: "SYN-51" });
  assert.equal(
    verifyCoverage("1", [{ start: 0, total: 1, results: [{ issueId: "1" }] }]),
    true,
  );
  assert.throws(
    () =>
      verifyCoverage("1", [
        { start: 0, total: 2, results: [{ issueId: "1" }] },
      ]),
    /Incomplete/,
  );
  assert.throws(
    () =>
      verifyCoverage("2", [
        { start: 0, total: 1, results: [{ issueId: "1" }] },
      ]),
    /missing/,
  );
  assert.equal(
    verifyJiraLink(
      "SYN-1",
      "SYN-51",
      [{ storyKey: "SYN-1", testKey: "SYN-51", typeId: "37" }],
      "37",
    ),
    true,
  );
  assert.throws(() => verifyJiraLink("SYN-1", "SYN-51", [], "37"), /missing/);
});
test("execution and result proposals require verified explicit Test keys and preserve automation", () => {
  assert.equal(
    executionProposal("SYN-1", "SYN", [identity], "node", digest).operation,
    "xray.execution.create",
  );
  const proposal = importProposal(
    "SYN-1",
    "SYN-90",
    [result],
    [identity],
    digest,
  );
  const body = proposal.payload.body as {
    testExecutionKey: string;
    tests: { testKey: string; status: string; start?: string }[];
  };
  assert.equal(body.testExecutionKey, "SYN-90");
  assert.equal(body.tests[0]!.testKey, "SYN-51");
  assert.equal(body.tests[0]!.status, "PASSED");
  assert.equal(body.tests[0]!.start, undefined);
  assert.throws(
    () =>
      importProposal(
        "SYN-1",
        "SYN-90",
        [result, { ...result, attempt: 1 }],
        [identity],
        digest,
      ),
    /attempts/,
  );
  assert.throws(
    () =>
      importProposal(
        "SYN-1",
        "SYN-90",
        [{ ...result, outcome: "unknown" }],
        [identity],
        digest,
      ),
    /Unknown/,
  );
  assert.throws(
    () =>
      executionProposal(
        "SYN-1",
        "SYN",
        [{ ...identity, xray: undefined }],
        "node",
        digest,
      ),
    /verified/,
  );
});
test("mocked read transport supports read-back; publisher and transport always reject writes", async () => {
  const calls: string[] = [];
  const client = new XrayReadClient({
    async request(query) {
      calls.push(query);
      return query.includes("ReadTest(")
        ? {
            data: {
              getTest: {
                issueId: "51",
                testType: { name: "Generic" },
                jira: { key: "SYN-51" },
              },
            },
          }
        : {
            data: {
              getTestRuns: { total: 0, start: 0, limit: 100, results: [] },
            },
          };
    },
  });
  await client.getTest("51");
  await client.getRuns("90");
  assert.equal(calls.length, 2);
  await assert.rejects(
    new Publisher().publish(
      genericProposal(
        "SYN-1",
        "SYN",
        boundFixture(identity),
        "Test",
        mockCreation,
      ),
    ),
    /disabled/,
  );
  await assert.rejects(
    new DisabledWriteTransport().write("create", {}),
    /disabled/,
  );
});
test("journal preserves partial confirmations and uncertain mock timeout, blocks retry until reconciliation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "journal-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new OperationJournal(root);
  const entry = {
    schemaVersion: "1.0.0" as const,
    operationId: "op-1",
    storyKey: "SYN-1",
    operation: "xray.test.create" as const,
    payloadDigest: digest,
    remoteIds: [] as string[],
    at: new Date().toISOString(),
    tenant: "mock-tenant",
    projectKey: "SYN",
    sourceDigest: digest,
    evidenceDigest: digest,
    automationIdentity: identityKey(identity),
    approvalConsumptionId: "mock-consumption",
  };
  await journal.record({ ...entry, status: "Planned" });
  await journal.record({ ...entry, status: "Awaiting approval" });
  await journal.record({
    ...entry,
    status: "Approved",
    approvalReference: "mock",
  });
  await journal.record({
    ...entry,
    status: "Attempted",
    approvalReference: "mock",
  });
  const mockWrite = async () => {
    throw new Error("Synthetic timeout");
  };
  await assert.rejects(mockWrite(), /timeout/);
  await journal.record({
    ...entry,
    status: "Uncertain",
    approvalReference: "mock",
    errorCode: "TIMEOUT",
    reconciliation: "pending",
  });
  await assert.rejects(journal.assertNoUncertainOperations(), /blocked/);
  await assert.rejects(
    journal.record({
      ...entry,
      status: "Attempted",
      approvalReference: "mock",
    }),
    /Unsafe/,
  );
  const mockReadBack = async () => ({ issueId: "51" });
  await journal.record({
    ...entry,
    status: "Reconciled",
    approvalReference: "mock",
    remoteIds: [(await mockReadBack()).issueId],
    reconciliation: "confirmed",
    reconciliationEvidenceDigest: digest,
  });
  await journal.assertNoUncertainOperations();
  await assert.rejects(
    journal.record({
      ...entry,
      payloadDigest: fingerprint("changed"),
      status: "Planned",
    }),
    /Changed/,
  );
  const confirmed = {
    ...entry,
    operationId: "op-2",
    payloadDigest: fingerprint("different-proposal"),
    automationIdentity: "demo:node:another-regression",
    approvalReference: "mock",
    remoteIds: [] as string[],
  };
  for (const status of [
    "Planned",
    "Awaiting approval",
    "Approved",
    "Attempted",
  ] as const)
    await journal.record({ ...confirmed, status });
  await journal.record({
    ...confirmed,
    status: "Confirmed",
    remoteIds: ["52"],
  });
  const history = await journal.entries("op-2");
  assert.deepEqual(history.at(-1)!.remoteIds, ["52"]);
});
test("result read-back requires exact execution, complete counts and statuses", () => {
  assert.equal(
    verifyResults(
      [{ testIssueId: "51", status: "PASSED" }],
      [{ testIssueId: "51", status: "PASSED", executionIssueId: "90" }],
      "90",
      true,
    ),
    true,
  );
  assert.throws(
    () =>
      verifyResults([{ testIssueId: "51", status: "PASSED" }], [], "90", true),
    /Incomplete/,
  );
  assert.throws(
    () =>
      verifyResults(
        [{ testIssueId: "51", status: "PASSED" }],
        [{ testIssueId: "51", status: "FAILED", executionIssueId: "90" }],
        "90",
        true,
      ),
    /mismatch/,
  );
});
test("synthetic Node and Playwright reports normalize without execution", () => {
  const node = normalizeNodeXml(
    syntheticNodeReport,
    "node-results.xml",
    (_runner, file, title) => `${file}:${title}`,
  );
  const browserResults = normalizePlaywrightJson(
    syntheticBrowserReport,
    "playwright-results.json",
    (_runner, file, title) => `${file}:${title}`,
  );
  assert.equal(node.length, 1);
  assert.equal(browserResults.length, 1);
  assert.equal(
    [...node, ...browserResults].every((r) => r.outcome === "passed"),
    true,
  );
});
