import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApprovalEvidenceGate } from "../agentic/approvals.js";
import { objectDigest } from "../agentic/artifacts.js";
import type { JournalReservationRequest } from "../agentic/journal-reservation.js";
import type { TokenProvider } from "./clients/authentication.js";
import { prepareLocalImport, type ImportRead } from "./local-import-preview.js";
import type { OperationJournal } from "./operation-journal.js";
import { XrayPublicationTransport } from "./publication-transport.js";
import { writeOperationId } from "./write-integration.js";

const operation = "xray.results.import";
const importResponse = z.object({
  id: z.literal("10067"),
  key: z.literal("KAN-27"),
  error: z.never().optional(),
  warnings: z.array(z.unknown()).length(0).optional(),
});
type PreparedImport = Awaited<ReturnType<typeof prepareLocalImport>>;

function matchesImportedRun(verified: PreparedImport) {
  const expected = verified.review.request.body.tests[0];
  const { target } = verified;
  return Boolean(
    expected?.start &&
    expected.finish &&
    target.status.name === expected.status &&
    target.startedOn &&
    target.finishedOn &&
    Date.parse(target.startedOn) === Date.parse(expected.start) &&
    Date.parse(target.finishedOn) === Date.parse(expected.finish) &&
    (target.comment === expected.comment ||
      (expected.comment.endsWith("\n") &&
        target.comment === expected.comment.slice(0, -1))) &&
    target.evidence?.length === 0,
  );
}

export async function reconcileLocalImport(
  root: string,
  journal: OperationJournal,
  read: ImportRead,
) {
  const entries = await journal.latestEntries();
  const imports = entries.filter(
    (entry) =>
      entry.operation === operation &&
      entry.tenant === "renudhamankar98.atlassian.net" &&
      entry.projectKey === "KAN" &&
      entry.storyKey === "KAN-25",
  );
  if (!imports.length) return { status: "NO_IMPORT_ATTEMPT" };
  const [prior] = imports;
  if (
    imports.length !== 1 ||
    !prior ||
    prior.remoteTestKey !== "KAN-26" ||
    prior.remoteExecutionKey !== "KAN-27"
  )
    return { status: "RECONCILIATION_REQUIRED" };
  if (!["Attempted", "Uncertain"].includes(prior.status))
    return { status: "ALREADY_JOURNALED" };
  const verified = await prepareLocalImport(root, entries, read, "verify");
  if (
    prior.payloadDigest !== verified.proposal.payloadDigest ||
    (await journal.reservationFingerprint(prior.operationId)) !==
      verified.review.fingerprint ||
    !matchesImportedRun(verified)
  )
    return { status: "RECONCILIATION_REQUIRED" };
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
    remoteIds: [verified.target.id],
    reconciliationEvidenceDigest: objectDigest(verified.target),
  });
  return {
    status: "RECONCILED",
    testRunId: verified.target.id,
    testExecutionKey: "KAN-27",
    testKey: "KAN-26",
  };
}

type Ports = {
  fetch: typeof fetch;
  tokens: TokenProvider;
  read: ImportRead;
  confirm: (display: string) => Promise<string>;
  now?: () => number;
};

export async function runLocalImport(
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
  const { proposal, review } = await prepareLocalImport(
    root,
    await journal.latestEntries(),
    ports.read,
  );
  const deadline = now() + 120_000;
  const answer = await ports.confirm(JSON.stringify(review, null, 2));
  if (answer !== "APPROVE " + review.fingerprint || now() >= deadline)
    throw new Error("LOCAL_APPROVAL_DENIED_OR_EXPIRED");
  const issuedAt = at();
  const fresh = await prepareLocalImport(
    root,
    await journal.latestEntries(),
    ports.read,
  );
  if (fresh.review.fingerprint !== review.fingerprint)
    throw new Error("LOCAL_APPROVAL_STALE");
  const {
    tenant,
    story: target,
    testKey,
    testId: testIssueId,
    executionKey,
    executionId: executionIssueId,
    automationIdentity,
    sourceDigest,
    evidenceDigest,
  } = review;
  const payloadDigest = proposal.payloadDigest;
  const projectKey = "KAN";
  const request: JournalReservationRequest = {
    schemaVersion: "1.0.0",
    tenant,
    projectKey,
    target,
    testKey,
    testIssueId,
    executionKey,
    executionIssueId,
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
  if (!ticket) throw new Error("LOCAL_IMPORT_ATTEMPT_REQUIRED");
  try {
    importResponse.parse(
      await new XrayPublicationTransport(
        review.request.origin,
      ).executeLocalImport(proposal, ports, ticket),
    );
    const verified = await prepareLocalImport(
      root,
      await journal.latestEntries(),
      ports.read,
      "verify",
    );
    if (
      verified.review.fingerprint !== review.fingerprint ||
      !matchesImportedRun(verified)
    )
      throw new Error("IMPORT_READBACK_UNCERTAIN");
    await journal.record({
      ...attempted,
      status: "Confirmed",
      remoteIds: [verified.target.id],
      at: at(),
    });
    return {
      status: "CONFIRMED",
      testRunId: verified.target.id,
      testExecutionKey: executionKey,
      testKey,
    };
  } catch {
    await journal.record({
      ...attempted,
      status: "Uncertain",
      reconciliation: "pending",
      errorCode: "TRANSPORT",
      at: at(),
    });
    return { status: "UNCERTAIN_RUN_RECONCILE_IMPORT" };
  }
}
