import { z } from "zod";
import { PublicationTransportError } from "./publication-transport.js";
import { verifyResults } from "./verification.js";

const id = z.string().regex(/^[1-9][0-9]*$/);
const members = z.object({
  issueId: id,
  jira: z.object({ key: z.string() }),
  tests: z.object({
    total: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    results: z.array(z.object({ issueId: id })),
  }),
});
/** All pages must belong to the confirmed execution; no count-only or partial proof. */
export function verifyExecutionMembership(
  expected: { issueId: string; key: string; testIssueIds: string[] },
  rawPages: unknown[],
) {
  try {
    if (
      !rawPages.length ||
      !expected.testIssueIds.length ||
      new Set(expected.testIssueIds).size !== expected.testIssueIds.length
    )
      throw new Error();
    const ids: string[] = [];
    for (const raw of rawPages) {
      const page = members.parse(raw);
      if (
        page.issueId !== expected.issueId ||
        page.jira.key !== expected.key ||
        page.tests.start !== ids.length ||
        page.tests.total !== expected.testIssueIds.length ||
        (!page.tests.results.length && ids.length < page.tests.total)
      )
        throw new Error();
      ids.push(...page.tests.results.map((t) => t.issueId));
    }
    if (
      ids.length !== expected.testIssueIds.length ||
      new Set(ids).size !== ids.length ||
      !expected.testIssueIds.every((i) => ids.includes(i))
    )
      throw new Error();
    return true;
  } catch {
    throw new PublicationTransportError("RESPONSE_UNVERIFIED");
  }
}
export function verifyImportedRuns(
  expected: { testIssueId: string; status: string }[],
  executionIssueId: string,
  rawPages: unknown[],
) {
  try {
    const runs: {
      testIssueId: string;
      status: string;
      executionIssueId: string;
    }[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    for (const raw of rawPages) {
      const page = z
        .object({
          total: z.number().int().nonnegative(),
          start: z.number().int().nonnegative(),
          results: z.array(
            z.object({
              id: z.string().min(1),
              status: z.object({ name: z.string() }),
              test: z.object({ issueId: id }),
              testExecution: z.object({ issueId: id }),
            }),
          ),
        })
        .parse(raw);
      total ??= page.total;
      if (
        total !== page.total ||
        page.start !== runs.length ||
        (!page.results.length && runs.length < total)
      )
        throw new Error();
      for (const run of page.results) {
        if (seen.has(run.id)) throw new Error();
        seen.add(run.id);
        runs.push({
          testIssueId: run.test.issueId,
          status: run.status.name,
          executionIssueId: run.testExecution.issueId,
        });
      }
    }
    return verifyResults(
      expected,
      runs,
      executionIssueId,
      total !== undefined && runs.length === total,
    );
  } catch {
    throw new PublicationTransportError("RESPONSE_UNVERIFIED");
  }
}
