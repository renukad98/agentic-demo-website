import assert from "node:assert/strict";
import test from "node:test";
import { localLinkPreview } from "../../tools/xray/local-link-preview.js";

const creation = {
  schemaVersion: "1.0.0",
  tenant: "renudhamankar98.atlassian.net",
  projectKey: "KAN",
  storyKey: "KAN-25",
  operation: "xray.test.create",
  automationIdentity:
    "agentic-demo-website:playwright:task-create-inflight-single-submit-v1",
  status: "Confirmed",
  remoteTestKey: "KAN-26",
  remoteIds: ["10066"],
  operationId: "operation-a",
  payloadDigest: "sha256:" + "1".repeat(64),
  evidenceDigest: "sha256:" + "2".repeat(64),
  at: "2026-11-18T00:00:00.000Z",
} as const;
const entry = { ...creation, remoteIds: [...creation.remoteIds] };

test("Checkpoint B preview reproduces the reviewed operation and direction", () => {
  const result = localLinkPreview([entry]);
  assert.deepEqual(result.request, {
    name: "createJiraIssueLink",
    cloudId: "renudhamankar98.atlassian.net",
    inputs: { linkType: "Test", inwardIssue: "KAN-26", outwardIssue: "KAN-25" },
  });
  assert.equal(
    result.fingerprint,
    "sha256:4a2bc28365f2918a1050e005362d8823c49e705c3f96d369b8b8ac7ff7e0747e",
  );
});

test("Checkpoint B preview blocks missing, uncertain or mismatched creation", () => {
  for (const entries of [
    [],
    [{ ...entry, status: "Attempted" as const }],
    [{ ...entry, remoteIds: ["10067"] }],
  ])
    assert.throws(
      () => localLinkPreview(entries),
      /CHECKPOINT_A_CONFIRMATION_REQUIRED/,
    );
});

test("Checkpoint B preview blocks an already journaled link attempt", () => {
  assert.throws(
    () =>
      localLinkPreview([
        entry,
        {
          ...entry,
          operationId: "operation-b",
          operation: "jira.test.link",
          status: "Attempted",
        },
      ]),
    /CHECKPOINT_B_ALREADY_JOURNALED/,
  );
});
