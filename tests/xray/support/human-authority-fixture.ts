/** Synthetic authority ONLY. No production import or human authentication implementation. */
import { objectDigest } from "../../../tools/agentic/artifacts.js";
import {
  humanDecisionSchema,
  type TrustedHumanApprovalAuthority,
} from "../../../tools/agentic/approval-authority.js";
import type { JournalReservationRequest } from "../../../tools/agentic/journal-reservation.js";
import { fixtureNow } from "./json-journal-fixtures.js";
import type { z } from "zod";
export class SyntheticHumanAuthority implements TrustedHumanApprovalAuthority {
  readonly authorityId = "synthetic-authority";
  readonly decisions = new Map<string, z.infer<typeof humanDecisionSchema>>();
  readonly used = new Set<string>();
  readonly events: unknown[] = [];
  consumeCalls = 0;
  returnedConsumptionId: string | undefined;
  unavailable = false;
  consumeFailure = false;
  grant(reference: string, request: JournalReservationRequest) {
    this.decisions.set(
      reference,
      humanDecisionSchema.parse({
        schemaVersion: "1.0.0",
        approvalId: reference,
        authorityId: this.authorityId,
        humanReference: "synthetic-person",
        requestDigest: objectDigest(request),
        issuedAt: new Date(fixtureNow - 500).toISOString(),
        expiresAt: new Date(fixtureNow + 60000).toISOString(),
        decision: "approved",
        decisionId: "decision-" + reference,
        auditId: "decision-audit-" + reference,
        request,
        approver: {
          subject: "synthetic-person",
          authenticationReference: "synthetic-session",
          authenticatedAt: new Date(fixtureNow - 1000).toISOString(),
        },
      }),
    );
    this.events.push({
      kind: "synthetic-decision",
      reference,
      requestDigest: objectDigest(request),
    });
  }
  async verify(
    reference: string,
    _request: JournalReservationRequest,
    _digest: string,
  ) {
    if (this.unavailable || !this.decisions.has(reference))
      throw new Error("SYNTHETIC_UNAVAILABLE");
    return structuredClone(this.decisions.get(reference));
  }
  async consumeApproval(
    reference: string,
    requestDigest: string,
    reservationId: string,
  ) {
    this.consumeCalls++;
    const decision = this.decisions.get(reference);
    if (
      !decision ||
      decision.requestDigest !== requestDigest ||
      decision.decision !== "approved" ||
      this.used.has(reference) ||
      Date.parse(decision.expiresAt) <= fixtureNow
    )
      throw new Error("SYNTHETIC_DENIED");
    this.used.add(reference);
    this.events.push({ kind: "synthetic-consumed", reference, reservationId });
    if (this.consumeFailure) throw new Error("SYNTHETIC_LOST_RESPONSE");
    await Promise.resolve();
    return {
      authorityId: this.authorityId,
      approvalId: reference,
      decisionId: decision.decisionId,
      requestDigest,
      reservationId,
      consumptionId: this.returnedConsumptionId ?? "external-" + reference,
      consumedAt: new Date(fixtureNow).toISOString(),
      auditId: "consumed-audit-" + reference,
      status: "consumed",
    };
  }
  async revokeApproval(reference: string, requestDigest: string) {
    const decision = this.decisions.get(reference);
    if (!decision || decision.requestDigest !== requestDigest)
      throw new Error("SYNTHETIC_DENIED");
    decision.decision = "revoked";
    decision.auditId = "revoked-audit-" + reference;
    this.events.push({ kind: "synthetic-revoked", reference });
    return structuredClone(decision);
  }
  async readAudit(reference: string, requestDigest: string) {
    const decision = this.decisions.get(reference);
    if (!decision || decision.requestDigest !== requestDigest)
      throw new Error("SYNTHETIC_DENIED");
    return structuredClone(this.events);
  }
}
