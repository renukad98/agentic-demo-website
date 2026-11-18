import { z } from "zod";
import {
  readOperations,
  identifiers,
  testModel,
  manualReadModel,
  issueModel,
  executionSnapshotModel,
  runModel,
  pageSchema,
} from "./operations.js";
import { XrayReadError } from "./http.js";

/** Transport remains injected; XrayHttpReadTransport provides the allowlisted HTTPS implementation. */
export interface ReadTransport {
  request(query: string, variables: Record<string, unknown>): Promise<unknown>;
}
export interface WriteTransport {
  write(operation: string, payload: unknown): Promise<unknown>;
}
export class XrayReadClient {
  constructor(private readonly transport: ReadTransport) {}
  private async read<T extends z.ZodType>(
    operation: keyof typeof readOperations,
    variables: Record<string, unknown>,
    schema: T,
  ): Promise<z.infer<T>> {
    const spec = readOperations[operation];
    if (!spec.variables.safeParse(variables).success)
      throw new XrayReadError("INVALID_INPUT");
    const response = await this.transport.request(spec.query, variables);
    const envelope = z.object({ data: z.unknown() }).safeParse(response);
    if (!envelope.success) throw new XrayReadError("MALFORMED_RESPONSE");
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) throw new XrayReadError("MALFORMED_RESPONSE");
    return parsed.data;
  }
  async getTest(issueId: string) {
    return (
      await this.read(
        "test",
        { id: issueId },
        z.object({ getTest: testModel.nullable() }),
      )
    ).getTest;
  }
  async getTestByKey(key: string) {
    if (!identifiers.key.safeParse(key).success)
      throw new XrayReadError("INVALID_INPUT");
    const tests = await this.read(
      "tests",
      { jql: `key = "${key}"`, limit: 2, start: 0 },
      z.object({ getTests: pageSchema(testModel) }),
    );
    if (
      tests.getTests.total > 1 ||
      tests.getTests.start !== 0 ||
      tests.getTests.results.length !== tests.getTests.total
    )
      throw new XrayReadError("PAGINATION");
    return tests.getTests.results[0] ?? null;
  }
  async getManualTest(issueId: string) {
    return (
      await this.read(
        "manualTest",
        { id: issueId },
        z.object({
          getTest: manualReadModel.nullable(),
        }),
      )
    ).getTest;
  }
  async searchTests(projectKey: string, options: PageOptions = {}) {
    if (!identifiers.project.safeParse(projectKey).success)
      throw new XrayReadError("INVALID_INPUT");
    return collectPages(
      async (start, limit) =>
        (
          await this.read(
            "tests",
            { jql: `project = "${projectKey}"`, start, limit },
            z.object({ getTests: pageSchema(testModel) }),
          )
        ).getTests,
      (test) => test.issueId,
      options,
    );
  }
  async getCoverage(issueId: string, options: PageOptions = {}) {
    return collectPages(
      async (start, limit) => {
        const result = await this.read(
          "coverage",
          { id: issueId, start, limit },
          z.object({
            getTest: z
              .object({
                issueId: identifiers.id,
                coverableIssues: pageSchema(issueModel),
              })
              .nullable(),
          }),
        );
        if (!result.getTest) throw new XrayReadError("INVALID_INPUT");
        return result.getTest.coverableIssues;
      },
      (issue) => issue.issueId,
      options,
    );
  }
  async getTestExecution(issueId: string) {
    return (
      await this.read(
        "execution",
        { id: issueId },
        z.object({ getTestExecution: issueModel.nullable() }),
      )
    ).getTestExecution;
  }
  async getExecutionSnapshot(issueId: string) {
    return (
      await this.read(
        "executionSnapshot",
        { id: issueId },
        z.object({
          getTestExecution: executionSnapshotModel.nullable(),
        }),
      )
    ).getTestExecution;
  }
  async searchExecutions(projectKey: string, options: PageOptions = {}) {
    if (!identifiers.project.safeParse(projectKey).success)
      throw new XrayReadError("INVALID_INPUT");
    return collectPages(
      async (start, limit) =>
        (
          await this.read(
            "executions",
            { jql: `project = "${projectKey}"`, start, limit },
            z.object({ getTestExecutions: pageSchema(issueModel) }),
          )
        ).getTestExecutions,
      (execution) => execution.issueId,
      options,
    );
  }
  async getRuns(executionId: string, start = 0, limit = 100) {
    return (
      await this.read(
        "runs",
        { ids: [executionId], start, limit },
        z.object({ getTestRuns: pageSchema(runModel) }),
      )
    ).getTestRuns;
  }
  async getAllRuns(executionId: string, options: PageOptions = {}) {
    return collectPages(
      (start, limit) => this.getRuns(executionId, start, limit),
      (run) => run.id,
      options,
    );
  }
}
export interface PageOptions {
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
}
async function collectPages<T>(
  fetchPage: (
    start: number,
    limit: number,
  ) => Promise<{ total: number; start: number; limit: number; results: T[] }>,
  identity: (item: T) => string,
  options: PageOptions,
): Promise<T[]> {
  const bounds = z
    .object({
      pageSize: z.number().int().min(1).max(100),
      maxPages: z.number().int().min(1).max(100),
      maxItems: z.number().int().min(1).max(10000),
    })
    .safeParse({
      pageSize: options.pageSize ?? 50,
      maxPages: options.maxPages ?? 10,
      maxItems: options.maxItems ?? 1000,
    });
  if (!bounds.success) throw new XrayReadError("INVALID_INPUT");
  const { pageSize, maxPages, maxItems } = bounds.data;
  const results: T[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const current = await fetchPage(results.length, pageSize);
    if (
      current.start !== results.length ||
      current.limit !== pageSize ||
      current.results.length > pageSize ||
      current.total > maxItems ||
      (total !== undefined && current.total !== total)
    )
      throw new XrayReadError("PAGINATION");
    total = current.total;
    if (
      results.length + current.results.length > total ||
      (!current.results.length && results.length < total)
    )
      throw new XrayReadError("PAGINATION");
    for (const item of current.results) {
      const key = identity(item);
      if (ids.has(key)) throw new XrayReadError("PAGINATION");
      ids.add(key);
      results.push(item);
    }
    if (results.length === total) return results;
  }
  throw new XrayReadError("PAGINATION"); // Never return a partial search as complete.
}
export class DisabledWriteTransport implements WriteTransport {
  async write(_operation: string, _payload: unknown): Promise<never> {
    throw new Error("Remote writes disabled in Phase 5D");
  }
}
/** Jira access remains a separate connector/authentication boundary. */
export interface JiraReadClient {
  getStory(key: string): Promise<unknown>;
  getLinkTypes(): Promise<unknown>;
  getIssueLinks(key: string): Promise<unknown>;
}
