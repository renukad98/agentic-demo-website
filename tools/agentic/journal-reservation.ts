import { z } from "zod";
import {
  trustedApprovalRequestSchema,
  digest,
  safeId,
  storyKey,
} from "./contracts/index.js";

/** Additive offline infrastructure profile. Historical request schemas stay unchanged. */
export const journalReservationRequestSchema = trustedApprovalRequestSchema
  .extend({
    automationIdentity: z.string().min(1),
    operation: z.enum([
      "xray.test.create",
      "jira.test.link",
      "xray.execution.create",
      "xray.results.import",
    ]),
    target: storyKey,
    preflightDigest: digest,
    executorPrincipal: z.string().min(1),
    authorityEpoch: safeId,
    policyVersion: z.literal("json-offline-v1"),
    testIssueId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    executionKey: storyKey.optional(),
    executionIssueId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope.length !== 1 || value.scope[0] !== value.operation)
      ctx.addIssue({
        code: "custom",
        message: "Exact single operation scope required",
      });
    if (!value.target.startsWith(value.projectKey + "-"))
      ctx.addIssue({
        code: "custom",
        message: "Story must belong to selected project",
      });
    if (
      value.operation !== "xray.test.create" &&
      (!value.testKey || !value.testIssueId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Confirmed Test ID/key required",
      });
    if (
      value.operation === "xray.test.create" &&
      (value.testKey || value.testIssueId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Creation cannot invent remote identifiers",
      });
    if (value.testKey && !value.testKey.startsWith(value.projectKey + "-"))
      ctx.addIssue({
        code: "custom",
        message: "Test must belong to selected project",
      });
    if (value.operation === "xray.results.import") {
      if (
        !value.executionKey ||
        !value.executionIssueId ||
        !value.executionKey.startsWith(value.projectKey + "-")
      )
        ctx.addIssue({
          code: "custom",
          message: "Confirmed project execution ID/key required",
        });
    } else if (value.executionKey || value.executionIssueId)
      ctx.addIssue({
        code: "custom",
        message: "Only import may name an existing execution",
      });
  });
export type JournalReservationRequest = z.infer<
  typeof journalReservationRequestSchema
>;
/** Authority observations are audit data, never serialized permission. */
export const authorityEventSchema = z
  .object({
    state: z.enum(["pending", "consumed", "revoked", "uncertain"]),
    at: z.string().datetime(),
    auditId: safeId,
    externalConsumptionId: safeId.optional(),
  })
  .strict();
export const authorityAuditSchema = z
  .object({
    authorityId: safeId,
    decisionId: safeId,
    approverSubject: z.string().min(1),
    authenticationReference: safeId,
    requestDigest: digest,
    events: z.array(authorityEventSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const transitions: Record<string, string[]> = {
      pending: ["consumed", "revoked", "uncertain"],
      consumed: ["revoked", "uncertain"],
      uncertain: ["revoked"],
      revoked: [],
    };
    if (value.events[0]!.state !== "pending")
      ctx.addIssue({
        code: "custom",
        message: "Authority audit must begin pending",
      });
    for (let i = 0; i < value.events.length; i++) {
      const event = value.events[i]!;
      if (event.state === "consumed" && !event.externalConsumptionId)
        ctx.addIssue({
          code: "custom",
          message: "Consumption audit ID required",
        });
      if (
        i &&
        (!transitions[value.events[i - 1]!.state]!.includes(event.state) ||
          Date.parse(event.at) < Date.parse(value.events[i - 1]!.at))
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid authority audit transition",
        });
    }
  });
export const approvalEvidenceSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    approvalId: safeId,
    authorityId: z.string().min(1),
    humanReference: z.string().min(1),
    requestDigest: digest,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    decision: z.literal("approved"),
    authority: authorityAuditSchema.optional(),
  })
  .strict();
export type ApprovalEvidence = z.infer<typeof approvalEvidenceSchema>;
export class JournalReservationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JournalReservationError";
  }
}

/** Future verifier must authenticate human evidence through a protected channel.
 * Verification is NOT consumption; local consumption/reservation share one JSON replacement.
 * No production verifier/issuer is registered in this phase.
 */
export interface TrustedApprovalEvidenceVerifier {
  verify(
    reference: string,
    request: JournalReservationRequest,
    requestDigest: string,
  ): Promise<unknown>;
}
