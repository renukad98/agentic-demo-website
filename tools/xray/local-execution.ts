import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApprovalEvidenceGate } from "../agentic/approvals.js";
import { objectDigest } from "../agentic/artifacts.js";
import type { JournalReservationRequest } from "../agentic/journal-reservation.js";
import type { TokenProvider } from "./clients/authentication.js";
import {
  prepareLocalExecution,
  type ExecutionRead,
} from "./local-execution-preview.js";
import type { OperationJournal } from "./operation-journal.js";
import { verifyExecutionMembership } from "./publication-readback.js";
import { XrayPublicationTransport } from "./publication-transport.js";
import { writeOperationId } from "./write-integration.js";

const origin = "https://xray.cloud.getxray.app";
const operation = "xray.execution.create";
const summary = "Automated validation for KAN-25";
const executionIdentity = z.object({
  issueId: z.string().regex(/^[1-9][0-9]*$/),
  jira: z.object({ key: z.string().regex(/^KAN-[1-9][0-9]*$/) }),
});
const creationResponse = z.object({
  data: z.object({
    createTestExecution: z.object({
      testExecution: executionIdentity,
      warnings: z.array(z.unknown()).nullish(),
    }),
  }),
});
type Snapshot = Awaited<ReturnType<ExecutionRead["getExecutionSnapshot"]>>;
function verifiesExecution(snapshot: Snapshot, issueId: string, key: string) {
  if (
    !snapshot ||
    snapshot.projectId !== "10001" ||
    snapshot.jira.summary !== summary ||
    snapshot.testEnvironments.length !== 1 ||
    snapshot.testEnvironments[0] !== "chromium"
  )
    return false;
  try {
    return verifyExecutionMembership(
      { issueId, key, testIssueIds: ["10066"] },
      [snapshot],
    );
  } catch {
    return false;
  }
}

export async function reconcileLocalExecution(
  journal: OperationJournal,
  read: ExecutionRead,
) {
  const entries = (await journal.latestEntries()).filter(
    (entry) =>
      entry.operation === operation &&
      entry.tenant === "renudhamankar98.atlassian.net" &&
      entry.projectKey === "KAN" &&
      entry.storyKey === "KAN-25" &&
      entry.remoteTestKey === "KAN-26",
  );
  if (!entries.length) return { status: "NO_EXECUTION_ATTEMPT" };
  if (entries.length !== 1) return { status: "RECONCILIATION_REQUIRED" };
  const [prior] = entries;
  if (!prior || !["Attempted", "Uncertain"].includes(prior.status))
    return { status: "ALREADY_JOURNALED" };
  const candidates =
    prior.remoteIds.length === 1 && prior.remoteExecutionKey
      ? [
          {
            issueId: prior.remoteIds[0]!,
            jira: { key: prior.remoteExecutionKey },
          },
        ]
      : (await read.searchExecutions("KAN")).filter(
          (entry) =>
            entry.jira.summary?.trim().toLowerCase() === summary.toLowerCase(),
        );
  const candidate = executionIdentity.safeParse(candidates[0]);
  if (candidates.length !== 1 || !candidate.success)
    return {
      status: "RECONCILIATION_REQUIRED",
      matchingSummaries: candidates.length,
    };
  const {
    issueId,
    jira: { key },
  } = candidate.data;
  const snapshot = await read.getExecutionSnapshot(issueId);
  const created = Date.parse(snapshot?.jira.created ?? "");
  const attempt = (await journal.entries(prior.operationId)).find(
    (entry) => entry.status === "Attempted",
  );
  // Without a returned ID, accept only a unique, matching execution created after our attempt.
  if (
    !verifiesExecution(snapshot, issueId, key) ||
    (!prior.remoteIds.length &&
      (!attempt ||
        !Number.isFinite(created) ||
        created < Date.parse(attempt.at)))
  )
    return { status: "RECONCILIATION_REQUIRED", candidate: key };
  const at = new Date().toISOString();
  if (prior.status === "Attempted")
    await journal.record({
      ...prior,
      status: "Uncertain",
      reconciliation: "pending",
      at,
    });
  await journal.record({
    ...prior,
    status: "Reconciled",
    reconciliation: "confirmed",
    at,
    remoteIds: [issueId],
    remoteExecutionKey: key,
    reconciliationEvidenceDigest: objectDigest(snapshot),
  });
  return { status: "RECONCILED", key, issueId };
}

type Ports = {
  fetch: typeof fetch;
  tokens: TokenProvider;
  read: ExecutionRead;
  confirm: (display: string) => Promise<string>;
  now?: () => number;
};

export async function runLocalExecution(
  root: string,
  journal: OperationJournal,
  ports: Ports,
) {
  if (
    ports.fetch === globalThis.fetch &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const now = ports.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  const { proposal, review } = await prepareLocalExecution(
    root,
    await journal.latestEntries(),
    ports.read,
  );
  const deadline = now() + 120_000;
  const answer = await ports.confirm(JSON.stringify(review, null, 2));
  if (answer !== "APPROVE " + review.fingerprint || now() >= deadline)
    throw new Error("LOCAL_APPROVAL_DENIED_OR_EXPIRED");
  const issuedAt = at();
  const fresh = await prepareLocalExecution(
    root,
    await journal.latestEntries(),
    ports.read,
  );
  if (fresh.review.fingerprint !== review.fingerprint)
    throw new Error("LOCAL_APPROVAL_STALE");
  const {
    tenant,
    projectKey,
    story: target,
    testKey,
    testId: testIssueId,
    automationIdentity,
    sourceDigest,
    evidenceDigest,
  } = review;
  if (!automationIdentity) throw new Error("EXECUTION_IDENTITY_REQUIRED");
  const payloadDigest = proposal.payloadDigest;
  const request: JournalReservationRequest = {
    schemaVersion: "1.0.0",
    tenant,
    projectKey,
    target,
    testKey,
    testIssueId,
    operation,
    automationIdentity,
    sourceDigest,
    evidenceDigest,
    payloadDigest,
    scope: [operation],
    operationId: writeOperationId({
      tenant,
      projectKey,
      operation,
      payloadDigest,
    }),
    preflightDigest: review.fingerprint,
    executorPrincipal: "windows-local-demo",
    authorityEpoch: "local-demo-v1",
    policyVersion: "json-offline-v1",
  };
  const approvalId = randomUUID(),
    digest = objectDigest(request);
  const gate = new ApprovalEvidenceGate({
    async verify(reference, _, requestDigest) {
      if (
        reference !== approvalId ||
        requestDigest !== digest ||
        now() >= deadline
      )
        throw new Error("LOCAL_APPROVAL_DENIED_OR_EXPIRED");
      return {
        schemaVersion: "1.0.0",
        approvalId,
        requestDigest,
        decision: "approved",
        authorityId: "windows-local-demo",
        humanReference: "interactive-terminal",
        issuedAt,
        expiresAt: new Date(deadline).toISOString(),
      };
    },
  });
  const handle = await gate.verify(approvalId, request);
  const reservation = await journal.consumeAndReserve(
    request,
    proposal.payload,
    handle,
  );
  const attempted = {
    ...reservation.entry,
    status: "Attempted" as const,
    at: at(),
  };
  const ticket = await journal.record(attempted, request);
  if (!ticket) throw new Error("LOCAL_EXECUTION_ATTEMPT_REQUIRED");
  let observed: z.infer<typeof executionIdentity> | undefined;
  try {
    const response = creationResponse.parse(
      await new XrayPublicationTransport(origin).executeLocalExecution(
        proposal,
        ports,
        ticket,
      ),
    );
    observed = response.data.createTestExecution.testExecution;
    const {
      issueId,
      jira: { key },
    } = observed;
    if (
      response.data.createTestExecution.warnings?.length ||
      !verifiesExecution(
        await ports.read.getExecutionSnapshot(issueId),
        issueId,
        key,
      )
    )
      throw new Error("EXECUTION_READBACK_UNCERTAIN");
    await journal.record({
      ...attempted,
      status: "Confirmed",
      remoteIds: [issueId],
      remoteExecutionKey: key,
      at: at(),
    });
    return { status: "CONFIRMED", key, issueId };
  } catch {
    await journal.record({
      ...attempted,
      status: "Uncertain",
      reconciliation: "pending",
      errorCode: "TRANSPORT",
      at: at(),
      ...(observed
        ? {
            remoteIds: [observed.issueId],
            remoteExecutionKey: observed.jira.key,
          }
        : {}),
    });
    return { status: "UNCERTAIN_RUN_RECONCILE_EXECUTION" };
  }
}
