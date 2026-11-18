import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workflow } from "../../tools/agentic/workflow.js";
import {
  fingerprint,
  objectDigest,
  writeExclusive,
} from "../../tools/agentic/artifacts.js";
import {
  inputSchema,
  stages,
  type WorkflowInput,
} from "../../tools/agentic/contracts/index.js";
import {
  requireApproval,
  denyAllApprovals,
  type ApprovalProvider,
} from "../../tools/agentic/approvals.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temp = await mkdtemp(join(tmpdir(), "agentic-framework-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "agentic-demo-website");
  await mkdir(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "agentic-demo-website" }),
  );
  await writeFile(join(root, "source.ts"), "synthetic source");
  await writeFile(join(root, "unit.test.ts"), "synthetic unit test");
  await writeFile(join(root, "ui.spec.ts"), "synthetic browser test");
  const sourceFiles = { "source.ts": fingerprint("synthetic source") };
  const input: WorkflowInput = {
    schemaVersion: "1.0.0",
    storyKey: "SYN-101",
    repository: { root, namespace: "demo" },
    jira: { site: "https://example.atlassian.net", context: "mock" },
    mode: "plan",
    approvedScopeReference: "synthetic-only",
    sourceDigest: objectDigest(sourceFiles),
    sourceFiles,
    environment: { name: "temporary", isolated: true },
    requiredQualityGates: ["lint"],
    xray: {
      projectKey: "SYN",
      apiBase: "https://xray.cloud.getxray.app",
      executionGrouping: "runner",
    },
    approvalReferences: [],
  };
  return { root, input };
}
const provider: ApprovalProvider = {
  async verify(id, request) {
    return {
      ...request,
      id,
      decision: "approved",
      humanReference: "MOCK-ONLY",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  },
};
async function analyzed(workflow: Workflow, input: WorkflowInput) {
  await writeExclusive(workflow.path, "design/test-cases.md", {
    text: "Synthetic reviewed design",
  });
  await workflow.attach("source", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    issueId: "101",
    retrievedAt: new Date().toISOString(),
    contentDigest: fingerprint("story"),
    summary: "Synthetic",
    description: "Synthetic only",
  });
  await workflow.attach("requirements", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    sourceDigest: input.sourceDigest,
    requirements: [{ id: "R1", text: "Behavior", acceptanceIds: ["A1"] }],
    acceptanceCriteria: [{ id: "A1", text: "Observable" }],
    unresolvedQuestions: [],
  });
  await workflow.advance(
    "ANALYZED",
    "requirements-analysis-agent",
    input.sourceDigest,
  );
  await workflow.attach("scenarios", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    scenarios: [
      {
        id: "C1",
        requirementIds: ["R1"],
        acceptanceIds: ["A1"],
        kind: "automated",
        preconditions: ["Temporary data"],
        actions: ["Act"],
        expected: "Result",
      },
    ],
    review: "accepted",
  });
  await workflow.attach("review", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    sourceDigest: input.sourceDigest,
    accepted: true,
    evidencePaths: ["design/test-cases.md"],
  });
  await workflow.advance(
    "DESIGN_REVIEWED",
    "test-review-agent",
    input.sourceDigest,
  );
}
test("two Stories and repeated runs have exclusive isolated directories", async (t) => {
  const { input } = await fixture(t);
  const [a, b, c] = await Promise.all([
    Workflow.start(input),
    Workflow.start({ ...input, storyKey: "SYN-202" }),
    Workflow.start(input),
  ]);
  assert.equal(new Set([a.path, b.path, c.path]).size, 3);
  assert.equal(a.state.storyKey, "SYN-101");
  assert.equal(b.state.storyKey, "SYN-202");
  await assert.rejects(writeExclusive(a.path, "manifest.json", {}), /EEXIST/);
  await assert.rejects(
    writeExclusive(a.path, "../../escape.json", {}),
    /outside/,
  );
});
for (const key of [
  "../SYN-1",
  "SYN-1/../../public",
  "syn-1",
  "SYN-0",
  "C:\\escape",
]) {
  test(`invalid Story key rejected: ${key}`, async (t) => {
    const { input } = await fixture(t);
    assert.throws(() => inputSchema.parse({ ...input, storyKey: key }));
  });
}
test("contracts reject incomplete inputs, credential URLs and non-isolated data", async (t) => {
  const { input } = await fixture(t);
  assert.throws(() => inputSchema.parse({ storyKey: "SYN-1" }));
  assert.throws(() =>
    inputSchema.parse({
      ...input,
      jira: { site: "https://user:secret@example.com", context: "mock" },
    }),
  );
  assert.throws(() =>
    inputSchema.parse({
      ...input,
      environment: { name: "live", isolated: false },
    }),
  );
});
test("state cannot skip stages or missing evidence", async (t) => {
  const { input } = await fixture(t);
  const workflow = await Workflow.start(input);
  await assert.rejects(
    workflow.advance(
      "IMPLEMENTED",
      "feature-development-agent",
      input.sourceDigest,
    ),
    /transition/,
  );
  await assert.rejects(
    workflow.advance(
      "ANALYZED",
      "requirements-analysis-agent",
      input.sourceDigest,
    ),
    /Missing source/,
  );
  await assert.rejects(workflow.attach("source", { storyKey: "OTHER-1" }));
});
test("role handoff, suspend, resume and source freshness are enforced", async (t) => {
  const { input, root } = await fixture(t);
  const workflow = await Workflow.start(input);
  await analyzed(workflow, input);
  assert.equal(workflow.state.handoffs.length, 2);
  await workflow.suspend("BLOCKED", "Synthetic missing dependency");
  const resumed = await Workflow.resume({
    ...input,
    previousRunId: workflow.state.runId,
  });
  assert.equal(resumed.state.stage, "DESIGN_REVIEWED");
  assert.equal(resumed.state.status, "BLOCKED");
  await resumed.reactivate(input.sourceDigest);
  await writeFile(join(root, "source.ts"), "changed by another Story");
  await assert.rejects(resumed.assertFresh(input.sourceDigest), /Stale/);
  await assert.rejects(
    Workflow.resume({ ...input, previousRunId: workflow.state.runId }),
    /Stale/,
  );
});
test("changed resume inputs and tampered evidence are rejected", async (t) => {
  const { input } = await fixture(t);
  const workflow = await Workflow.start(input);
  await analyzed(workflow, input);
  await assert.rejects(
    Workflow.resume({
      ...input,
      mode: "publish",
      previousRunId: workflow.state.runId,
    }),
    /changed/,
  );
  const ref = workflow.state.evidence.requirements!;
  await writeFile(join(workflow.path, ref.path), "{}");
  await assert.rejects(workflow.assertFresh(input.sourceDigest), /fingerprint/);
});
test("default approval denial cannot be bypassed by mode or local approval JSON", async (t) => {
  const { input } = await fixture(t);
  const workflow = await Workflow.start({ ...input, mode: "implement" });
  await analyzed(workflow, input);
  await writeExclusive(workflow.path, "approvals/local.json", {
    decision: "approved",
  });
  await assert.rejects(
    workflow.advance(
      "IMPLEMENTATION_AUTHORIZED",
      "qa-orchestrator",
      input.sourceDigest,
      "local",
    ),
    /Trusted approval/,
  );
});
const request = {
  schemaVersion: "1.0.0" as const,
  operation: "feature.implement" as const,
  target: "SYN-1",
  payloadDigest: fingerprint("payload"),
  evidenceDigest: fingerprint("source"),
  scope: ["synthetic"],
};
test("approval provider rejects missing reference, unavailable provider, expiry and changed payload", async () => {
  await assert.rejects(requireApproval(provider, "", request), /Missing/);
  await assert.rejects(
    requireApproval(denyAllApprovals, "a", request),
    /unavailable/,
  );
  const expired: ApprovalProvider = {
    async verify(id, r) {
      return {
        ...((await provider.verify(id, r)) as object),
        expiresAt: "2000-01-01T00:00:00Z",
      };
    },
  };
  await assert.rejects(requireApproval(expired, "a", request), /Expired/);
  const changed: ApprovalProvider = {
    async verify(id, r) {
      return {
        ...((await provider.verify(id, r)) as object),
        payloadDigest: fingerprint("different"),
      };
    },
  };
  await assert.rejects(requireApproval(changed, "a", request), /payloadDigest/);
  assert.equal((await requireApproval(provider, "a", request)).id, "a");
});
test("mock-approved local workflow reaches local-ready but remote completion stays disabled", async (t) => {
  const { input } = await fixture(t);
  const workflow = await Workflow.start(input, provider);
  await analyzed(workflow, input);
  await workflow.advance(
    "IMPLEMENTATION_AUTHORIZED",
    "qa-orchestrator",
    input.sourceDigest,
    "mock",
  );
  await workflow.attach("implementation", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    sourceDigest: input.sourceDigest,
    accepted: true,
    evidencePaths: ["manifest.json"],
    implementationFiles: ["source.ts"],
    automatedTestFiles: ["unit.test.ts"],
    browserTestFiles: ["ui.spec.ts"],
  });
  await workflow.attach("inventory", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    identities: [
      {
        schemaVersion: "1.0.0",
        repository: "demo",
        runner: "node",
        automationId: "stable-1",
        sourceLocation: "unit.test.ts",
        behaviorDigest: fingerprint("behavior"),
        sourceDigest: input.sourceDigest,
        associations: [
          {
            storyKey: input.storyKey,
            scenarioIds: ["C1"],
            requirementIds: ["R1"],
            acceptanceIds: ["A1"],
          },
        ],
      },
    ],
  });
  await workflow.advance(
    "IMPLEMENTED",
    "feature-development-agent",
    input.sourceDigest,
  );
  await workflow.attach("traceability", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    rows: [
      {
        requirementId: "R1",
        acceptanceId: "A1",
        scenarioId: "C1",
        automationIdentity: "demo:node:stable-1",
      },
    ],
  });
  await workflow.advance(
    "AUTOMATION_REVIEWED",
    "test-review-agent",
    input.sourceDigest,
  );
  const raw = await workflow.captureEvidence("raw synthetic runner output");
  const log = await workflow.captureEvidence(
    "mock lint exit code zero after fix",
  );
  const execution = {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    executionId: "run-1",
    sourceDigest: input.sourceDigest,
    results: [
      {
        identity: "demo:node:stable-1",
        runner: "node",
        outcome: "passed",
        attempt: 0,
        failures: [],
        evidence: [raw.path],
        artifactDigest: raw.digest,
      },
    ],
    gates: [
      { name: "lint", exitCode: 1, command: "mock lint", evidence: log.path },
    ],
  };
  await workflow.attach("execution", execution);
  await assert.rejects(
    workflow.advance(
      "VALIDATED",
      "test-execution-reporting-agent",
      input.sourceDigest,
    ),
    /gate/,
  );
  await workflow.attach("execution", {
    ...execution,
    executionId: "run-2",
    gates: [{ ...execution.gates[0], exitCode: 0 }],
  });
  await workflow.advance(
    "VALIDATED",
    "test-execution-reporting-agent",
    input.sourceDigest,
  );
  await workflow.advance("LOCAL_READY", "qa-orchestrator", input.sourceDigest);
  await workflow.attach("proposal", {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    operation: "xray.test.create",
    target: input.storyKey,
    payloadDigest: objectDigest({}),
    evidenceDigest: input.sourceDigest,
    payload: {},
    remoteWritesEnabled: false,
  });
  await workflow.advance(
    "XRAY_PROPOSED",
    "xray-test-publisher-agent",
    input.sourceDigest,
  );
  await assert.rejects(
    workflow.advance(
      "TESTS_VERIFIED",
      "xray-test-publisher-agent",
      input.sourceDigest,
    ),
    /disabled/,
  );
  assert.equal(workflow.report().localReady, true);
  assert.equal(stages.length, 15);
  const manifest = JSON.parse(
    await readFile(join(workflow.path, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.remoteWritesEnabled, false);
});
test("artifact secret-field guard and uncertain state stop resume", async (t) => {
  const { input } = await fixture(t);
  const workflow = await Workflow.start(input);
  await assert.rejects(
    writeExclusive(workflow.path, "source/bad.json", {
      accessToken: "synthetic",
    }),
    /Sensitive/,
  );
  await workflow.suspend("UNCERTAIN", "Mock remote timeout");
  await assert.rejects(
    workflow.reactivate(input.sourceDigest),
    /reconciliation/,
  );
});

test("missing review artifact blocks handoff and frozen requirements cannot bypass approval", async (t) => {
  const { input } = await fixture(t);
  const workflow = await Workflow.start(input);
  await analyzed(workflow, input);
  await assert.rejects(workflow.attach("requirements", {}), /frozen/);
  const copy = workflow.state;
  copy.stage = "DELIVERY_VERIFIED";
  assert.equal(workflow.state.stage, "DESIGN_REVIEWED");
  await workflow.suspend("FAILED", "Synthetic review file removed");
  await rm(join(workflow.path, "design/test-cases.md"));
  await assert.rejects(workflow.reactivate(input.sourceDigest), /ENOENT/);
});

test("competing state writers cannot overwrite a previously saved revision", async (t) => {
  const { input } = await fixture(t);
  const original = await Workflow.start(input);
  const stale = await Workflow.resume({
    ...input,
    previousRunId: original.state.runId,
  });
  await original.suspend("BLOCKED", "First writer");
  await assert.rejects(stale.suspend("FAILED", "Stale writer"), /EEXIST/);
  const resumed = await Workflow.resume({
    ...input,
    previousRunId: original.state.runId,
  });
  assert.equal(resumed.state.status, "BLOCKED");
});

test("artifact capture preserves bytes, rejects traversal and cannot conceal source digest changes", async (t) => {
  const { input } = await fixture(t);
  const workflow = await Workflow.start(input);
  const artifact = await workflow.captureEvidence(
    "actual synthetic evidence\n",
  );
  assert.equal(
    fingerprint(await readFile(join(workflow.path, artifact.path))),
    artifact.digest,
  );
  await assert.rejects(
    workflow.assertFresh(fingerprint("different-source")),
    /Stale/,
  );
  await assert.rejects(
    writeExclusive(workflow.path, "../outside.json", {}),
    /outside/,
  );
});
