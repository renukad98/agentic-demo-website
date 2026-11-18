import {
  approvalRequestSchema,
  approvalSchema,
  type ApprovalRequest,
  trustedApprovalRequestSchema,
  trustedApprovalReceiptSchema,
} from "./contracts/index.js";
import { objectDigest } from "./artifacts.js";
import type { z } from "zod";
import {
  approvalEvidenceSchema,
  journalReservationRequestSchema,
  JournalReservationError,
  type ApprovalEvidence,
  type JournalReservationRequest,
  type TrustedApprovalEvidenceVerifier,
} from "./journal-reservation.js";

const verifiedEvidence = new WeakMap<object, ApprovalEvidence>();
const denyEvidenceVerifier: TrustedApprovalEvidenceVerifier = {
  async verify() {
    throw new JournalReservationError("TRUSTED_EVIDENCE_UNAVAILABLE");
  },
};
/** A local JSON receipt cannot create this opaque in-process verification handle. */
export class ApprovalEvidenceGate {
  constructor(
    private readonly verifier: TrustedApprovalEvidenceVerifier = denyEvidenceVerifier,
  ) {}
  async verify(
    reference: string,
    raw: JournalReservationRequest,
  ): Promise<object> {
    const request = journalReservationRequestSchema.parse(structuredClone(raw));
    let evidence: ApprovalEvidence;
    try {
      evidence = approvalEvidenceSchema.parse(
        await this.verifier.verify(reference, request, objectDigest(request)),
      );
    } catch {
      throw new JournalReservationError("TRUSTED_EVIDENCE_DENIED");
    }
    if (
      evidence.approvalId !== reference ||
      evidence.requestDigest !== objectDigest(request)
    )
      throw new JournalReservationError("EVIDENCE_BINDING_MISMATCH");
    const handle = Object.freeze(Object.create(null)) as object;
    verifiedEvidence.set(handle, structuredClone(evidence));
    return handle;
  }
}
/** Handles are single-attempt; persistent replay is enforced by the existing JSON journal. */
export function takeVerifiedApprovalEvidence(
  handle: object,
  requestDigest: string,
): ApprovalEvidence {
  const evidence = verifiedEvidence.get(handle);
  if (!evidence || evidence.requestDigest !== requestDigest)
    throw new JournalReservationError("UNVERIFIED_APPROVAL_EVIDENCE");
  verifiedEvidence.delete(handle);
  return structuredClone(evidence);
}

export interface ApprovalProvider {
  /** Implementations must consult a trusted human authorization system, not local JSON. */
  verify(reference: string, request: ApprovalRequest): Promise<unknown>;
}
export const denyAllApprovals: ApprovalProvider = {
  async verify() {
    throw new Error("Trusted approval provider unavailable");
  },
};
export async function requireApproval(
  provider: ApprovalProvider,
  reference: string,
  request: ApprovalRequest,
  now = Date.now(),
) {
  approvalRequestSchema.parse(request);
  if (request.operation !== "feature.implement")
    throw new Error(
      "External operations require consumed trusted authority approval",
    );
  if (!reference) throw new Error("Missing approval reference");
  const approval = approvalSchema.parse(
    await provider.verify(reference, request),
  );
  if (approval.id !== reference || Date.parse(approval.expiresAt) <= now)
    throw new Error("Expired or mismatched approval");
  for (const key of [
    "operation",
    "target",
    "payloadDigest",
    "evidenceDigest",
  ] as const)
    if (approval[key] !== request[key])
      throw new Error(`Approval ${key} mismatch`);
  if (
    JSON.stringify([...approval.scope].sort()) !==
    JSON.stringify([...request.scope].sort())
  )
    throw new Error("Approval scope mismatch");
  return approval;
}

export type TrustedApprovalRequest = z.infer<
  typeof trustedApprovalRequestSchema
>;
export type TrustedApprovalReceipt = z.infer<
  typeof trustedApprovalReceiptSchema
>;
export interface TrustedApprovalAuthority {
  /** Must authenticate the human and atomically consume once across all clients/processes.
   * Repository files, environment variables and submitted receipts are not authority.
   * An uncertain consumption must be reconciled at the authority before another attempt.
   */
  consume(
    reference: string,
    request: TrustedApprovalRequest,
    requestDigest: string,
  ): Promise<unknown>;
}
export const denyTrustedAuthority: TrustedApprovalAuthority = {
  async consume() {
    throw new Error("Trusted human authority unavailable");
  },
};
export class TrustedApprovalGate {
  #usedReferences = new Set<string>();
  #usedOperations = new Set<string>();
  #consumptionIds = new Set<string>();
  constructor(
    private readonly authority: TrustedApprovalAuthority = denyTrustedAuthority,
    private readonly now = Date.now,
  ) {}
  async consume(
    reference: string,
    rawRequest: TrustedApprovalRequest,
    payload: unknown,
  ): Promise<TrustedApprovalReceipt> {
    const request = trustedApprovalRequestSchema.parse(rawRequest);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(reference))
      throw new Error("Missing or invalid approval reference");
    if (objectDigest(payload) !== request.payloadDigest)
      throw new Error("Approval payload digest mismatch");
    const operationIdentity = objectDigest({
      tenant: request.tenant,
      projectKey: request.projectKey,
      operationId: request.operationId,
    });
    if (
      this.#usedReferences.has(reference) ||
      this.#usedOperations.has(operationIdentity)
    )
      throw new Error("Approval replay or consumption reconciliation required");
    // Reserve before awaiting: concurrent/uncertain consumption cannot automatically replay.
    this.#usedReferences.add(reference);
    this.#usedOperations.add(operationIdentity);
    let raw: unknown;
    try {
      raw = await this.authority.consume(
        reference,
        structuredClone(request),
        objectDigest(request),
      );
    } catch {
      throw new Error(
        "Trusted approval denied or consumption uncertain; authority reconciliation required",
      );
    }
    const receipt = trustedApprovalReceiptSchema.parse(raw);
    const now = this.now();
    if (
      receipt.approvalId !== reference ||
      receipt.requestDigest !== objectDigest(request) ||
      objectDigest(receipt.request) !== objectDigest(request)
    )
      throw new Error("Trusted approval request binding mismatch");
    if (
      Date.parse(receipt.issuedAt) > now ||
      Date.parse(receipt.expiresAt) <= now ||
      Date.parse(receipt.consumedAt) < Date.parse(receipt.issuedAt) ||
      Date.parse(receipt.consumedAt) > now ||
      Date.parse(receipt.consumedAt) >= Date.parse(receipt.expiresAt)
    )
      throw new Error("Stale or expired trusted approval");
    if (this.#consumptionIds.has(receipt.consumptionId))
      throw new Error("Approval consumption audit ID replay");
    this.#consumptionIds.add(receipt.consumptionId);
    return receipt; // Audit data only; no remote writer is enabled or invoked.
  }
}
