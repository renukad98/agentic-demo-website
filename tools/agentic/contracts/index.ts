import { z } from "zod";

export const version = z.literal("1.0.0");
export const storyKey = z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
export const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
export const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
const texts = z.array(text).min(1);
const timestamp = z.string().datetime({ offset: true });
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Expected credential-free HTTPS URL");
export const operations = z.enum([
  "feature.implement",
  "xray.test.create",
  "jira.test.link",
  "xray.execution.create",
  "xray.results.import",
  "git.commit",
  "git.push",
  "github.pr.create",
  "github.merge",
  "jira.update",
]);
export const inputSchema = z
  .object({
    schemaVersion: version,
    storyKey,
    repository: z.object({ namespace: text, root: text }).strict(),
    jira: z.object({ site: httpsUrl, context: text }).strict(),
    mode: z.enum([
      "assess",
      "plan",
      "implement",
      "validate",
      "publish",
      "deliver",
    ]),
    approvedScopeReference: text,
    sourceDigest: digest,
    sourceFiles: z
      .record(z.string().min(1), digest)
      .refine(
        (files) => Object.keys(files).length > 0,
        "Source manifest is required",
      ),
    environment: z.object({ name: text, isolated: z.literal(true) }).strict(),
    requiredQualityGates: texts,
    xray: z
      .object({
        projectKey: z.string().regex(/^[A-Z][A-Z0-9]*$/),
        apiBase: httpsUrl,
        executionGrouping: z.enum(["runner", "combined"]),
      })
      .strict(),
    previousRunId: safeId.optional(),
    approvalReferences: z.array(safeId),
  })
  .strict();
export const sourceSchema = z
  .object({
    schemaVersion: version,
    storyKey,
    issueId: text,
    retrievedAt: timestamp,
    contentDigest: digest,
    summary: text,
    description: text,
  })
  .strict();
export const requirementsSchema = z
  .object({
    schemaVersion: version,
    storyKey,
    sourceDigest: digest,
    requirements: z
      .array(z.object({ id: text, text, acceptanceIds: texts }).strict())
      .min(1),
    acceptanceCriteria: z.array(z.object({ id: text, text }).strict()).min(1),
    unresolvedQuestions: z.array(text),
  })
  .strict();
export const testLevel = z.enum(["unit", "api", "jsdom", "browser"]);
export const scenariosSchema = z
  .object({
    schemaVersion: version,
    storyKey,
    scenarios: z
      .array(
        z
          .object({
            id: text,
            requirementIds: texts,
            acceptanceIds: texts,
            kind: z.enum(["automated", "audit"]),
            levels: z.array(testLevel).min(1).optional(),
            preconditions: texts,
            actions: texts,
            expected: text,
          })
          .strict(),
      )
      .min(1),
    review: z.enum(["accepted", "changes-requested"]),
  })
  .strict();
export const bindingSchema = z
  .object({
    schemaVersion: version,
    framework: z.enum(["node:test", "playwright"]),
    projectName: text.optional(),
    testTitle: text,
    runnerIds: texts,
    sourceFiles: z
      .record(text, digest)
      .refine(
        (files) => Object.keys(files).length > 0,
        "Source files required",
      ),
    historicalExecutions: z
      .array(
        z
          .object({
            runId: safeId,
            artifactPath: text,
            artifactDigest: digest,
            runnerId: text,
            testTitle: text,
            projectName: text.optional(),
            outcome: z.literal("passed"),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const identitySchema = z
  .object({
    schemaVersion: version,
    repository: text,
    runner: z.enum(["node", "playwright"]),
    automationId: safeId,
    sourceLocation: text,
    parameterIdentity: text.optional(),
    behaviorDigest: digest,
    sourceDigest: digest,
    binding: bindingSchema.optional(),
    associations: z
      .array(
        z
          .object({
            storyKey,
            scenarioIds: texts,
            requirementIds: texts,
            acceptanceIds: texts,
          })
          .strict(),
      )
      .min(1),
    xray: z
      .object({
        key: storyKey,
        issueId: z.string().regex(/^[1-9][0-9]*$/),
        verifiedAt: timestamp,
        behaviorDigest: digest,
      })
      .strict()
      .optional(),
  })
  .strict();
export const traceabilitySchema = z
  .object({
    schemaVersion: version,
    storyKey,
    rows: z
      .array(
        z
          .object({
            requirementId: text,
            acceptanceId: text,
            scenarioId: text,
            automationIdentity: text.optional(),
            auditEvidence: text.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const coverageMapping = z
  .object({
    caseId: text,
    level: testLevel,
    automationIdentity: text,
    file: text,
    title: text,
    disposition: z.enum(["existing", "added"]),
    covers: z
      .array(z.object({ requirementId: text, acceptanceId: text }).strict())
      .min(1),
  })
  .strict();

const implementationContext = z
  .object({
    schemaVersion: version,
    storyKey,
    sourceDigest: digest,
    designDigest: digest,
  })
  .strict();
const fileDigests = z.record(text, digest);
export const featureImplementationSchema = implementationContext.extend({
  implementationFiles: fileDigests.refine(
    (files) => Object.keys(files).length > 0,
  ),
  developerTestFiles: fileDigests.refine(
    (files) => Object.keys(files).length > 0,
  ),
});
export const caseImplementationSchema = implementationContext.extend({
  files: fileDigests,
  mappings: z.array(coverageMapping),
  browserCases: z.array(text),
});
export const resultSchema = z
  .object({
    identity: text,
    runner: z.enum(["node", "playwright"]),
    outcome: z.enum(["passed", "failed", "skipped", "unknown"]),
    attempt: z.number().int().nonnegative(),
    durationMs: z.number().finite().nonnegative().optional(),
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    failures: z.array(z.string()),
    skipReason: z.string().optional(),
    evidence: texts,
    artifactDigest: digest,
  })
  .strict();
export const executionSchema = z
  .object({
    schemaVersion: version,
    storyKey,
    executionId: safeId,
    sourceDigest: digest,
    results: z.array(resultSchema).min(1),
    gates: z.array(
      z
        .object({
          name: text,
          exitCode: z.number().int(),
          command: text,
          evidence: text,
        })
        .strict(),
    ),
  })
  .strict();
export const approvalSchema = z
  .object({
    schemaVersion: version,
    id: safeId,
    operation: operations,
    target: text,
    payloadDigest: digest,
    evidenceDigest: digest,
    scope: texts,
    expiresAt: timestamp,
    decision: z.literal("approved"),
    humanReference: text,
  })
  .strict();
export const approvalRequestSchema = approvalSchema.omit({
  id: true,
  expiresAt: true,
  decision: true,
  humanReference: true,
});
export const trustedApprovalRequestSchema = approvalRequestSchema
  .extend({
    tenant: text,
    projectKey: z.string().regex(/^[A-Z][A-Z0-9]*$/),
    operationId: safeId,
    sourceDigest: digest,
    automationIdentity: text.optional(),
    testKey: storyKey.optional(),
  })
  .strict();
export const trustedApprovalReceiptSchema = z
  .object({
    schemaVersion: version,
    approvalId: safeId,
    consumptionId: safeId,
    authorityId: text,
    humanReference: text,
    decision: z.literal("approved"),
    issuedAt: timestamp,
    expiresAt: timestamp,
    consumedAt: timestamp,
    request: trustedApprovalRequestSchema,
    requestDigest: digest,
  })
  .strict();
export const proposalSchema = z
  .object({
    schemaVersion: version,
    storyKey,
    operation: operations,
    target: text,
    payloadDigest: digest,
    evidenceDigest: digest,
    payload: z.record(z.string(), z.unknown()),
    remoteWritesEnabled: z.literal(false),
  })
  .strict();
export const stages = [
  "DISCOVERED",
  "ANALYZED",
  "DESIGN_REVIEWED",
  "IMPLEMENTATION_AUTHORIZED",
  "IMPLEMENTED",
  "TESTS_IMPLEMENTED",
  "BROWSER_IMPLEMENTED",
  "AUTOMATION_REVIEWED",
  "VALIDATED",
  "LOCAL_READY",
  "XRAY_PROPOSED",
  "TESTS_VERIFIED",
  "LINKS_VERIFIED",
  "EXECUTION_VERIFIED",
  "RESULTS_VERIFIED",
  "DELIVERY_PROPOSED",
  "DELIVERY_VERIFIED",
] as const;
export const stageSchema = z.enum(stages);
export const roles = z.enum([
  "qa-orchestrator",
  "jira-story-agent",
  "requirements-analysis-agent",
  "test-design-agent",
  "feature-development-agent",
  "test-review-agent",
  "test-implementation-agent", // Retained for historical workflow evidence.
  "playwright-automation-agent",
  "test-execution-reporting-agent",
  "xray-test-publisher-agent",
  "github-integration-agent",
]);
export const stateSchema = z
  .object({
    schemaVersion: version,
    storyKey,
    runId: safeId,
    sequence: z.number().int().nonnegative(),
    stage: stageSchema,
    status: z.enum([
      "ACTIVE",
      "BLOCKED",
      "FAILED",
      "AWAITING_APPROVAL",
      "UNCERTAIN",
    ]),
    sourceDigest: digest,
    updatedAt: timestamp,
    reason: z.string().optional(),
    evidence: z.record(z.string(), z.object({ path: text, digest }).strict()),
    handoffs: z.array(
      z
        .object({
          role: roles,
          stage: stageSchema,
          at: timestamp,
          evidencePaths: texts,
        })
        .strict(),
    ),
  })
  .strict();
export const auditSchema = z
  .object({
    schemaVersion: version,
    id: safeId,
    at: timestamp,
    storyKey,
    runId: safeId,
    role: roles,
    action: text,
    inputDigest: digest,
    outputDigest: digest,
    outcome: text,
    approvalReference: safeId.optional(),
  })
  .strict();
export type WorkflowInput = z.infer<typeof inputSchema>;
export type WorkflowState = z.infer<typeof stateSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Result = z.infer<typeof resultSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
