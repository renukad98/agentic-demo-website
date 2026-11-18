import { objectDigest } from "../agentic/artifacts.js";
import type { XrayReadClient } from "./clients/index.js";
import { IdentityRegistry, identityKey, verifyBinding } from "./identity.js";
import type { OperationJournal } from "./operation-journal.js";
import { executionProposal } from "./planner.js";
import { publicationRequest } from "./publication-transport.js";

const tenant = "renudhamankar98.atlassian.net";
const projectKey = "KAN";
const story = "KAN-25";
const testKey = "KAN-26";
const testId = "10066";
const linkId = "10010";
const operation = "xray.execution.create";

type Entries = Awaited<ReturnType<OperationJournal["latestEntries"]>>;
export type ExecutionRead = Pick<
  XrayReadClient,
  "getTest" | "getCoverage" | "searchExecutions" | "getExecutionSnapshot"
>;

export async function prepareLocalExecution(
  root: string,
  entries: Entries,
  read: ExecutionRead,
) {
  const scope = entries.filter(
    (entry) =>
      entry.tenant === tenant &&
      entry.projectKey === projectKey &&
      entry.storyKey === story,
  );
  if (scope.some((entry) => entry.operation === operation))
    throw new Error("CHECKPOINT_C_ALREADY_JOURNALED");
  const confirmed = (
    kind: "xray.test.create" | "jira.test.link",
    id: string,
  ) => {
    const matches = scope.filter(
      (entry) =>
        entry.operation === kind &&
        entry.status === "Confirmed" &&
        entry.remoteTestKey === testKey &&
        entry.remoteIds.length === 1 &&
        entry.remoteIds[0] === id,
    );
    if (matches.length !== 1)
      throw new Error("CONFIRMED_CHECKPOINTS_A_AND_B_REQUIRED");
    return matches[0]!;
  };
  const a = confirmed("xray.test.create", testId),
    b = confirmed("jira.test.link", linkId);
  const registry = await IdentityRegistry.load(
    root,
    "artifacts/qa/automation-identities/registry-v1.json",
  );
  const identity = registry
    .list()
    .find((item) => identityKey(item) === a.automationIdentity);
  if (
    !identity?.binding?.projectName ||
    b.automationIdentity !== a.automationIdentity ||
    (identity.xray &&
      (identity.xray.key !== testKey || identity.xray.issueId !== testId))
  )
    throw new Error("CHECKPOINT_IDENTITY_MISMATCH");
  const binding = await verifyBinding(root, identity);
  if (
    [a, b].some(
      (entry) =>
        entry.sourceDigest !== binding.sourceDigest ||
        entry.evidenceDigest !== binding.evidenceDigest,
    )
  )
    throw new Error("CHECKPOINT_EVIDENCE_CHANGED");
  const [test, coverage, executions] = await Promise.all([
    read.getTest(testId),
    read.getCoverage(testId),
    read.searchExecutions(projectKey),
  ]);
  if (
    test?.issueId !== testId ||
    test.jira.key !== testKey ||
    test.testType.name !== "Generic" ||
    test.unstructured !== a.automationIdentity ||
    !coverage.some(
      (item) => item.issueId === "10065" && item.jira.key === story,
    )
  )
    throw new Error("TEST_IDENTITY_OR_COVERAGE_CHANGED");
  const proposal = executionProposal(
    story,
    projectKey,
    [
      {
        ...identity,
        xray: {
          key: testKey,
          issueId: testId,
          behaviorDigest: identity.behaviorDigest,
          verifiedAt: a.at,
        },
      },
    ],
    identity.binding.projectName,
    binding.evidenceDigest,
    {
      projectId: "10001",
      issueTypeId: "10046",
      reporter: { accountId: "712020:a8fac447-b5f9-4da3-a23a-bb24d61b4baa" },
    },
  );
  const wire = publicationRequest(proposal);
  if (wire.operation !== operation)
    throw new Error("INVALID_EXECUTION_PROPOSAL");
  // The canonical summary is the duplicate key even if an earlier execution has different membership.
  if (
    executions.some(
      (item) =>
        !item.jira.summary ||
        item.jira.summary.trim().toLowerCase() ===
          wire.body.variables.jira.fields.summary.toLowerCase(),
    )
  )
    throw new Error("MATCHING_OR_UNVERIFIABLE_EXECUTION_EXISTS");
  for (const item of executions) {
    const snapshot = await read.getExecutionSnapshot(item.issueId);
    if (
      !snapshot ||
      snapshot.issueId !== item.issueId ||
      snapshot.projectId !== "10001" ||
      snapshot.jira.key !== item.jira.key ||
      snapshot.jira.summary !== item.jira.summary
    )
      throw new Error("EXECUTION_INVENTORY_CHANGED");
    if (
      snapshot.tests.total === 1 &&
      snapshot.tests.results[0]?.issueId === testId &&
      snapshot.testEnvironments.length === 1 &&
      snapshot.testEnvironments[0] === identity.binding.projectName
    )
      throw new Error("POSSIBLE_RENAMED_EXECUTION: " + item.jira.key);
  }
  const review = {
    operation,
    tenant,
    projectKey,
    story,
    testKey,
    testId,
    linkId,
    automationIdentity: a.automationIdentity,
    ...binding,
    request: {
      method: "POST",
      origin: "https://xray.cloud.getxray.app",
      path: wire.path,
      body: wire.body,
    },
  };
  return { proposal, review: { ...review, fingerprint: objectDigest(review) } };
}

export async function previewLocalExecution(
  root: string,
  entries: Entries,
  read: ExecutionRead,
) {
  return (await prepareLocalExecution(root, entries, read)).review;
}
