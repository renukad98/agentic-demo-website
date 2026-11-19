import assert from "node:assert/strict";
import test from "node:test";
import {
  duplicatePacket,
  validateDuplicateReview,
  type DuplicateContent,
} from "../../tools/xray-mcp/agents/xray-duplicate-review.js";

const proposed: DuplicateContent = {
  ref: "planned:TC-1",
  summary: "Cancel deletion",
  manual: true,
  description: "Verify cancellation",
  steps: [
    {
      action: "Click Cancel deletion.",
      data: "Owned task",
      result: "The task remains visible.",
    },
  ],
};
const generic: DuplicateContent = {
  ref: "QA-2",
  summary: "Prevent duplicate submissions",
  manual: false,
  steps: [],
  generic: { kind: "Unstructured", definition: null },
  description:
    "Test: Create stays disabled during submission\nSource: tests/submission.spec.ts",
};
const packet = duplicatePacket("TC-1", proposed, [generic]);
const review = () => ({
  schemaVersion: "1.0.0" as const,
  cases: [
    {
      testCaseId: "TC-1",
      evidenceDigest: packet.evidenceDigest,
      decisions: [
        {
          candidateRef: generic.ref,
          disposition: "related-distinct" as const,
          rationale:
            "The candidate verifies submission locking. The proposal verifies deletion cancellation.",
          genericComparison: {
            candidateBehavior: "Create stays disabled during submission",
            evidenceReference: "tests/submission.spec.ts",
            proposedOutcome: "The task remains visible.",
          },
        },
      ],
    },
  ],
});

test("Generic evidence permits a documented distinction and still requires review", () => {
  assert.throws(
    () => validateDuplicateReview(packet, undefined),
    /DUPLICATE_REVIEW_REQUIRED/,
  );
  assert.doesNotThrow(() => validateDuplicateReview(packet, review()));
});

test("missing and altered evidence fail closed", () => {
  for (const candidate of [
    { ...generic, description: null },
    {
      ref: generic.ref,
      summary: generic.summary,
      manual: false,
      steps: [],
      description: generic.description,
    },
    {
      ...generic,
      description: "Test: Create stays disabled during submission",
    },
  ]) {
    const current = duplicatePacket("TC-1", proposed, [candidate]);
    const decision = review();
    decision.cases[0]!.evidenceDigest = current.evidenceDigest;
    assert.throws(
      () => validateDuplicateReview(current, decision),
      /DUPLICATE_REVIEW_REQUIRED/,
    );
  }
  const altered = review();
  altered.cases[0]!.decisions[0]!.genericComparison.evidenceReference =
    "tests/unverified.spec.ts";
  assert.throws(
    () => validateDuplicateReview(packet, altered),
    /DUPLICATE_REVIEW_REQUIRED/,
  );
  const changed = duplicatePacket("TC-1", proposed, [
    { ...generic, generic: { kind: "Unstructured", definition: "different" } },
  ]);
  assert.throws(
    () => validateDuplicateReview(changed, review()),
    /DUPLICATE_REVIEW_REQUIRED/,
  );
  const changedPlan = duplicatePacket(
    "TC-1",
    { ...proposed, summary: "Edited plan" },
    [generic],
  );
  assert.throws(
    () => validateDuplicateReview(changedPlan, review()),
    /DUPLICATE_REVIEW_REQUIRED/,
  );
});

test("equivalent executable steps or Generic text block regardless of review", () => {
  for (const candidate of [
    { ...generic, steps: proposed.steps },
    { ...generic, manual: true, steps: proposed.steps },
    {
      ...generic,
      description:
        generic.description +
        "\nClick Cancel deletion. The task remains visible.",
    },
  ]) {
    assert.throws(
      () =>
        validateDuplicateReview(
          duplicatePacket("TC-1", proposed, [candidate]),
          review(),
        ),
      /EXACT_DUPLICATE/,
    );
  }
});
