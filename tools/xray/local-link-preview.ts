import { objectDigest } from "../agentic/artifacts.js";
import type { OperationJournal } from "./operation-journal.js";
import { linkProposal } from "./planner.js";
import { publicationRequest } from "./publication-transport.js";
import { localLinkTargets, type LocalLinkTarget } from "./local-link-target.js";

const tenant = "renudhamankar98.atlassian.net";
const linkType = {
  id: "10037",
  name: "Test",
  inward: "is tested by",
  outward: "tests",
};
type JournalEntry = Awaited<
  ReturnType<OperationJournal["latestEntries"]>
>[number];

export function localLinkPreview(
  entries: readonly JournalEntry[],
  testKey: LocalLinkTarget = "KAN-26",
) {
  const target = localLinkTargets[testKey];
  const matching = entries.filter(
    (entry) =>
      entry.tenant === tenant &&
      entry.projectKey === "KAN" &&
      entry.storyKey === target.story &&
      entry.operation === "xray.test.create" &&
      entry.automationIdentity === target.identity,
  );
  const [creation] = matching;
  if (
    matching.length !== 1 ||
    !creation ||
    creation.status !== "Confirmed" ||
    creation.remoteTestKey !== testKey ||
    creation.remoteIds.length !== 1 ||
    creation.remoteIds[0] !== target.issueId ||
    !creation.evidenceDigest
  )
    throw new Error("CHECKPOINT_A_CONFIRMATION_REQUIRED");
  if (
    entries.some(
      (entry) =>
        entry.tenant === tenant &&
        entry.projectKey === "KAN" &&
        entry.storyKey === target.story &&
        entry.operation === "jira.test.link" &&
        (entry.remoteTestKey === testKey || !entry.remoteTestKey),
    )
  )
    throw new Error("CHECKPOINT_B_ALREADY_JOURNALED");
  const proposal = linkProposal(
    target.story,
    creation.remoteTestKey,
    linkType,
    creation.evidenceDigest,
  );
  const wire = publicationRequest(proposal);
  if (wire.operation !== "jira.test.link")
    throw new Error("INVALID_LINK_PREVIEW");
  const review = {
    operation: wire.operation,
    linkTypeId: wire.body.type.id,
    testIssueId: creation.remoteIds[0],
    request: {
      name: "createJiraIssueLink",
      cloudId: tenant,
      inputs: {
        linkType: linkType.name,
        inwardIssue: wire.body.inwardIssue.key,
        outwardIssue: wire.body.outwardIssue.key,
      },
    },
  };
  return { ...review, fingerprint: objectDigest(review) };
}
