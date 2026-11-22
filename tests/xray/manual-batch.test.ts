import assert from "node:assert/strict";
import test from "node:test";
import { objectDigest } from "../../tools/agentic/artifacts.js";
import {
  previewManualBatch,
  publishManualBatch,
  readManualBatchOutcome,
} from "../../tools/xray/manual-batch.js";

function fixture() {
  const plan = {
    schemaVersion: "1.1.0",
    operation: "xray.publishStory",
    environmentId: "test-environment",
    projectKey: "ABC",
    storyKey: "ABC-123",
    workflowId: "synthetic",
    workflowCorrelationId: "batch-one",
    storyEvidence: {
      issueId: "123",
      contentDigest: objectDigest("source"),
      requirements: [{ id: "R1", text: "Show the search field" }],
    },
    linkType: {
      id: "44",
      name: "Test",
      inward: "is tested by",
      outward: "tests",
    },
    review: {
      disposition: "approved-for-human-review",
      evidence: ["review.md"],
    },
    cases: [
      {
        kind: "new",
        testCaseId: "TC-001",
        summary: "Find search",
        description: "Verify search",
        preconditions: ["Sign in"],
        testData: "Synthetic user",
        overallExpectedResult: "Search appears",
        sourceReferences: ["cases.md"],
        steps: [
          {
            action: "Open Tasks",
            data: "Synthetic account",
            result: "Search appears",
          },
        ],
      },
    ],
  };
  const workflow = {
    tenant: "fixture.atlassian.net",
    storyKey: plan.storyKey,
    paused: false,
    ready: true,
    evidenceDigest: objectDigest("approved design"),
    approvedPlanDigest: objectDigest(plan),
    caseIds: ["TC-001"],
  };
  const state = {
    approval: "",
    consumed: false,
    prepares: 0,
    posts: 0,
    lost: false,
    partial: false,
    duplicate: false,
    snapshot: objectDigest("inventory"),
  };
  const ports = {
    loadCurrentWorkflow: async () => workflow,
    inspect: async () =>
      state.duplicate
        ? null
        : { tenant: workflow.tenant, snapshotDigest: state.snapshot },
    consumeChatApproval: async (reference: string, fingerprint: string) => {
      if (
        reference !== "authenticated-turn" ||
        state.consumed ||
        state.approval !== fingerprint
      )
        return false;
      state.consumed = true;
      return true;
    },
    prepare: async () => {
      state.prepares++;
      return { approvalId: "connector-approval" };
    },
    publish: async (_plan: unknown, approvalId: string) => {
      assert.equal(approvalId, "connector-approval");
      state.posts++;
      if (state.lost) throw new Error("lost response");
      return { executionId: "execution-1" };
    },
    reconcile: async (executionId: string) => ({
      executionId,
      verified: state.partial
        ? []
        : [
            {
              caseId: "TC-001",
              testKey: "ABC-124",
              testIssueId: "124",
              creation: "created" as const,
              link: "linked" as const,
            },
          ],
    }),
  };
  return { plan, workflow, state, ports };
}

test("read-only preview and one exact approval dispatch a generic batch at most once", async () => {
  const { plan, state, ports } = fixture();
  const review = await previewManualBatch(plan, ports);
  assert.equal(state.prepares, 0);
  await assert.rejects(
    publishManualBatch(plan, review.fingerprint, "OK", ports),
    /DENIED/,
  );
  await assert.rejects(
    publishManualBatch(plan, review.fingerprint, "authenticated-turn", {
      ...ports,
      consumeChatApproval: undefined,
    }),
    /UNAVAILABLE/,
  );
  state.approval = review.fingerprint;
  const run = () =>
    publishManualBatch(plan, review.fingerprint, "authenticated-turn", ports);
  const outcomes = await Promise.allSettled([run(), run()]);
  const confirmed = outcomes.find((outcome) => outcome.status === "fulfilled");
  assert.equal(confirmed?.value.status, "VERIFIED");
  assert.equal(state.posts, 1);
  assert.equal(state.prepares, 1);
});

test("paused, duplicate, changed payload, and stale inventory all fail closed", async () => {
  const { plan, state, ports, workflow } = fixture();
  workflow.paused = true;
  await assert.rejects(previewManualBatch(plan, ports), /WORKFLOW_BLOCKED/);
  workflow.paused = false;
  state.duplicate = true;
  await assert.rejects(previewManualBatch(plan, ports), /PREFLIGHT_BLOCKED/);
  state.duplicate = false;
  const review = await previewManualBatch(plan, ports);
  const changed = structuredClone(plan);
  changed.cases[0]!.steps[0]!.result = "Different result";
  await assert.rejects(previewManualBatch(changed, ports), /SCOPE_MISMATCH/);
  state.snapshot = objectDigest("new inventory");
  await assert.rejects(
    publishManualBatch(plan, review.fingerprint, "authenticated-turn", ports),
    /STALE/,
  );
  assert.equal(state.posts, 0);
});

test("partial outcome can be verified by reads and lost dispatch is never retried", async () => {
  const { plan, state, ports } = fixture();
  const review = await previewManualBatch(plan, ports);
  state.approval = review.fingerprint;
  state.partial = true;
  const partial = await publishManualBatch(
    plan,
    review.fingerprint,
    "authenticated-turn",
    ports,
  );
  assert.equal(partial.status, "PARTIAL");
  assert.deepEqual(partial.unresolved, ["TC-001"]);
  state.partial = false;
  assert.equal(
    (await readManualBatchOutcome(review, "execution-1", ports.reconcile))
      .status,
    "VERIFIED",
  );
  assert.equal(state.posts, 1);

  const next = fixture();
  next.state.approval = review.fingerprint;
  next.state.lost = true;
  assert.equal(
    (
      await publishManualBatch(
        plan,
        review.fingerprint,
        "authenticated-turn",
        next.ports,
      )
    ).status,
    "UNCERTAIN",
  );
  await assert.rejects(
    publishManualBatch(
      plan,
      review.fingerprint,
      "authenticated-turn",
      next.ports,
    ),
    /DENIED/,
  );
  assert.equal(next.state.posts, 1);
});
