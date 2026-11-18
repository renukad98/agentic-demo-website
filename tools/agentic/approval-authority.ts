import { z } from "zod";
import { objectDigest } from "./artifacts.js";
import { safeId, digest } from "./contracts/index.js";
import { ApprovalEvidenceGate } from "./approvals.js";
import {
  approvalEvidenceSchema,
  journalReservationRequestSchema,
  type JournalReservationRequest,
  type TrustedApprovalEvidenceVerifier,
} from "./journal-reservation.js";
import type { OperationJournal } from "../xray/operation-journal.js";

/** Additive authority contract. A protected host must authenticate its source.
 * There is no approve/issue method or caller-supplied approver identity.
 * consumeApproval must be atomic/single-use at the authority; uncertainty cannot retry.
 * revokeApproval requires an independently authenticated human session at the source.
 */
export interface TrustedHumanApprovalAuthority extends TrustedApprovalEvidenceVerifier {
  readonly authorityId: string;
  consumeApproval(
    reference: string,
    requestDigest: string,
    reservationId: string,
  ): Promise<unknown>;
  revokeApproval(reference: string, requestDigest: string): Promise<unknown>;
  readAudit(reference: string, requestDigest: string): Promise<unknown>;
}
const unavailable = async (): Promise<never> => {
  throw new Error("HUMAN_AUTHORITY_UNAVAILABLE");
};
const denyAuthority: TrustedHumanApprovalAuthority = {
  authorityId: "unconfigured",
  verify: unavailable,
  consumeApproval: unavailable,
  revokeApproval: unavailable,
  readAudit: unavailable,
};
export const humanDecisionSchema = approvalEvidenceSchema
  .omit({ authority: true })
  .extend({
    decision: z.enum(["approved", "denied", "revoked"]),
    decisionId: safeId,
    auditId: safeId,
    request: journalReservationRequestSchema,
    approver: z
      .object({
        subject: z.string().min(1),
        authenticationReference: safeId,
        authenticatedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();
const receiptSchema = z
  .object({
    authorityId: safeId,
    approvalId: safeId,
    decisionId: safeId,
    requestDigest: digest,
    reservationId: safeId,
    consumptionId: safeId,
    consumedAt: z.string().datetime(),
    auditId: safeId,
    status: z.literal("consumed"),
  })
  .strict();
const transitionSchema = z
  .object({
    operationId: safeId,
    requestDigest: digest,
    authorityId: safeId,
    decisionId: safeId,
    event: z
      .object({
        state: z.enum(["consumed", "revoked", "uncertain"]),
        at: z.string().datetime(),
        auditId: safeId,
        externalConsumptionId: safeId.optional(),
      })
      .strict(),
  })
  .strict();
type Transition = z.infer<typeof transitionSchema>;
const transitions = new WeakMap<object, Transition>();
function ticket(value: Transition) {
  const handle = Object.freeze(Object.create(null)) as object;
  transitions.set(handle, transitionSchema.parse(value));
  return handle;
}
/** Only in-process source observations can supply a transition; JSON cannot forge it. */
export function takeAuthorityTransition(handle: object): Transition {
  const value = transitions.get(handle);
  if (!value) throw new Error("UNVERIFIED_AUTHORITY_TRANSITION");
  transitions.delete(handle);
  return structuredClone(value);
}

/** Local boundary only. Default denies; no network/source/production writer registered. */
export class TrustedHumanApprovalBoundary {
  constructor(
    private readonly authority: TrustedHumanApprovalAuthority = denyAuthority,
    private readonly now = Date.now,
  ) {}
  private async decision(
    reference: string,
    request: JournalReservationRequest,
    allowRevoked = false,
  ) {
    safeId.parse(reference);
    let decision: z.infer<typeof humanDecisionSchema>;
    try {
      decision = humanDecisionSchema.parse(
        await this.authority.verify(
          reference,
          structuredClone(request),
          objectDigest(request),
        ),
      );
    } catch {
      throw new Error("AUTHORITY_UNAVAILABLE_OR_INVALID");
    }
    if (
      decision.authorityId !== this.authority.authorityId ||
      decision.approvalId !== reference ||
      decision.requestDigest !== objectDigest(request) ||
      objectDigest(decision.request) !== objectDigest(request) ||
      decision.humanReference !== decision.approver.subject
    )
      throw new Error("AUTHORITY_DECISION_BINDING");
    if (
      Date.parse(decision.approver.authenticatedAt) >
        Date.parse(decision.issuedAt) ||
      Date.parse(decision.issuedAt) > this.now()
    )
      throw new Error("AUTHORITY_AUTHENTICATION_TIME");
    if (
      decision.decision !== "approved" &&
      !(allowRevoked && decision.decision === "revoked")
    )
      throw new Error("AUTHORITY_DENIED_OR_REVOKED");
    if (
      !allowRevoked &&
      (Date.parse(decision.expiresAt) <= this.now() ||
        Date.parse(decision.expiresAt) <= Date.parse(decision.issuedAt))
    )
      throw new Error("AUTHORITY_EXPIRED");
    return decision;
  }
  async authorizeAndReserve(
    journal: OperationJournal,
    reference: string,
    raw: JournalReservationRequest,
    payload: unknown,
  ) {
    const request = journalReservationRequestSchema.parse(structuredClone(raw)),
      body = structuredClone(payload);
    if (objectDigest(body) !== request.payloadDigest)
      throw new Error("AUTHORITY_PAYLOAD_MISMATCH");
    const decision = await this.decision(reference, request);
    const gate = new ApprovalEvidenceGate({
      verify: async () => ({
        schemaVersion: decision.schemaVersion,
        approvalId: decision.approvalId,
        authorityId: decision.authorityId,
        humanReference: decision.humanReference,
        requestDigest: decision.requestDigest,
        issuedAt: decision.issuedAt,
        expiresAt: decision.expiresAt,
        decision: "approved",
        authority: {
          authorityId: decision.authorityId,
          decisionId: decision.decisionId,
          approverSubject: decision.approver.subject,
          authenticationReference: decision.approver.authenticationReference,
          requestDigest: decision.requestDigest,
          events: [
            {
              state: "pending",
              at: new Date(this.now()).toISOString(),
              auditId: decision.auditId,
            },
          ],
        },
      }),
    });
    const handle = await gate.verify(reference, request);
    // Durable pending record precedes external consumption. If this fails, do not consume.
    const reservation = await journal.consumeAndReserve(request, body, handle);
    const context = {
      operationId: request.operationId,
      requestDigest: objectDigest(request),
      authorityId: decision.authorityId,
      decisionId: decision.decisionId,
    };
    let receipt: z.infer<typeof receiptSchema>;
    try {
      receipt = receiptSchema.parse(
        await this.authority.consumeApproval(
          reference,
          context.requestDigest,
          reservation.consumptionId,
        ),
      );
      if (
        receipt.authorityId !== context.authorityId ||
        receipt.approvalId !== reference ||
        receipt.decisionId !== context.decisionId ||
        receipt.requestDigest !== context.requestDigest ||
        receipt.reservationId !== reservation.consumptionId ||
        Date.parse(receipt.consumedAt) > this.now() ||
        Date.parse(receipt.consumedAt) < Date.parse(decision.issuedAt) ||
        Date.parse(receipt.consumedAt) >= Date.parse(decision.expiresAt)
      )
        throw new Error("INVALID_CONSUMPTION");
    } catch {
      try {
        await journal.applyAuthorityTransition(
          ticket({
            ...context,
            event: {
              state: "uncertain",
              at: new Date(this.now()).toISOString(),
              auditId: "consumption-uncertain",
            },
          }),
        );
      } catch {
        throw new Error("AUTHORITY_JOURNAL_RECONCILIATION_REQUIRED");
      }
      throw new Error("AUTHORITY_CONSUMPTION_UNCERTAIN");
    }
    try {
      await journal.applyAuthorityTransition(
        ticket({
          ...context,
          event: {
            state: "consumed",
            at: receipt.consumedAt,
            auditId: receipt.auditId,
            externalConsumptionId: receipt.consumptionId,
          },
        }),
      );
    } catch {
      throw new Error("AUTHORITY_JOURNAL_RECONCILIATION_REQUIRED");
    }
    return {
      operationId: request.operationId,
      consumptionId: receipt.consumptionId,
      authorityState: "consumed" as const,
      productionExecution: "BLOCKED" as const,
    };
  }
  /** Read the authority's current decision; does not issue a local revocation. */
  async refreshRevocation(
    journal: OperationJournal,
    reference: string,
    raw: JournalReservationRequest,
  ) {
    const request = journalReservationRequestSchema.parse(structuredClone(raw));
    const decision = await this.decision(reference, request, true);
    if (decision.decision !== "revoked")
      throw new Error("AUTHORITY_REVOCATION_NOT_OBSERVED");
    await journal.applyAuthorityTransition(
      ticket({
        operationId: request.operationId,
        requestDigest: objectDigest(request),
        authorityId: decision.authorityId,
        decisionId: decision.decisionId,
        event: {
          state: "revoked",
          at: new Date(this.now()).toISOString(),
          auditId: decision.auditId,
        },
      }),
    );
  }
}
