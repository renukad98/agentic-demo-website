import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fingerprint } from "../../tools/agentic/artifacts.js";
import {
  checkXrayLifecycle,
  prepareXrayLifecycle,
  previewXrayLifecycle,
  recordXrayLifecycle,
} from "../../tools/agentic/chat-xray-lifecycle.js";

const storyKey = "KAN-80";
const apiCase = storyKey + "-TC-002";
const browserCase = storyKey + "-TC-001";
const start = "qa xray-status start";
const finish = "qa xray-status finish " + storyKey;
const transitions = [
  { id: "21", to: "In Progress", requiredFields: [] as string[] },
  { id: "41", to: "Done", requiredFields: [] as string[] },
];

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xray-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = "artifacts/qa/" + storyKey;
  async function put(path: string, value: unknown) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  const design =
    "# KAN-80 test design\n" +
    [browserCase, apiCase]
      .map((id) =>
        [
          "## " + id + " — Reviewed case",
          "- Preconditions: Isolated fixture",
          "| Step | Action | Test data | Expected observable result |",
          "| --- | --- | --- | --- |",
          "| 1 | Exercise behavior | Synthetic input | Observe result |",
        ].join("\n"),
      )
      .join("\n");
  const feature = {
    storyKey,
    stage: "published",
    paused: false,
    completedStages: ["reviewed", "published", "executed"],
    testPlanKey: "KAN-81",
    testExecutionKey: "KAN-84",
    evidence: {
      testDesign: dir + "/design.md",
      testReview: dir + "/review.md",
    },
  };
  const featurePath = "qa/" + storyKey + "/feature.json";
  await put(featurePath, feature);
  await put("qa/current.json", { storyKey, featureFile: featurePath });
  await put(feature.evidence.testDesign, design);
  await put(
    feature.evidence.testReview,
    "- Decision: accepted for design.\n- testDesign " +
      fingerprint(design).slice(7),
  );
  await put(dir + "/xray-test-keys.json", {
    [browserCase]: "KAN-82",
    [apiCase]: "KAN-83",
  });
  const apiEvidence = JSON.stringify({
    storyKey,
    caseId: apiCase,
    testKey: "KAN-83",
    outcome: "passed",
  });
  await put(dir + "/api.json", apiEvidence);
  const context = {
    cloudId: "https://example.atlassian.net",
    story: {
      key: storyKey,
      id: "80",
      issueType: "Story",
      status: "In Progress",
    },
    plan: {
      key: "KAN-81",
      id: "81",
      issueType: "Test Plan",
      status: "To Do",
      storyKey,
      linkId: "101",
      linkType: "Relates",
      transitions: structuredClone(transitions),
    },
    tests: [
      {
        key: "KAN-82",
        id: "82",
        issueType: "Test",
        status: "To Do",
        storyKey,
        linkId: "102",
        linkType: "Test",
        transitions: structuredClone(transitions),
      },
      {
        key: "KAN-83",
        id: "83",
        issueType: "Test",
        status: "To Do",
        storyKey,
        linkId: "103",
        linkType: "Test",
        transitions: structuredClone(transitions),
      },
    ],
    planMembers: ["KAN-82", "KAN-83"],
    execution: {
      key: "KAN-84",
      id: "84",
      issueType: "Test Execution",
      status: "To Do",
      planKey: "KAN-81",
      runs: [
        { storyKey, caseId: browserCase, testKey: "KAN-82", outcome: "passed" },
      ],
    },
    caseEvidence: [
      {
        caseId: apiCase,
        path: dir + "/api.json",
        sha256: fingerprint(apiEvidence),
      },
    ],
  };
  return { root, context, put, feature, featurePath };
}

test("start proposes exact transitions and binds one issue to a fresh approval", async (t) => {
  const { root, context } = await fixture(t);
  const ready = await prepareXrayLifecycle(root, start, context);
  assert.deepEqual(
    ready.tests.map((item) => item.state),
    ["ready", "ready"],
  );
  assert.equal(ready.plan.state, "ready");
  const preview = await previewXrayLifecycle(root, start, context, "KAN-82");
  assert.deepEqual(preview.arguments, {
    cloudId: context.cloudId,
    issueIdOrKey: "KAN-82",
    transitionId: "21",
  });
  await assert.rejects(
    checkXrayLifecycle(root, start, context, "KAN-82", preview, "yes"),
    /requires OK/,
  );
  await assert.rejects(
    checkXrayLifecycle(root, start, context, "KAN-83", preview, "OK"),
    /requires OK/,
  );
  const fresh = structuredClone(context);
  fresh.tests[0]!.transitions[0]!.id = "121";
  await assert.rejects(
    checkXrayLifecycle(root, start, fresh, "KAN-82", preview, "OK"),
    /requires OK/,
  );
  const readback = { ...context.tests[0], status: "In Progress" };
  await assert.rejects(
    recordXrayLifecycle(root, start, context, "KAN-82", preview, "OK", {
      ...readback,
      id: "91",
    }),
    /readback/,
  );
  const result = await recordXrayLifecycle(
    root,
    start,
    context,
    "KAN-82",
    preview,
    "OK",
    readback,
  );
  assert.equal(
    JSON.parse(await readFile(join(root, result.path), "utf8")).readback.status,
    "In Progress",
  );
  assert.deepEqual(
    await recordXrayLifecycle(
      root,
      start,
      context,
      "KAN-82",
      preview,
      "OK",
      readback,
    ),
    result,
  );
  fresh.tests[0]!.status = "In Progress";
  assert.equal(
    (await prepareXrayLifecycle(root, start, fresh)).tests[0]?.state,
    "already-at-or-beyond-target",
  );
});

test("finish enforces sequential statuses, passing evidence and exact Plan membership", async (t) => {
  const { root, context } = await fixture(t);
  context.plan.status = "In Progress";
  assert.equal(
    (await prepareXrayLifecycle(root, finish, context)).tests[0]?.state,
    "blocked",
  );
  for (const item of context.tests) item.status = "In Progress";
  const ready = await prepareXrayLifecycle(root, finish, context);
  assert.deepEqual(
    ready.tests.map((item) => item.state),
    ["ready", "ready"],
  );
  assert.equal(ready.plan.state, "blocked");
  for (const item of context.tests) item.status = "Done";
  assert.equal(
    (await prepareXrayLifecycle(root, finish, context)).plan.state,
    "ready",
  );
  context.planMembers.pop();
  assert.equal(
    (await prepareXrayLifecycle(root, finish, context)).plan.state,
    "blocked",
  );
  context.planMembers.push("KAN-83");
  context.tests[0]!.status = "In Progress";
  context.execution.runs[0]!.outcome = "failed";
  assert.equal(
    (await prepareXrayLifecycle(root, finish, context)).tests[0]?.state,
    "blocked",
  );
  context.execution.runs[0]!.outcome = "passed";
  context.execution.planKey = "KAN-88";
  await assert.rejects(
    prepareXrayLifecycle(root, finish, context),
    /Execution readback/,
  );
});

test("finish requires the recorded post-merge execution when it exists", async (t) => {
  const { root, context, put, feature, featurePath } = await fixture(t);
  await put(featurePath, {
    ...feature,
    verifiedRecords: { postMergeExecution: { testExecutionKey: "KAN-85" } },
  });
  await assert.rejects(
    prepareXrayLifecycle(root, finish, context),
    /Execution readback/,
  );
  context.execution.key = "KAN-85";
  context.execution.id = "85";
  context.tests[0]!.status = "In Progress";
  assert.equal(
    (await prepareXrayLifecycle(root, finish, context)).tests[0]?.state,
    "ready",
  );
});

test("lifecycle rejects pause, wrong relations, required fields and stale case evidence", async (t) => {
  const { root, context, put, feature, featurePath } = await fixture(t);
  await assert.rejects(
    prepareXrayLifecycle(root, "qa xray-status start KAN-29", context),
    /paused/,
  );
  await put(featurePath, { ...feature, paused: true });
  await assert.rejects(prepareXrayLifecycle(root, start, context), /paused/);
  await put(featurePath, feature);
  context.tests[0]!.storyKey = "KAN-88";
  await assert.rejects(prepareXrayLifecycle(root, start, context), /coverage/);
  context.tests[0]!.storyKey = storyKey;
  context.plan.transitions[0]!.requiredFields = ["resolution"];
  assert.equal(
    (await prepareXrayLifecycle(root, start, context)).plan.state,
    "blocked",
  );
  await put(context.caseEvidence[0]!.path, "{}");
  await assert.rejects(
    prepareXrayLifecycle(root, finish, context),
    /evidence changed/,
  );
});
