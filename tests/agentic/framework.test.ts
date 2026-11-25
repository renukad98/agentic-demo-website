import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recommendQaHandoff,
  resolveQaNext,
} from "../../tools/agentic/qa-next.js";
import { validateFinalMappings } from "../../tools/agentic/test-implementation.js";
import { Workflow } from "../../tools/agentic/workflow.js";
import {
  fingerprint,
  objectDigest,
  writeExclusive,
  verifyRepository,
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
  const sourceFiles = {
    "source.ts": fingerprint("synthetic source"),
    "unit.test.ts": fingerprint("synthetic unit test"),
    "ui.spec.ts": fingerprint("synthetic browser test"),
  };
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
async function analyzed(
  workflow: Workflow,
  input: WorkflowInput,
  legacy = false,
  levels = ["unit", "browser"],
  splitCriteria = false,
) {
  const designFileDigest = await writeExclusive(
    workflow.path,
    "design/test-cases.md",
    {
      text: "Synthetic reviewed design",
    },
  );
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
    requirements: [
      { id: "R1", text: "API behavior", acceptanceIds: ["A1"] },
      ...(splitCriteria
        ? [{ id: "R2", text: "Browser behavior", acceptanceIds: ["A2"] }]
        : []),
    ],
    acceptanceCriteria: [
      { id: "A1", text: "Observable" },
      ...(splitCriteria ? [{ id: "A2", text: "Visible outcome" }] : []),
    ],
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
        requirementIds: splitCriteria ? ["R1", "R2"] : ["R1"],
        acceptanceIds: splitCriteria ? ["A1", "A2"] : ["A1"],
        kind: "automated",
        ...(legacy ? {} : { levels }),
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
    ...(legacy
      ? {}
      : {
          reviewDigest: workflow.state.evidence.scenarios?.digest,
          evidenceDigests: { "design/test-cases.md": designFileDigest },
        }),
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
test("historical workflow resumes through the combined gate with remote completion disabled", async (t) => {
  const { input } = await fixture(t);
  const initial = await Workflow.start(input, provider);
  const manifestPath = join(initial.path, "manifest.json");
  const historicalManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete historicalManifest.implementationWorkflow;
  await writeFile(manifestPath, JSON.stringify(historicalManifest));
  const workflow = await Workflow.resume(
    { ...input, previousRunId: initial.state.runId },
    provider,
  );
  await analyzed(workflow, input, true);
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
  assert.equal(stages.length, 17);
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

test("split workflow gates reuse, browser ownership and complete current traceability", async (t) => {
  const { input, root } = await fixture(t);
  const workflow = await Workflow.start(input, provider);
  await analyzed(workflow, input, false, ["api", "browser"], true);
  await workflow.advance(
    "IMPLEMENTATION_AUTHORIZED",
    "qa-orchestrator",
    input.sourceDigest,
    "mock",
  );
  const context = {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    sourceDigest: input.sourceDigest,
    designDigest: workflow.state.evidence.scenarios!.digest,
  };
  await workflow.attach("featureImplementation", {
    ...context,
    implementationFiles: { "source.ts": input.sourceFiles["source.ts"] },
    developerTestFiles: { "unit.test.ts": input.sourceFiles["unit.test.ts"] },
  });
  await workflow.advance(
    "IMPLEMENTED",
    "feature-development-agent",
    input.sourceDigest,
  );
  const unit = {
    caseId: "C1",
    level: "api",
    file: "unit.test.ts",
    title: "checks observable result",
    automationIdentity: "demo:node:existing",
    disposition: "existing",
    covers: [{ requirementId: "R1", acceptanceId: "A1" }],
  } as const;
  const ui = {
    caseId: "C1",
    level: "browser",
    file: "ui.spec.ts",
    title: "shows observable result",
    automationIdentity: "demo:playwright:browser",
    disposition: "added",
    covers: [{ requirementId: "R2", acceptanceId: "A2" }],
  } as const;
  const localProof = {
    ...context,
    files: { "unit.test.ts": input.sourceFiles["unit.test.ts"] },
    mappings: [unit],
    browserCases: ["C1"],
  };
  const local = () =>
    workflow.advance(
      "TESTS_IMPLEMENTED",
      "feature-development-agent",
      input.sourceDigest,
    );
  await assert.rejects(local(), /Missing caseImplementation/);
  await assert.rejects(
    workflow.attach("caseImplementation", {
      ...localProof,
      storyKey: "OTHER-2",
    }),
    /Cross-story/,
  );
  await assert.rejects(
    workflow.attach("caseImplementation", {
      ...localProof,
      designDigest: fingerprint("stale"),
    }),
    /Stale reviewed design/,
  );
  await workflow.attach("caseImplementation", { ...localProof, mappings: [] });
  await assert.rejects(local(), /Missing approved case coverage/);
  await workflow.attach("caseImplementation", {
    ...localProof,
    mappings: [unit, unit],
  });
  await assert.rejects(local(), /Duplicate case mapping/);
  await workflow.attach("caseImplementation", {
    ...localProof,
    browserCases: [],
  });
  await assert.rejects(local(), /Browser handoff/);
  await workflow.attach("caseImplementation", localProof);
  await assert.rejects(
    workflow.advance(
      "TESTS_IMPLEMENTED",
      "test-implementation-agent",
      input.sourceDigest,
    ),
    /Incorrect role/,
  );
  await local();
  const browser = () =>
    workflow.advance(
      "BROWSER_IMPLEMENTED",
      "playwright-automation-agent",
      input.sourceDigest,
    );
  await assert.rejects(browser(), /Missing browserImplementation/);
  await workflow.attach("browserImplementation", {
    ...context,
    files: { "ui.spec.ts": input.sourceFiles["ui.spec.ts"] },
    mappings: [ui],
    browserCases: [],
  });
  await writeFile(join(root, "ui.spec.ts"), "stale browser file");
  await assert.rejects(browser(), /Stale/);
  await writeFile(join(root, "ui.spec.ts"), "synthetic browser test");
  await browser();
  const identities = [unit, ui].map((mapping) => ({
    schemaVersion: "1.0.0",
    repository: "demo",
    runner: mapping.level === "browser" ? "playwright" : "node",
    automationId: mapping.automationIdentity.split(":").at(-1),
    sourceLocation: mapping.file,
    behaviorDigest: fingerprint(mapping.title),
    sourceDigest: input.sourceDigest,
    associations: [
      {
        storyKey: input.storyKey,
        scenarioIds: ["C1"],
        requirementIds: mapping.covers.map((pair) => pair.requirementId),
        acceptanceIds: mapping.covers.map((pair) => pair.acceptanceId),
      },
    ],
  }));
  const inventory = {
    schemaVersion: "1.0.0",
    storyKey: input.storyKey,
    identities,
  };
  await workflow.attach("inventory", inventory);
  const rows = [unit, ui].map(({ automationIdentity, covers }) => ({
    ...covers[0]!,
    scenarioId: "C1",
    automationIdentity,
  }));
  const reviewPath = "automation/review.json";
  const reviewFileDigest = await writeExclusive(workflow.path, reviewPath, {
    text: "Synthetic automation review",
  });
  const review = () =>
    workflow.advance(
      "AUTOMATION_REVIEWED",
      "test-review-agent",
      input.sourceDigest,
    );
  const trace = async (
    selectedRows: {
      requirementId: string;
      acceptanceId: string;
      scenarioId: string;
      automationIdentity: string;
    }[],
  ) => {
    await workflow.attach("traceability", {
      schemaVersion: "1.0.0",
      storyKey: input.storyKey,
      rows: selectedRows,
    });
  };
  const attachReview = async () =>
    workflow.attach("automationReview", {
      schemaVersion: "1.0.0",
      storyKey: input.storyKey,
      sourceDigest: input.sourceDigest,
      accepted: true,
      reviewDigest: objectDigest(
        [
          "caseImplementation",
          "browserImplementation",
          "inventory",
          "traceability",
        ].map((kind) => workflow.state.evidence[kind]!.digest),
      ),
      evidencePaths: [reviewPath],
      evidenceDigests: { [reviewPath]: reviewFileDigest },
    });
  await trace([rows[0]!]);
  await attachReview();
  await assert.rejects(
    review(),
    /Missing traceability for implementation coverage claim/,
  );
  await trace([...rows, rows[0]!]);
  await assert.rejects(review(), /exact evidence revision/);
  await attachReview();
  await assert.rejects(review(), /Duplicate traceability mapping/);
  await trace([
    ...rows,
    { ...rows[1]!, automationIdentity: unit.automationIdentity },
  ]);
  await attachReview();
  await assert.rejects(review(), /Unsupported traceability coverage claim/);
  await trace(rows);
  await attachReview();
  await review();
  const resumed = await Workflow.resume(
    { ...input, previousRunId: workflow.state.runId },
    provider,
  );
  assert.equal(resumed.state.stage, "AUTOMATION_REVIEWED");
});

test("qa next reconciles active legacy records even after publication and respects pauses", async (t) => {
  const feature = {
    storyKey: "SYN-101",
    stage: "published",
    completedStages: ["implemented", "published"],
    pendingStages: ["automated"],
  };
  const { root } = await fixture(t);
  assert.deepEqual(await resolveQaNext(root, feature), {
    pendingStages: ["implemented", "automated"],
    nextCommand: "qa implement",
  });
  for (const pausedOrDone of [
    { stage: "done" },
    { paused: true },
    { storyKey: "KAN-29" },
  ])
    assert.equal(
      (await resolveQaNext(root, { ...feature, ...pausedOrDone })).nextCommand,
      null,
    );
  const pipeline = JSON.parse(
    await readFile(new URL("../../qa/pipeline.json", import.meta.url), "utf8"),
  );
  assert.equal(pipeline.stages.includes("tests-implemented"), false);
  assert.equal(pipeline.commands["qa test-implement"], undefined);
  assert.equal(Object.keys(pipeline.skills).length, 10);
  assert.equal(pipeline.commands["qa implement"].skill, "feature-development-agent");
  assert.equal(pipeline.commands["qa implement"].stage, "implemented");
  for (const path of Object.values(pipeline.skills)) {
    await readFile(new URL("../../" + path, import.meta.url), "utf8");
  }
});

test("QA handoff recommends safe sequential work and stops at protected gates", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "qa"), { recursive: true });
  await writeFile(
    join(root, "qa/pipeline.json"),
    await readFile(new URL("../../qa/pipeline.json", import.meta.url)),
  );
  const runScope = { storyKey: "SYN-101", runId: "design-01" };
  const path = "artifacts/qa/SYN-101/design-01/requirements.md";
  await mkdir(join(root, "artifacts/qa/SYN-101/design-01"), { recursive: true });
  await writeFile(join(root, path), "reviewed requirements");
  const feature = {
    storyKey: "SYN-101",
    stage: "requirements",
    completedStages: ["story", "requirements"],
    pendingStages: ["designed", "reviewed", "branch-ready"],
  };
  const completed = {
    command: "qa requirements",
    artifacts: [{ path, digest: fingerprint("reviewed requirements") }],
  };
  const oneStep = await recommendQaHandoff(root, feature, { completed });
  assert.equal(oneStep.disposition, "stop");
  assert.equal(oneStep.completed?.agent, "requirements-analysis-agent");
  assert.deepEqual(oneStep.completed?.artifacts, completed.artifacts);
  assert.equal(oneStep.next?.agent, "test-design-agent");
  assert.equal(oneStep.next?.command, "qa test-design");
  assert.equal(oneStep.confirmation, "Confirm `qa test-design` for SYN-101 only.");
  assert.deepEqual(oneStep.blockers, []);
  assert.match(oneStep.next?.purpose ?? "", /test cases/);
  assert.match(oneStep.reason, /designed/);
  assert.equal(oneStep.approvalStatus, "not-required-for-analysis");
  assert.equal(oneStep.continuationStatus, "confirmation-required");
  const missingPrerequisite = await recommendQaHandoff(
    root,
    { ...feature, completedStages: ["story"] },
    { mode: "end-to-end" },
  );
  assert.equal(missingPrerequisite.disposition, "stop");
  assert.match(missingPrerequisite.reason, /requirements stage/);
  assert.equal(
    (await recommendQaHandoff(root, feature, { mode: "read-only" }))
      .disposition,
    "stop",
  );
  for (const scope of [undefined, { ...runScope, storyKey: "SYN-102" }, { ...runScope, runId: "design-02" }]) {
    const handoff = await recommendQaHandoff(root, feature, { mode: "end-to-end", runScope: scope, completed });
    assert.equal(handoff.disposition, "stop");
    assert.equal(handoff.continuationStatus, "confirmation-required");
  }
  const authorized = await recommendQaHandoff(root, feature, { mode: "end-to-end", runScope, completed });
  assert.equal(authorized.disposition, "continue-analysis");
  assert.equal(authorized.continuationStatus, "authorized-for-run");
  for (const stage of [
    "branch-ready",
    "implemented",
    "automated",
    "executed",
    "published",
    "in-review",
    "done",
  ]) {
    const next = await recommendQaHandoff(
      root,
      { ...feature, testPlanKey: "SYN-99", pendingStages: [stage] },
      { mode: "end-to-end", runScope, approval: "OK" },
    );
    assert.equal(next.approvalStatus, "required", stage);
    assert.equal(next.continuationStatus, "approval-required", stage);
    assert.equal(next.disposition, "stop", stage);
  }
  for (const status of ["blocked", "failed", "declined", "uncertain"]) {
    const next = await recommendQaHandoff(root, feature, {
      mode: "end-to-end",
      status,
    });
    assert.equal(next.disposition, "stop");
    assert.equal(next.next, null);
    assert.match(next.reason, new RegExp(status));
  }
  for (const override of [
    { paused: true },
    { storyKey: "KAN-29" },
    { stage: "done" },
  ]) {
    assert.equal(
      (await recommendQaHandoff(root, { ...feature, ...override })).next,
      null,
    );
  }
  await writeFile(join(root, path), "changed requirements");
  const stale = await recommendQaHandoff(root, feature, {
    mode: "end-to-end",
    completed,
  });
  assert.equal(stale.completed, undefined);
  assert.equal(stale.next, null);
  assert.match(stale.reason, /stale/);
});

test("QA handoff verifies automation review and allows local execution without a Test Plan", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "qa"), { recursive: true });
  await writeFile(
    join(root, "qa/pipeline.json"),
    await readFile(new URL("../../qa/pipeline.json", import.meta.url)),
  );
  const path = "artifacts/qa/SYN-101/automation-review.md";
  await mkdir(join(root, "artifacts/qa/SYN-101"), { recursive: true });
  const body = "- Decision: accepted for automation.\n";
  await writeFile(join(root, path), body);
  const feature = {
    storyKey: "SYN-101",
    stage: "automated",
    completedStages: ["automated"],
    pendingStages: ["executed"],
  };
  const absent = await recommendQaHandoff(root, feature, {
    mode: "end-to-end",
    runScope: { storyKey: "SYN-101", runId: "design-01" },
  });
  assert.equal(absent.next?.command, "qa test-review");
  assert.equal(absent.next?.agent, "test-review-agent");
  assert.equal(absent.disposition, "continue-analysis");
  const reviewed = {
    ...feature,
    evidence: { automationReviewProof: { path, digest: fingerprint(body) } },
  };
  const noPlan = await recommendQaHandoff(root, reviewed, {
    mode: "end-to-end",
  });
  assert.equal(noPlan.next?.command, "qa run");
  assert.match(noPlan.approvalRequirement ?? "", /execution scope/);
  assert.equal(noPlan.disposition, "stop");
  const ready = { ...reviewed, testPlanKey: "SYN-99" };
  assert.equal((await recommendQaHandoff(root, ready)).next?.command, "qa run");
  await writeFile(join(root, path), "- Decision: changes requested.\n");
  assert.equal(
    (await recommendQaHandoff(root, ready)).next?.command,
    "qa test-review",
  );
  const staleImplementation = await recommendQaHandoff(root, {
    ...ready,
    completedStages: ["implemented", "automated"],
  });
  assert.equal(staleImplementation.next?.command, "qa implement");
  assert.match(staleImplementation.reason, /stale/);
});

test("legacy automation review is reusable only with current browser, source and mapping evidence", async (t) => {
  const { root } = await fixture(t);
  const dir = "artifacts/qa/SYN-101";
  const path = dir + "/legacy-review.md";
  const browserTest = "tests/e2e/legacy.spec.ts";
  const caseMappings = dir + "/case-mappings.json";
  const files = {
    [browserTest]: "browser cases",
    "src/app.ts": "application",
    [caseMappings]: "reviewed mappings",
  };
  for (const directory of ["qa", dir, "tests/e2e", "src"])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, "qa/pipeline.json"),
    await readFile(new URL("../../qa/pipeline.json", import.meta.url)),
  );
  for (const [file, content] of Object.entries(files))
    await writeFile(join(root, file), content);
  const feature = {
    storyKey: "SYN-101",
    stage: "automated",
    completedStages: ["automated"],
    pendingStages: ["executed"],
    evidence: { automationReview: path, browserTest, caseMappings },
  };
  const report = (decision: string, reviewed: Record<string, string> = files) =>
    [
      "- Decision: " + decision,
      "",
      "## Reviewed revisions",
      ...Object.entries(reviewed).map(
        ([file, content]) => "- " + file + " " + fingerprint(content),
      ),
    ].join("\n");

  await writeFile(join(root, path), report("accepted for automation."));
  assert.equal(
    (await recommendQaHandoff(root, feature)).next?.command,
    "qa run",
  );
  assert.equal(
    (
      await recommendQaHandoff(root, {
        ...feature,
        evidence: {
          ...feature.evidence,
          automationReviewProof: { path, digest: fingerprint("stale proof") },
        },
      })
    ).next?.command,
    "qa test-review",
  );
  await writeFile(
    join(root, path),
    report("accepted for case implementation."),
  );
  assert.equal(
    (await recommendQaHandoff(root, feature)).next?.command,
    "qa test-review",
  );
  await writeFile(
    join(root, path),
    report("accepted for automation.", {
      [browserTest]: files[browserTest]!,
      "src/app.ts": files["src/app.ts"],
    }),
  );
  assert.equal(
    (await recommendQaHandoff(root, feature)).next?.command,
    "qa test-review",
  );
  await writeFile(join(root, path), report("accepted for automation."));
  await writeFile(join(root, browserTest), "changed browser cases");
  assert.equal(
    (await recommendQaHandoff(root, feature)).next?.command,
    "qa test-review",
  );
});

test("paused Stories cannot begin or advance a typed delivery run", async (t) => {
  const { root, input } = await fixture(t);
  await assert.rejects(
    Workflow.start({ ...input, storyKey: "KAN-30" }),
    /paused/,
  );
  const workflow = await Workflow.start(input);
  await mkdir(join(root, "qa", input.storyKey), { recursive: true });
  await writeFile(
    join(root, "qa", input.storyKey, "feature.json"),
    JSON.stringify({
      storyKey: input.storyKey,
      stage: "published",
      paused: true,
    }),
  );
  await assert.rejects(
    workflow.advance(
      "ANALYZED",
      "requirements-analysis-agent",
      input.sourceDigest,
    ),
    /paused/,
  );
  await assert.rejects(workflow.attach("source", {}), /paused/);
});

test("repository guard accepts a registered nested worktree and rejects the wrong backlink", async (t) => {
  const { root } = await fixture(t);
  const nested = join(root, ".worktrees", "fixture");
  const registration = join(root, ".git", "worktrees", "fixture");
  await mkdir(nested, { recursive: true });
  await mkdir(registration, { recursive: true });
  await writeFile(
    join(nested, "package.json"),
    JSON.stringify({ name: "agentic-demo-website" }),
  );
  await writeFile(join(nested, ".git"), "gitdir: " + registration);
  await writeFile(join(registration, "gitdir"), join(nested, ".git"));
  await writeFile(join(registration, "commondir"), "../..");
  assert.equal(await verifyRepository(nested), await realpath(nested));
  await writeFile(join(registration, "gitdir"), join(root, ".git"));
  await assert.rejects(verifyRepository(nested), /Unauthorized worktree/);
});

test("multiple approved cases may reuse one automation identity only at the same exact path and title", async (t) => {
  const { input } = await fixture(t);
  const refs = { requirementIds: ["R1"], acceptanceIds: ["A1"] };
  const mappings = ["C1", "C2"].map((caseId) => ({
    caseId,
    level: "unit" as const,
    automationIdentity: "demo:node:shared",
    file: "unit.test.ts",
    title: "checks both approved outcomes",
    disposition: "existing" as const,
    covers: [{ requirementId: "R1", acceptanceId: "A1" }],
  }));
  const identity = {
    schemaVersion: "1.0.0" as const,
    repository: "demo",
    runner: "node" as const,
    automationId: "shared",
    sourceLocation: "unit.test.ts",
    behaviorDigest: fingerprint("shared behavior"),
    sourceDigest: input.sourceDigest,
    associations: [
      { storyKey: input.storyKey, scenarioIds: ["C1", "C2"], ...refs },
    ],
  };
  const rows = mappings.map(({ caseId, automationIdentity }) => ({
    scenarioId: caseId,
    requirementId: "R1",
    acceptanceId: "A1",
    automationIdentity,
  }));
  const cases = mappings.map(({ caseId }) => ({
    id: caseId,
    ...refs,
    kind: "automated" as const,
    levels: ["unit" as const],
    preconditions: ["Isolated fixture"],
    actions: ["Act"],
    expected: "Observable outcome",
  }));
  const requirements = [{ id: "R1", text: "Behavior", acceptanceIds: ["A1"] }];
  const validate = () =>
    validateFinalMappings(
      input,
      mappings,
      [identity],
      rows,
      cases,
      requirements,
    );
  assert.doesNotThrow(validate);
  assert.throws(
    () =>
      validateFinalMappings(
        input,
        mappings,
        [identity, identity],
        rows,
        cases,
        requirements,
      ),
    /Duplicate automation inventory identity/,
  );
  assert.throws(
    () =>
      validateFinalMappings(
        input,
        mappings,
        [identity],
        rows,
        cases.map((scenario) => ({ ...scenario, acceptanceIds: ["A1", "A2"] })),
        [{ ...requirements[0]!, acceptanceIds: ["A1", "A2"] }],
      ),
    /Missing approved case traceability/,
  );
  mappings[1]!.title = "different exact test title";
  assert.throws(validate, /Conflicting exact test path or title/);
});

for (const browserCoverage of [false, true]) {
  test(
    "split LOCAL_READY requires persisted and executed Playwright coverage: " +
      browserCoverage,
    async (t) => {
      const { input } = await fixture(t);
      const workflow = await Workflow.start(input, provider);
      await analyzed(
        workflow,
        input,
        false,
        browserCoverage ? ["unit", "browser"] : ["unit"],
      );
      const advance = (
        stage: Parameters<Workflow["advance"]>[0],
        role: Parameters<Workflow["advance"]>[1],
        approval?: string,
      ) => workflow.advance(stage, role, input.sourceDigest, approval);
      await advance("IMPLEMENTATION_AUTHORIZED", "qa-orchestrator", "mock");
      const context = {
        schemaVersion: "1.0.0",
        storyKey: input.storyKey,
        sourceDigest: input.sourceDigest,
        designDigest: workflow.state.evidence.scenarios!.digest,
      };
      await workflow.attach("featureImplementation", {
        ...context,
        implementationFiles: { "source.ts": input.sourceFiles["source.ts"] },
        developerTestFiles: {
          "unit.test.ts": input.sourceFiles["unit.test.ts"],
        },
      });
      await advance("IMPLEMENTED", "feature-development-agent");
      const unit = {
        caseId: "C1",
        level: "unit",
        file: "unit.test.ts",
        title: "unit test",
        automationIdentity: "demo:node:unit",
        disposition: "existing",
        covers: [{ requirementId: "R1", acceptanceId: "A1" }],
      };
      const browser = {
        caseId: "C1",
        level: "browser",
        file: "ui.spec.ts",
        title: "browser test",
        automationIdentity: "demo:playwright:browser",
        disposition: "added",
        covers: [{ requirementId: "R1", acceptanceId: "A1" }],
      };
      await workflow.attach("caseImplementation", {
        ...context,
        files: { "unit.test.ts": input.sourceFiles["unit.test.ts"] },
        mappings: [unit],
        browserCases: browserCoverage ? ["C1"] : [],
      });
      await advance("TESTS_IMPLEMENTED", "feature-development-agent");
      await workflow.attach("browserImplementation", {
        ...context,
        files: browserCoverage
          ? { "ui.spec.ts": input.sourceFiles["ui.spec.ts"] }
          : {},
        mappings: browserCoverage ? [browser] : [],
        browserCases: [],
      });
      await advance("BROWSER_IMPLEMENTED", "playwright-automation-agent");
      const mappings = browserCoverage ? [unit, browser] : [unit];
      await workflow.attach("inventory", {
        schemaVersion: "1.0.0",
        storyKey: input.storyKey,
        identities: mappings.map((mapping) => ({
          schemaVersion: "1.0.0",
          repository: "demo",
          runner: mapping.level === "browser" ? "playwright" : "node",
          automationId: mapping.level,
          sourceLocation: mapping.file,
          behaviorDigest: fingerprint(mapping.title),
          sourceDigest: input.sourceDigest,
          associations: [
            {
              storyKey: input.storyKey,
              scenarioIds: ["C1"],
              requirementIds: ["R1"],
              acceptanceIds: ["A1"],
            },
          ],
        })),
      });
      await workflow.attach("traceability", {
        schemaVersion: "1.0.0",
        storyKey: input.storyKey,
        rows: mappings.map(({ automationIdentity }) => ({
          scenarioId: "C1",
          requirementId: "R1",
          acceptanceId: "A1",
          automationIdentity,
        })),
      });
      const path = "automation/review.json";
      const digest = await writeExclusive(workflow.path, path, {
        text: "Synthetic automation review",
      });
      await workflow.attach("automationReview", {
        schemaVersion: "1.0.0",
        storyKey: input.storyKey,
        sourceDigest: input.sourceDigest,
        accepted: true,
        reviewDigest: objectDigest(
          [
            "caseImplementation",
            "browserImplementation",
            "inventory",
            "traceability",
          ].map((kind) => workflow.state.evidence[kind]!.digest),
        ),
        evidencePaths: [path],
        evidenceDigests: { [path]: digest },
      });
      await advance("AUTOMATION_REVIEWED", "test-review-agent");
      const raw = await workflow.captureEvidence("synthetic passing execution");
      const execution = {
        schemaVersion: "1.0.0",
        storyKey: input.storyKey,
        sourceDigest: input.sourceDigest,
        executionId: "synthetic-1",
        results: mappings.map(({ automationIdentity }) => ({
          identity: automationIdentity,
          runner: "node",
          outcome: "passed",
          attempt: 0,
          failures: [],
          evidence: [raw.path],
          artifactDigest: raw.digest,
        })),
        gates: [
          {
            name: "lint",
            exitCode: 0,
            command: "mock lint",
            evidence: raw.path,
          },
        ],
      };
      await workflow.attach("execution", execution);
      const validate = () =>
        advance("VALIDATED", "test-execution-reporting-agent");
      const ready = () => advance("LOCAL_READY", "qa-orchestrator");
      if (browserCoverage) {
        await assert.rejects(
          validate(),
          /Persisted and executed Playwright coverage/,
        );
        await workflow.attach("execution", {
          ...execution,
          executionId: "synthetic-2",
          results: execution.results.map((result) =>
            result.identity === browser.automationIdentity
              ? { ...result, runner: "playwright" }
              : result,
          ),
        });
        await validate();
        await ready();
        assert.equal(workflow.state.stage, "LOCAL_READY");
      } else {
        await validate();
        await assert.rejects(
          ready(),
          /Persisted and executed Playwright coverage/,
        );
        assert.equal(workflow.state.stage, "VALIDATED");
      }
    },
  );
}

test("blocked handoffs scope a safe recovery or identify the missing dependency", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "qa"), { recursive: true });
  await writeFile(join(root, "qa/pipeline.json"), await readFile(new URL("../../qa/pipeline.json", import.meta.url)));
  const feature = { storyKey: "SYN-101", stage: "published",
    completedStages: ["published"], pendingStages: ["executed"] };
  const input = { status: "blocked", reason: "Requirements need reconciliation.",
    blocker: { dependency: "Accepted requirements" },
    mode: "end-to-end", runScope: { storyKey: feature.storyKey, runId: "run-01" } };
  const generic = await recommendQaHandoff(root, feature, { ...input, blocker: {
    dependency: "Reviewed requirement reconciliation", remaining: ["Confirmed requirement revision"],
    review: { agent: "requirements-analysis-agent", purpose: "Compare the available requirement revisions." },
  } });
  assert.equal(generic.confirmation, "Confirm requirements-analysis-agent read-only blocker review for SYN-101.");
  assert.equal(generic.next?.agent, "requirements-analysis-agent");
  assert.deepEqual(generic.blockers, ["Reviewed requirement reconciliation", "Confirmed requirement revision"]);
  const unavailable = await recommendQaHandoff(root, feature, { ...input,
    blocker: { dependency: "Verified evidence source" } });
  assert.equal(unavailable.next, null);
  assert.equal(unavailable.confirmation, null);
  assert.deepEqual(unavailable.blockers, ["Verified evidence source"]);
  for (const status of ["declined", "uncertain", "failed"]) {
    const stopped = await recommendQaHandoff(root, feature, { ...input, status });
    assert.equal(stopped.disposition, "stop");
    assert.equal(stopped.confirmation, null);
  }
  const paused = await recommendQaHandoff(root, { ...feature, paused: true }, input);
  assert.equal(paused.next, null);
  assert.equal(paused.confirmation, null);
});
