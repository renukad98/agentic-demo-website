/** Synthetic evidence only. No production approval issuer. */
import { ApprovalEvidenceGate } from "../../../tools/agentic/approvals.js";
import { objectDigest } from "../../../tools/agentic/artifacts.js";
import {
  journalReservationRequestSchema,
  type JournalReservationRequest,
  type TrustedApprovalEvidenceVerifier,
} from "../../../tools/agentic/journal-reservation.js";
import { genericProposal, linkProposal } from "../../../tools/xray/planner.js";
import { writeOperationId } from "../../../tools/xray/write-integration.js";
import { identityKey } from "../../../tools/xray/identity.js";
import { boundFixture, mockCreation } from "../publication-fixtures.js";
export const fixtureNow = Date.parse("2026-11-16T12:00:00Z");
export function jsonFixture() {
  const identity = boundFixture(),
    proposal = genericProposal(
      "SYN-1",
      "SYN",
      identity,
      "Synthetic JSON journal",
      mockCreation,
    );
  const request = journalReservationRequestSchema.parse({
    schemaVersion: "1.0.0",
    tenant: "synthetic-tenant",
    projectKey: "SYN",
    operation: "xray.test.create",
    operationId: writeOperationId({
      tenant: "synthetic-tenant",
      projectKey: "SYN",
      operation: "xray.test.create",
      payloadDigest: proposal.payloadDigest,
    }),
    target: "SYN-1",
    scope: ["xray.test.create"],
    automationIdentity: identityKey(identity),
    sourceDigest: identity.sourceDigest,
    evidenceDigest: proposal.evidenceDigest,
    payloadDigest: proposal.payloadDigest,
    preflightDigest: objectDigest({ synthetic: true }),
    executorPrincipal: "synthetic-principal",
    authorityEpoch: "synthetic-epoch",
    policyVersion: "json-offline-v1",
  });
  const link = linkProposal(
    "SYN-1",
    "SYN-2",
    { id: "10037", name: "Test", inward: "is tested by", outward: "tests" },
    proposal.evidenceDigest,
  );
  const linkRequest = journalReservationRequestSchema.parse({
    ...request,
    operation: "jira.test.link",
    scope: ["jira.test.link"],
    operationId: writeOperationId({
      tenant: request.tenant,
      projectKey: request.projectKey,
      operation: "jira.test.link",
      payloadDigest: link.payloadDigest,
    }),
    payloadDigest: link.payloadDigest,
    testKey: "SYN-2",
    testIssueId: "101",
  });
  return { identity, proposal, request, link, linkRequest };
}
class SyntheticVerifier implements TrustedApprovalEvidenceVerifier {
  constructor(
    private readonly expected: JournalReservationRequest,
    private readonly expiry: number,
  ) {}
  async verify(
    reference: string,
    request: JournalReservationRequest,
    digest: string,
  ) {
    if (
      !reference ||
      objectDigest(request) !== objectDigest(this.expected) ||
      digest !== objectDigest(this.expected)
    )
      throw new Error("SYNTHETIC_DENIED");
    return {
      schemaVersion: "1.0.0",
      approvalId: reference,
      authorityId: "synthetic-authority",
      humanReference: "synthetic-human",
      requestDigest: digest,
      issuedAt: new Date(fixtureNow - 1000).toISOString(),
      expiresAt: new Date(this.expiry).toISOString(),
      decision: "approved",
    };
  }
}
export function syntheticGate(
  request: JournalReservationRequest,
  expiry = fixtureNow + 60000,
) {
  return new ApprovalEvidenceGate(new SyntheticVerifier(request, expiry));
}
