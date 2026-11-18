import { z } from "zod";

export const manualCaseId = z
  .string()
  .regex(/^TM-TC-(?:0[1-9]|1[0-9]|2[0-8])$/);
const text = z.string().trim().min(1);
export const manualStep = z
  .object({ action: text, data: text, result: text })
  .strict();
export const manualVariables = z
  .object({
    testType: z.object({ name: z.literal("Manual") }).strict(),
    steps: z.array(manualStep).min(1).max(100),
    jira: z
      .object({
        fields: z
          .object({
            project: z
              .object({ key: z.literal("KAN"), id: z.literal("10001") })
              .strict(),
            issuetype: z.object({ id: z.literal("10045") }).strict(),
            reporter: z
              .object({
                accountId: z.literal(
                  "712020:a8fac447-b5f9-4da3-a23a-bb24d61b4baa",
                ),
              })
              .strict(),
            summary: text.max(255),
            description: text,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const manualMutation = `mutation ProposedManualTest($testType: UpdateTestTypeInput!, $steps: [CreateStepInput!]!, $jira: JSON!) {
  createTest(testType: $testType, steps: $steps, jira: $jira) {
    test { issueId testType { name } steps { action data result } jira(fields: ["key", "summary", "description"]) }
    warnings
  }
}`;

export function parseManualCase(markdown: string, rawCaseId: string) {
  const caseId = manualCaseId.parse(rawCaseId);
  if (!/^Story KAN-25;/m.test(markdown))
    throw new Error("MANUAL_STORY_MISMATCH");
  const sections = markdown
    .split(/^## /m)
    .filter((part) => part.startsWith(caseId + " — "));
  if (sections.length !== 1)
    throw new Error("MANUAL_CASE_MISSING_OR_AMBIGUOUS");
  const [heading, ...lines] = sections[0]!.split(/\r?\n/);
  const title = text.parse(heading?.slice(caseId.length + 3));
  const field = (label: string) => {
    const prefix = "- " + label + ": ";
    const values = lines.filter((line) => line.startsWith(prefix));
    if (values.length !== 1)
      throw new Error("MANUAL_CASE_FIELD_MISSING_OR_AMBIGUOUS");
    return text.parse(values[0]!.slice(prefix.length));
  };
  if (field("Planned level").replace(/\.$/, "") === "delivery review")
    throw new Error("MANUAL_CASE_IS_DELIVERY_AUDIT");
  const identifiers = (label: string, re: RegExp) =>
    z
      .array(z.string().regex(re))
      .min(1)
      .parse(field(label).replace(/\.$/, "").split(/,\s*/));
  const preconditionsAndData = field("Preconditions/data");
  const table = lines.filter((line) => line.startsWith("|"));
  const header = table[0]?.replace(/\s/g, "");
  const hasStepData =
    header === "|Step|Action|Testdata|Expectedobservableresult|";
  if (
    (!hasStepData &&
      header !== "|Step|Action/input|Expectedobservableresult|") ||
    !/^\|[ |:-]+\|$/.test(table[1] ?? "")
  )
    throw new Error("MANUAL_STEP_TABLE_REQUIRED");
  const steps = table.slice(2).map((line, index) => {
    const cells = line.split("|");
    const last = hasStepData ? 5 : 4;
    if (
      cells.length !== last + 1 ||
      cells[0] !== "" ||
      cells[last] !== "" ||
      cells[1]?.trim() !== String(index + 1)
    )
      throw new Error("MANUAL_STEP_NUMBER_OR_FORMAT_INVALID");
    return {
      number: index + 1,
      ...manualStep.parse({
        action: cells[2],
        data: hasStepData ? cells[3] : preconditionsAndData,
        result: cells[last - 1],
      }),
    };
  });
  if (!steps.length) throw new Error("MANUAL_STEPS_REQUIRED");
  return {
    caseId,
    title,
    preconditionsAndData,
    steps,
    requirements: identifiers("Requirements", /^TM-REQ-[0-9]{3}$/),
    acceptance: identifiers("Acceptance", /^TM-AC-[0-9]{2}$/),
  };
}
