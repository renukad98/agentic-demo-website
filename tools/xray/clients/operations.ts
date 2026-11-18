import { z } from "zod";
import { XrayReadError } from "./errors.js";

const id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const key = z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
const project = z.string().regex(/^[A-Z][A-Z0-9]*$/);
const pagination = {
  limit: z.number().int().min(1).max(100),
  start: z.number().int().min(0).max(1000000),
};
export const jiraModel = z.object({
  key,
  summary: z.string().nullable().optional(),
});
export const issueModel = z.object({ issueId: id, jira: jiraModel });
export const executionSnapshotModel = issueModel.extend({
  projectId: id,
  testEnvironments: z
    .array(z.string())
    .nullable()
    .transform((value) => value ?? []),
  jira: jiraModel.extend({ created: z.string().optional() }),
  tests: z
    .object({
      total: z.number().int().nonnegative(),
      start: z.literal(0),
      results: z.array(z.object({ issueId: id })).max(2),
    })
    .refine(
      (page) =>
        page.results.length === Math.min(page.total, 2) &&
        new Set(page.results.map((test) => test.issueId)).size ===
          page.results.length,
    ),
});
export const testModel = issueModel.extend({
  testType: z.object({ name: z.string().min(1) }),
  unstructured: z.string().nullable().optional(),
  steps: z
    .array(
      z.object({
        action: z.string().nullable(),
        data: z.string().nullable(),
        result: z.string().nullable(),
      }),
    )
    .nullable()
    .optional(),
});
export const manualReadModel = testModel.extend({
  jira: jiraModel.extend({
    description: z.string().nullable(),
    created: z.string().optional(),
  }),
});
export const runModel = z.object({
  id: z.string().min(1),
  status: z.object({ name: z.string().min(1) }),
  comment: z.string().nullable().optional(),
  startedOn: z.string().nullable().optional(),
  finishedOn: z.string().nullable().optional(),
  evidence: z.array(z.object({ filename: z.string() })).optional(),
  test: z.object({ issueId: id }),
  testExecution: z.object({ issueId: id }),
});
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    total: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    results: z.array(item).max(100),
  });
}
export const readOperations = {
  test: {
    query:
      'query ReadTest($id:String!){getTest(issueId:$id){issueId testType{name} unstructured steps{action data result} jira(fields:["key","summary"])}}',
    variables: z.object({ id }).strict(),
    field: "getTest",
  },
  manualTest: {
    query:
      'query ReadManualTest($id:String!){getTest(issueId:$id){issueId testType{name} steps{action data result} jira(fields:["key","summary","description","created"])}}',
    variables: z.object({ id }).strict(),
    field: "getTest",
  },
  tests: {
    query:
      'query ReadTests($jql:String!,$limit:Int!,$start:Int!){getTests(jql:$jql,limit:$limit,start:$start){total start limit results{issueId testType{name} unstructured jira(fields:["key","summary"])}}}',
    variables: z
      .object({ jql: z.string(), ...pagination })
      .strict()
      .superRefine((value, context) => {
        if (
          !/^project = "[A-Z][A-Z0-9]*"$/.test(value.jql) &&
          !/^key = "[A-Z][A-Z0-9]*-[1-9][0-9]*"$/.test(value.jql)
        )
          context.addIssue({
            code: "custom",
            message: "Only exact project/key selectors are supported",
          });
      }),
    field: "getTests",
  },
  coverage: {
    query:
      'query ReadCoverage($id:String!,$limit:Int!,$start:Int!){getTest(issueId:$id){issueId coverableIssues(limit:$limit,start:$start){total start limit results{issueId jira(fields:["key"])}}}}',
    variables: z.object({ id, ...pagination }).strict(),
    field: "getTest",
  },
  execution: {
    query:
      'query ReadExecution($id:String!){getTestExecution(issueId:$id){issueId jira(fields:["key","summary"])}}',
    variables: z.object({ id }).strict(),
    field: "getTestExecution",
  },
  executionMembers: {
    query:
      'query ReadExecutionMembers($id:String!,$limit:Int!,$start:Int!){getTestExecution(issueId:$id){issueId jira(fields:["key","project","issuetype","reporter","summary"]) tests(limit:$limit,start:$start){total start limit results{issueId jira(fields:["key"])}}}}',
    variables: z.object({ id, ...pagination }).strict(),
    field: "getTestExecution",
  },
  executionSnapshot: {
    query:
      'query ReadExecutionSnapshot($id:String!){getTestExecution(issueId:$id){issueId projectId testEnvironments jira(fields:["key","summary","created"]) tests(limit:2,start:0){total start results{issueId}}}}',
    variables: z.object({ id }).strict(),
    field: "getTestExecution",
  },
  executions: {
    query:
      'query ReadExecutions($jql:String!,$limit:Int!,$start:Int!){getTestExecutions(jql:$jql,limit:$limit,start:$start){total start limit results{issueId jira(fields:["key","summary"])}}}',
    variables: z
      .object({
        jql: z.string().regex(/^project = "[A-Z][A-Z0-9]*"$/),
        ...pagination,
      })
      .strict(),
    field: "getTestExecutions",
  },
  runs: {
    query:
      "query ReadRuns($ids:[String],$limit:Int!,$start:Int!){getTestRuns(testExecIssueIds:$ids,limit:$limit,start:$start){total start limit results{id status{name} comment startedOn finishedOn evidence{filename} test{issueId} testExecution{issueId}}}}",
    variables: z.object({ ids: z.array(id).length(1), ...pagination }).strict(),
    field: "getTestRuns",
  },
} as const;
export type ReadOperation = keyof typeof readOperations;
Object.values(readOperations).forEach(Object.freeze);
Object.freeze(readOperations);
export function readOperation(
  query: string,
  variables: Record<string, unknown>,
) {
  const entry = Object.entries(readOperations).find(
    ([, operation]) => operation.query === query,
  );
  if (!entry) throw new XrayReadError("UNSUPPORTED_OPERATION");
  const parsed = entry[1].variables.safeParse(variables);
  if (!parsed.success) throw new XrayReadError("INVALID_INPUT");
  return {
    name: entry[0] as ReadOperation,
    field: entry[1].field,
    variables: parsed.data,
  };
}
export const identifiers = { id, key, project };

export function validateReadData(
  name: ReadOperation,
  data: unknown,
  variables?: Record<string, unknown>,
) {
  const schema =
    name === "test"
      ? z.object({ getTest: testModel.nullable() })
      : name === "manualTest"
        ? z.object({ getTest: manualReadModel.nullable() })
        : name === "tests"
          ? z.object({ getTests: pageSchema(testModel) })
          : name === "coverage"
            ? z.object({
                getTest: z
                  .object({
                    issueId: id,
                    coverableIssues: pageSchema(issueModel),
                  })
                  .nullable(),
              })
            : name === "execution"
              ? z.object({ getTestExecution: issueModel.nullable() })
              : name === "executionMembers"
                ? z.object({
                    getTestExecution: issueModel
                      .extend({ tests: pageSchema(issueModel) })
                      .nullable(),
                  })
                : name === "executionSnapshot"
                  ? z.object({
                      getTestExecution: executionSnapshotModel.nullable(),
                    })
                  : name === "executions"
                    ? z.object({ getTestExecutions: pageSchema(issueModel) })
                    : z.object({ getTestRuns: pageSchema(runModel) });
  const result = schema.safeParse(data);
  if (!result.success) throw new XrayReadError("MALFORMED_RESPONSE");
  if (variables) {
    const value = result.data as Record<string, unknown>;
    const single = (
      name === "test" || name === "manualTest" || name === "coverage"
        ? value.getTest
        : name === "execution" ||
            name === "executionMembers" ||
            name === "executionSnapshot"
          ? value.getTestExecution
          : undefined
    ) as { issueId: string } | null | undefined;
    if (single && single.issueId !== variables.id)
      throw new XrayReadError("MALFORMED_RESPONSE");
    if (name === "runs") {
      const page = value.getTestRuns as z.infer<
        ReturnType<typeof pageSchema<typeof runModel>>
      >;
      if (
        page.results.some(
          (run) => run.testExecution.issueId !== (variables.ids as string[])[0],
        )
      )
        throw new XrayReadError("MALFORMED_RESPONSE");
    }
  }
  return result.data;
}
