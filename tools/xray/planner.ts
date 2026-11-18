import {
  identitySchema,
  proposalSchema,
  resultSchema,
  storyKey,
  type Identity,
  type Result,
} from "../agentic/contracts/index.js";
import { objectDigest } from "../agentic/artifacts.js";
import {
  identityKey,
  validateBinding,
  bindingEvidenceDigest,
  verifyBinding,
} from "./identity.js";
import { z } from "zod";
import type {
  TrustedApprovalGate,
  TrustedApprovalRequest,
} from "../agentic/approvals.js";

const jiraId = z.string().regex(/^[1-9][0-9]*$/);
export const reporterSchema = z
  .object({
    accountId: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]+$/)
      .refine(
        (id) =>
          !/(?:^|[_:-])(?:unknown|pending|unresolved)(?:[_:-]|$)/i.test(id),
        "Confirmed explicit accountId input required",
      ),
  })
  .strict();
export const genericCreationSchema = z
  .object({ projectId: jiraId, issueTypeId: jiraId, reporter: reporterSchema })
  .strict();
export type GenericCreation = z.infer<typeof genericCreationSchema>;
export const genericVariablesSchema = z
  .object({
    testType: z.object({ name: z.literal("Generic") }).strict(),
    unstructured: z.string().min(1),
    jira: z
      .object({
        fields: z
          .object({
            project: z
              .object({ id: jiraId, key: z.string().regex(/^[A-Z][A-Z0-9]*$/) })
              .strict(),
            issuetype: z.object({ id: jiraId }).strict(),
            summary: z.string().trim().min(1).max(255),
            description: z.string().min(1),
            reporter: reporterSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const genericTestMutation = `mutation ProposedGenericTest($testType: UpdateTestTypeInput!, $unstructured: String!, $jira: JSON!) {
  createTest(testType: $testType, unstructured: $unstructured, jira: $jira) {
    test { issueId testType { name } unstructured jira(fields: ["key", "project", "issuetype", "summary", "description", "reporter"]) }
    warnings
  }
}`;
export const executionTestMutation = `mutation ProposedTestExecution($testIssueIds: [String], $testEnvironments: [String], $jira: JSON!) {
  createTestExecution(testIssueIds: $testIssueIds, testEnvironments: $testEnvironments, jira: $jira) {
    testExecution { issueId jira(fields: ["key", "project", "issuetype", "reporter", "summary"]) }
    warnings
  }
}`;

export interface Candidate {
  key: string;
  issueId: string;
  identity: string;
  behaviorDigest: string;
  type: string;
}
export function duplicateDecision(
  raw: Identity,
  candidates: Candidate[],
  complete: boolean,
) {
  const identity = identitySchema.parse(raw);
  if (!complete) throw new Error("Incomplete duplicate search");
  const matches = candidates.filter(
    (candidate) => candidate.identity === identityKey(identity),
  );
  if (!matches.length) return { disposition: "new" as const };
  if (
    matches.length !== 1 ||
    matches[0]!.type !== "Generic" ||
    matches[0]!.behaviorDigest !== identity.behaviorDigest
  )
    throw new Error("Ambiguous duplicate; human review required");
  storyKey.parse(matches[0]!.key);
  if (!/^[1-9][0-9]*$/.test(matches[0]!.issueId))
    throw new Error("Invalid candidate issue ID");
  return { disposition: "reuse" as const, candidate: matches[0]! };
}
function envelope(
  key: string,
  operation: ReturnType<typeof proposalSchema.parse>["operation"],
  payload: Record<string, unknown>,
  evidenceDigest: string,
) {
  return proposalSchema.parse({
    schemaVersion: "1.0.0",
    storyKey: storyKey.parse(key),
    operation,
    target: key,
    payloadDigest: objectDigest(payload),
    evidenceDigest,
    payload,
    remoteWritesEnabled: false,
  });
}
export function genericProposal(
  key: string,
  project: string,
  raw: Identity,
  summary: string,
  creation?: GenericCreation,
) {
  const identity = identitySchema.parse(raw);
  validateBinding(identity);
  const requiredFields = genericCreationSchema.safeParse(creation);
  if (!requiredFields.success)
    throw new Error(
      "Missing or invalid required Jira creation fields, including explicit Reporter accountId",
    );
  const payload = genericPayload(
    key,
    project,
    identity,
    summary,
    requiredFields.data,
  );
  genericVariablesSchema.parse(payload.variables);
  return envelope(
    key,
    "xray.test.create",
    payload,
    bindingEvidenceDigest(identity),
  );
}
function genericPayload(
  key: string,
  project: string,
  identity: Identity,
  summary: string,
  creation: {
    projectId: string | null;
    issueTypeId: string | null;
    reporter: GenericCreation["reporter"] | null;
  },
) {
  const binding = validateBinding(identity);
  if (!/^[A-Z][A-Z0-9]*$/.test(project) || !summary.trim())
    throw new Error("Invalid Test destination/summary");
  if (!identity.associations.some((a) => a.storyKey === key))
    throw new Error("Identity is not associated with Story");
  const association = identity.associations.find(
    (association) => association.storyKey === key,
  )!;
  return {
    mutation: "createTest",
    query: genericTestMutation,
    variables: {
      testType: { name: "Generic" },
      unstructured: identityKey(identity),
      jira: {
        fields: {
          project: { key: project, id: creation.projectId },
          issuetype: { id: creation.issueTypeId },
          reporter: creation.reporter,
          summary,
          description: [
            `Repository: ${identity.repository}`,
            `Automation: ${identityKey(identity)}`,
            `Stable automation ID: ${identity.automationId}`,
            `Framework: ${binding.framework}; project: ${binding.projectName ?? "not applicable"}`,
            `Source: ${identity.sourceLocation}`,
            `Test: ${binding.testTitle}`,
            `Story association: ${key}`,
            `Requirements: ${association.requirementIds.join(", ")}`,
            `Acceptance criteria: ${association.acceptanceIds.join(", ")}`,
            `Scenarios: ${association.scenarioIds.join(", ")}`,
            `Behavior digest: ${identity.behaviorDigest}`,
            `Source digest: ${identity.sourceDigest}`,
            `Evidence digest: ${bindingEvidenceDigest(identity)}`,
            ...binding.historicalExecutions.map(
              (run) =>
                `Historical pass (not a new execution): ${run.runId}; ${run.artifactPath}; ${run.artifactDigest}; runner ID ${run.runnerId}`,
            ),
          ].join("\n"),
        },
      },
    },
  };
}
export async function genericProposalPreview(
  root: string,
  key: string,
  project: string,
  raw: Identity,
  summary: string,
  creation: unknown,
) {
  const identity = identitySchema.parse(raw);
  const proof = await verifyBinding(root, identity);
  const required = genericCreationSchema.safeParse(creation);
  if (required.success)
    return {
      status: "READY_LOCALLY" as const,
      approvableStructure: true,
      proposal: genericProposal(key, project, identity, summary, required.data),
      ...proof,
    };
  const partial =
    creation && typeof creation === "object"
      ? (creation as Record<string, unknown>)
      : {};
  const projectId = jiraId.safeParse(partial.projectId);
  const issueTypeId = jiraId.safeParse(partial.issueTypeId);
  const reporter = reporterSchema.safeParse(partial.reporter);
  const payload = genericPayload(key, project, identity, summary, {
    projectId: projectId.success ? projectId.data : null,
    issueTypeId: issueTypeId.success ? issueTypeId.data : null,
    reporter: reporter.success ? reporter.data : null,
  });
  return {
    status: "BLOCKED" as const,
    approvableStructure: false,
    blockers: required.error.issues.map((issue) => issue.path.join(".")),
    previewPayload: payload,
    previewDigest: objectDigest(payload),
    payloadDigest: null,
    ...proof,
    note: "Preview digest is not an executable payload approval digest; required fields remain unresolved",
  };
}
export async function consumeGenericProposalApproval(
  root: string,
  identity: Identity,
  rawProposal: unknown,
  request: TrustedApprovalRequest,
  reference: string,
  gate: TrustedApprovalGate,
) {
  const proposal = proposalSchema.parse(rawProposal);
  const proof = await verifyBinding(root, identity);
  const variables = genericVariablesSchema.parse(proposal.payload.variables);
  const expected = genericProposal(
    proposal.storyKey,
    variables.jira.fields.project.key,
    identity,
    variables.jira.fields.summary,
    {
      projectId: variables.jira.fields.project.id,
      issueTypeId: variables.jira.fields.issuetype.id,
      reporter: variables.jira.fields.reporter,
    },
  );
  if (
    proposal.operation !== "xray.test.create" ||
    proposal.target !== proposal.storyKey ||
    request.operation !== proposal.operation ||
    request.target !== proposal.target ||
    request.projectKey !== variables.jira.fields.project.key ||
    request.sourceDigest !== proof.sourceDigest ||
    request.evidenceDigest !== proof.evidenceDigest ||
    proposal.evidenceDigest !== proof.evidenceDigest ||
    proposal.payloadDigest !== objectDigest(proposal.payload) ||
    proposal.payloadDigest !== expected.payloadDigest ||
    request.payloadDigest !== proposal.payloadDigest
  )
    throw new Error("Fresh Generic proposal approval binding mismatch");
  return gate.consume(reference, request, proposal.payload); // No mutation transport is invoked.
}
export function linkProposal(
  key: string,
  testKey: string,
  linkType: { id: string; name: string; inward: string; outward: string },
  evidenceDigest: string,
) {
  storyKey.parse(testKey);
  return envelope(
    key,
    "jira.test.link",
    linkPayload(key, testKey, linkType),
    evidenceDigest,
  );
}
function linkPayload(
  key: string,
  testKey: string | null,
  linkType: { id: string; name: string; inward: string; outward: string },
) {
  storyKey.parse(key);
  if (
    !linkType.id ||
    linkType.name !== "Test" ||
    linkType.inward !== "is tested by" ||
    linkType.outward !== "tests"
  )
    throw new Error("Unverified coverage link metadata");
  // Jira outward wording is read from the Test: Test tests Story.
  return {
    type: { id: linkType.id },
    inwardIssue: { key: testKey },
    outwardIssue: { key },
  };
}
export function pendingLinkProposal(
  key: string,
  linkType: { id: string; name: string; inward: string; outward: string },
  evidenceDigest: string,
) {
  const previewPayload = linkPayload(key, null, linkType);
  return {
    status: "BLOCKED" as const,
    operation: "jira.test.link",
    target: key,
    blockers: ["Future verified Test key required"],
    previewPayload,
    previewDigest: objectDigest(previewPayload),
    payloadDigest: null,
    evidenceDigest,
    remoteWritesEnabled: false,
  };
}
export function executionProposal(
  key: string,
  project: string,
  identities: Identity[],
  environment: string,
  evidenceDigest: string,
  creation?: GenericCreation,
) {
  if (
    !identities.length ||
    !environment.trim() ||
    !/^[A-Z][A-Z0-9]*$/.test(project)
  )
    throw new Error("Invalid execution proposal");
  if (
    identities.some(
      (identity) => !identity.associations.some((a) => a.storyKey === key),
    )
  )
    throw new Error("Test not associated with selected Story");
  const ids = identities.map((identity) => verified(identity).issueId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate Tests in execution");
  const fields = creation ? genericCreationSchema.parse(creation) : undefined;
  return envelope(
    key,
    "xray.execution.create",
    {
      mutation: "createTestExecution",
      ...(fields ? { query: executionTestMutation } : {}),
      variables: {
        testIssueIds: ids,
        testEnvironments: [environment],
        jira: {
          fields: {
            project: {
              key: project,
              ...(fields ? { id: fields.projectId } : {}),
            },
            ...(fields
              ? {
                  issuetype: { id: fields.issueTypeId },
                  reporter: fields.reporter,
                }
              : {}),
            summary: `Automated validation for ${key}`,
          },
        },
      },
    },
    evidenceDigest,
  );
}
function verified(raw: Identity) {
  const identity = identitySchema.parse(raw);
  if (
    !identity.xray ||
    identity.xray.behaviorDigest !== identity.behaviorDigest
  )
    throw new Error("Previously verified Xray mapping required");
  return identity.xray;
}
export function importProposal(
  key: string,
  executionKey: string,
  rawResults: Result[],
  identities: Identity[],
  evidenceDigest: string,
) {
  storyKey.parse(executionKey);
  if (!rawResults.length) throw new Error("Empty automated results");
  const registry = new Map(identities.map((i) => [identityKey(i), i]));
  const seen = new Set<string>();
  const tests = rawResults.map((raw) => {
    const result = resultSchema.parse(raw);
    if (seen.has(result.identity))
      throw new Error(
        "Multiple attempts require explicit review/grouping; refusing to hide retries",
      );
    seen.add(result.identity);
    if (result.outcome === "unknown" || result.outcome === "skipped")
      throw new Error(
        "Unknown/skipped status requires tenant-specific mapping",
      );
    const identity = registry.get(result.identity);
    if (!identity || !identity.associations.some((a) => a.storyKey === key))
      throw new Error("Unmapped Story result");
    return {
      testKey: verified(identity).key,
      status: result.outcome === "passed" ? "PASSED" : "FAILED",
      ...(result.startedAt ? { start: result.startedAt } : {}),
      ...(result.finishedAt ? { finish: result.finishedAt } : {}),
      comment: `Automated ${result.runner}; attempt ${result.attempt}; artifact ${result.artifactDigest}; durationMs ${result.durationMs ?? "unknown"}\n${result.failures.join("\n")}`,
    };
  });
  if (new Set(tests.map((t) => t.testKey)).size !== tests.length)
    throw new Error("Multiple identities map to the same Xray Test");
  return envelope(
    key,
    "xray.results.import",
    {
      endpoint: "/api/v2/import/execution",
      body: { testExecutionKey: executionKey, tests },
    },
    evidenceDigest,
  );
}
