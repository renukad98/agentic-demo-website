import { z } from "zod";
import {
  canonicalizeJson,
  digestOperationPayload,
} from "./approval-canonicalization.js";

const text = z.string().trim().min(1);
export const duplicateContentSchema = z
  .object({
    ref: text,
    summary: text,
    description: z.string().nullable(),
    manual: z.boolean(),
    steps: z.array(
      z
        .object({ action: z.string(), data: z.string(), result: z.string() })
        .strict(),
    ),
    generic: z
      .object({
        kind: z.literal("Unstructured"),
        definition: z.string().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DuplicateContent = z.infer<typeof duplicateContentSchema>;
export const duplicateReviewsSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    cases: z.array(
      z
        .object({
          testCaseId: text,
          evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          decisions: z.array(
            z
              .object({
                candidateRef: text,
                disposition: z.literal("related-distinct"),
                rationale: z.string().trim().min(20).max(4000),
                genericComparison: z
                  .object({
                    candidateBehavior: z.string().trim().min(12),
                    evidenceReference: z.string().trim().min(8),
                    proposedOutcome: z.string().trim().min(12),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
const normalize = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, " ").trim();
export function classifyDuplicate(
  proposed: DuplicateContent,
  candidate: DuplicateContent,
): "exact-duplicate" | "uncertain" {
  // Titles and AC labels cannot prove distinct behavior. Equal executable content is a hard block.
  const executable = (c: DuplicateContent) =>
    c.steps.map((s) => ({
      action: normalize(s.action),
      data: normalize(s.data),
      result: normalize(s.result),
    }));
  if (
    candidate.steps.length &&
    canonicalizeJson(executable(proposed)) ===
      canonicalizeJson(executable(candidate))
  )
    return "exact-duplicate";
  if (candidate.generic && proposed.steps.length) {
    const behavior = normalize(
      [candidate.description, candidate.generic.definition]
        .filter(Boolean)
        .join(" "),
    ).toLowerCase();
    if (
      proposed.steps.every(
        (s) =>
          behavior.includes(normalize(s.action).toLowerCase()) &&
          behavior.includes(normalize(s.result).toLowerCase()),
      )
    )
      return "exact-duplicate";
  }
  return "uncertain";
}
export function duplicatePacket(
  testCaseId: string,
  proposed: DuplicateContent,
  candidates: DuplicateContent[],
) {
  const evidence = [...candidates].sort((a, b) => a.ref.localeCompare(b.ref));
  return {
    schemaVersion: "1.0.0" as const,
    testCaseId,
    proposed,
    candidates: evidence.map((c) => ({
      ...c,
      classification: classifyDuplicate(proposed, c),
    })),
    evidenceDigest: digestOperationPayload({
      testCaseId,
      proposed,
      candidates: evidence,
    }),
  };
}
export class XrayDuplicateReviewError extends Error {
  constructor(
    readonly code:
      | "EXACT_DUPLICATE"
      | "DUPLICATE_REVIEW_REQUIRED"
      | "DUPLICATE_EVIDENCE_INCOMPLETE",
    readonly packet?: ReturnType<typeof duplicatePacket>,
  ) {
    super(code);
  }
}
type Comparison = NonNullable<
  z.infer<
    typeof duplicateReviewsSchema
  >["cases"][number]["decisions"][number]["genericComparison"]
>;

function hasDistinctGenericEvidence(
  proposed: DuplicateContent,
  candidate: DuplicateContent,
  comparison: Comparison | undefined,
): boolean {
  if (
    !candidate.generic ||
    candidate.steps.length ||
    !comparison ||
    !candidate.description?.trim()
  )
    return false;
  const description = normalize(candidate.description).toLowerCase();
  const definition = normalize(
    candidate.generic.definition ?? "",
  ).toLowerCase();
  const behavior = normalize(comparison.candidateBehavior).toLowerCase();
  const outcome = normalize(comparison.proposedOutcome).toLowerCase();
  const reference = normalize(comparison.evidenceReference).toLowerCase();
  const lines = candidate.description
    .split(/\r?\n/)
    .map((line) => normalize(line).toLowerCase());
  return (
    lines.some(
      (line) =>
        line === "test: " + behavior || line === "behavior: " + behavior,
    ) &&
    (definition === reference ||
      lines.some(
        (line) =>
          line === "source: " + reference ||
          line === "automation: " + reference,
      )) &&
    behavior !== reference &&
    proposed.steps.some(
      (step) => normalize(step.result).toLowerCase() === outcome,
    ) &&
    !description.includes(outcome) &&
    !definition.includes(outcome)
  );
}
export function validateDuplicateReview(
  packet: ReturnType<typeof duplicatePacket>,
  reviews: z.infer<typeof duplicateReviewsSchema> | undefined,
): void {
  if (packet.candidates.some((c) => c.classification === "exact-duplicate"))
    throw new XrayDuplicateReviewError("EXACT_DUPLICATE", packet);
  if (!packet.candidates.length) return;
  const entries =
    reviews?.cases.filter((c) => c.testCaseId === packet.testCaseId) ?? [];
  const review = entries[0];
  if (
    entries.length !== 1 ||
    !review ||
    review.evidenceDigest !== packet.evidenceDigest ||
    review.decisions.length !== packet.candidates.length ||
    new Set(review.decisions.map((d) => d.candidateRef)).size !==
      packet.candidates.length ||
    packet.candidates.some((c) => {
      const decision = review.decisions.find(
        (d) => d.candidateRef === c.ref && d.disposition === "related-distinct",
      );
      if (!decision) return true;
      if (c.manual)
        return (
          Boolean(decision.genericComparison) ||
          !c.steps.length ||
          c.steps.some((s) => !s.action.trim() || !s.result.trim())
        );
      return !hasDistinctGenericEvidence(
        packet.proposed,
        c,
        decision.genericComparison,
      );
    })
  ) {
    throw new XrayDuplicateReviewError("DUPLICATE_REVIEW_REQUIRED", packet);
  }
}
