import { z } from "zod";
import { objectDigest } from "../agentic/artifacts.js";
import { manualStep } from "./manual-plan.js";

const text = z.string().trim().min(1);
const issueId = z.string().regex(/^[1-9][0-9]*$/);
const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const steps = z.array(manualStep).min(1).max(100);
const coverage = z.array(z.object({ issueId, key: issueKey }).strict());
const commonCase = {
  testCaseId: text,
  sourceReferences: z.array(text).min(1),
};
const plannedCase = z.discriminatedUnion("kind", [
  z
    .object({
      ...commonCase,
      kind: z.literal("new"),
      summary: text.max(255),
      description: text,
      preconditions: z.array(text).min(1),
      testData: text,
      overallExpectedResult: text,
      steps,
    })
    .strict(),
  z
    .object({
      ...commonCase,
      kind: z.literal("existing"),
      existingTest: z
        .object({
          key: issueKey,
          issueId,
          jiraIssueType: z.literal("Test"),
          summary: text,
          description: z.string().nullable(),
          steps,
          coverage,
        })
        .strict(),
      expectedAlreadyLinked: z.boolean(),
      requirementCoverage: z
        .array(
          z
            .object({
              requirementId: text,
              stepNumbers: z.array(z.number().int().positive()).min(1),
              rationale: text,
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);
const planSchema = z
  .object({
    schemaVersion: z.literal("1.1.0"),
    operation: z.literal("xray.publishStory"),
    environmentId: text,
    projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    storyKey: issueKey,
    workflowId: text,
    workflowCorrelationId: text,
    storyEvidence: z
      .object({
        issueId,
        contentDigest: digest,
        requirements: z.array(z.object({ id: text, text }).strict()).min(1),
      })
      .strict(),
    linkType: z
      .object({
        id: issueId,
        name: z.literal("Test"),
        inward: z.literal("is tested by"),
        outward: z.literal("tests"),
      })
      .strict(),
    review: z
      .object({
        disposition: z.literal("approved-for-human-review"),
        evidence: z.array(text).min(1),
      })
      .strict(),
    cases: z.array(plannedCase).min(1),
  })
  .strict();

type Plan = z.infer<typeof planSchema>;
type Workflow = {
  tenant: string;
  storyKey: string;
  paused: boolean;
  ready: boolean;
  /** Fingerprint of the reviewed QA inputs and approved case selection. */
  evidenceDigest: string;
  /** Digest of the plan derived by the host from reviewed cases and duplicate dispositions. */
  approvedPlanDigest: string;
  caseIds: readonly string[];
};
type Outcome = {
  caseId: string;
  testKey: string;
  testIssueId: string;
  creation: "created" | "reused";
  link: "linked" | "already-linked";
};
type Execution = {
  executionId: string;
  /** Supplied only after reading the connector ledger and verifying Jira/Xray readback. */
  verified: readonly Outcome[];
};
type ReadPorts = {
  loadCurrentWorkflow(): Promise<Workflow>;
  /** Inspect-only MCP calls. Return null for ambiguity or incomplete duplicate checks. */
  inspect(
    plan: Plan,
  ): Promise<{ tenant: string; snapshotDigest: string } | null>;
};
type WritePorts = {
  /** Trusted host only. Atomically consume the authenticated chat reply for this review.
   * The host enforces live scope, freshness, latest prompt, and single use.
   */
  consumeChatApproval(reference: string, fingerprint: string): Promise<boolean>;
  /** Bound MCP preparation. Performs no Jira/Xray writes. */
  prepare(plan: Plan): Promise<{ approvalId: string }>;
  /** MCP consumes its own approval and journals individual operations. */
  publish(plan: Plan, approvalId: string): Promise<{ executionId: string }>;
  /** Read-only reconciliation of a known execution. Never dispatches a retry. */
  reconcile(executionId: string, plan: Plan): Promise<Execution>;
};

export async function previewManualBatch(raw: unknown, ports: ReadPorts) {
  const plan = planSchema.parse(raw);
  const workflow = await ports.loadCurrentWorkflow();
  if (workflow.paused || !workflow.ready)
    throw new Error("MANUAL_BATCH_WORKFLOW_BLOCKED");
  const ids = plan.cases.map((item) => item.testCaseId);
  const reused = plan.cases.flatMap((item) =>
    item.kind === "existing" ? [item.existingTest] : [],
  );
  if (
    workflow.storyKey !== plan.storyKey ||
    workflow.approvedPlanDigest !== objectDigest(plan) ||
    !plan.storyKey.startsWith(plan.projectKey + "-") ||
    new Set(ids).size !== ids.length ||
    objectDigest([...ids].sort()) !==
      objectDigest([...workflow.caseIds].sort()) ||
    new Set(reused.map((item) => item.issueId)).size !== reused.length ||
    new Set(reused.map((item) => item.key)).size !== reused.length ||
    reused.some((item) => !item.key.startsWith(plan.projectKey + "-"))
  )
    throw new Error("MANUAL_BATCH_SCOPE_MISMATCH");
  const remote = await ports.inspect(structuredClone(plan));
  if (!remote || remote.tenant !== workflow.tenant)
    throw new Error("MANUAL_BATCH_PREFLIGHT_BLOCKED");
  const binding = {
    tenant: workflow.tenant,
    evidenceDigest: digest.parse(workflow.evidenceDigest),
    snapshotDigest: digest.parse(remote.snapshotDigest),
    plan,
  };
  return { ...binding, fingerprint: objectDigest(binding) };
}

export async function publishManualBatch(
  plan: unknown,
  displayedFingerprint: string,
  chatApprovalReference: string,
  ports: ReadPorts & Partial<WritePorts>,
) {
  const { consumeChatApproval, prepare, publish, reconcile } = ports;
  if (!consumeChatApproval || !prepare || !publish || !reconcile)
    throw new Error("MANUAL_BATCH_TRUSTED_DISPATCH_UNAVAILABLE");
  const review = await previewManualBatch(plan, ports);
  if (review.fingerprint !== displayedFingerprint)
    throw new Error("MANUAL_BATCH_APPROVAL_STALE");
  if (
    !chatApprovalReference ||
    !(await consumeChatApproval(chatApprovalReference, review.fingerprint))
  )
    throw new Error("MANUAL_BATCH_APPROVAL_DENIED");
  if (
    (await previewManualBatch(review.plan, ports)).fingerprint !==
    review.fingerprint
  )
    throw new Error("MANUAL_BATCH_APPROVAL_STALE");
  const prepared = await prepare(structuredClone(review.plan));
  const approvalId = text.parse(prepared.approvalId);
  if (
    (await previewManualBatch(review.plan, ports)).fingerprint !==
    review.fingerprint
  )
    throw new Error("MANUAL_BATCH_APPROVAL_STALE");
  let executionId: string;
  try {
    executionId = text.parse(
      (await publish(structuredClone(review.plan), approvalId)).executionId,
    );
  } catch {
    return {
      status: "UNCERTAIN" as const,
      fingerprint: review.fingerprint,
      unresolved: review.plan.cases.map((item) => item.testCaseId),
    };
  }
  return readManualBatchOutcome(review, executionId, reconcile);
}

export async function readManualBatchOutcome(
  review: Awaited<ReturnType<typeof previewManualBatch>>,
  executionId: string,
  reconcile: WritePorts["reconcile"],
) {
  const pending = new Map(
    review.plan.cases.map((item) => [item.testCaseId, item]),
  );
  const verified: Outcome[] = [];
  const keys = new Set<string>();
  const ids = new Set<string>();
  try {
    const result = await reconcile(executionId, structuredClone(review.plan));
    if (result.executionId !== executionId)
      throw new Error("EXECUTION_MISMATCH");
    for (const outcome of result.verified) {
      const item = pending.get(outcome.caseId);
      if (
        !item ||
        !issueKey.safeParse(outcome.testKey).success ||
        !outcome.testKey.startsWith(review.plan.projectKey + "-") ||
        !issueId.safeParse(outcome.testIssueId).success ||
        keys.has(outcome.testKey) ||
        ids.has(outcome.testIssueId) ||
        (item.kind === "new"
          ? outcome.creation !== "created" || outcome.link !== "linked"
          : outcome.creation !== "reused" ||
            outcome.link !==
              (item.expectedAlreadyLinked ? "already-linked" : "linked") ||
            outcome.testKey !== item.existingTest.key ||
            outcome.testIssueId !== item.existingTest.issueId)
      )
        throw new Error("OUTCOME_SCOPE_MISMATCH");
      keys.add(outcome.testKey);
      ids.add(outcome.testIssueId);
      verified.push(outcome);
      pending.delete(outcome.caseId);
    }
  } catch {
    return {
      status: "UNCERTAIN" as const,
      executionId,
      fingerprint: review.fingerprint,
      verified: [],
      unresolved: review.plan.cases.map((item) => item.testCaseId),
    };
  }
  return {
    status: pending.size ? ("PARTIAL" as const) : ("VERIFIED" as const),
    executionId,
    fingerprint: review.fingerprint,
    verified,
    unresolved: [...pending.keys()],
  };
}
