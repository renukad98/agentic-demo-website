/** Official API codec and injectable offline exchange. No live registration or write enablement. */
import { z } from "zod";
import { proposalSchema, storyKey } from "../agentic/contracts/index.js";
import { objectDigest } from "../agentic/artifacts.js";
import type { JournalReservationRequest } from "../agentic/journal-reservation.js";
import {
  genericVariablesSchema,
  genericTestMutation,
  executionTestMutation,
  reporterSchema,
} from "./planner.js";
import {
  approvedApiBase,
  boundedTimeout,
  limitedJson,
  withTimeout,
  type HttpFetch,
} from "./clients/http.js";
import type { TokenProvider } from "./clients/authentication.js";
import { createProductionWriteExecutor } from "./write-integration.js";
import {
  kan29ManualCaseId,
  manualMutation,
  manualVariables,
} from "./manual-plan.js";
import {
  takeLocalCreationAttempt,
  takeLocalExecutionAttempt,
  takeLocalImportAttempt,
} from "./operation-journal.js";

const id = z.string().regex(/^[1-9][0-9]*$/);
const jiraFields = z
  .object({
    project: z
      .object({ key: z.string().regex(/^[A-Z][A-Z0-9]*$/), id })
      .strict(),
    issuetype: z.object({ id }).strict(),
    reporter: reporterSchema,
    summary: z.string().trim().min(1).max(255),
  })
  .strict();
export const executionVariablesSchema = z
  .object({
    testIssueIds: z
      .array(id)
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length),
    testEnvironments: z.array(z.string().trim().min(1)).min(1).max(10),
    jira: z.object({ fields: jiraFields }).strict(),
  })
  .strict();
const linkSchema = z
  .object({
    type: z.object({ id }).strict(),
    inwardIssue: z.object({ key: storyKey }).strict(),
    outwardIssue: z.object({ key: storyKey }).strict(),
  })
  .strict();
export const importBodySchema = z
  .object({
    testExecutionKey: storyKey,
    tests: z
      .array(
        z
          .object({
            testKey: storyKey,
            status: z.enum(["PASSED", "FAILED"]),
            start: z.string().datetime({ offset: true }).optional(),
            finish: z.string().datetime({ offset: true }).optional(),
            comment: z.string().max(16000),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((v) => new Set(v.map((t) => t.testKey)).size === v.length),
  })
  .strict();
export class PublicationTransportError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "AUTH_FAILED"
      | "WRITE_UNCERTAIN"
      | "RESPONSE_UNVERIFIED",
  ) {
    super(code);
    this.name = "PublicationTransportError";
  }
}
export function publicationRequest(raw: unknown) {
  try {
    const proposal = proposalSchema.parse(structuredClone(raw));
    if (
      proposal.payloadDigest !== objectDigest(proposal.payload) ||
      proposal.target !== proposal.storyKey
    )
      throw new Error();
    const p = proposal.payload;
    switch (proposal.operation) {
      case "xray.test.create": {
        if (
          Object.keys(p).sort().join() !== "mutation,query,variables" ||
          p.mutation !== "createTest" ||
          p.query !== genericTestMutation
        )
          throw new Error();
        const variables = genericVariablesSchema.parse(p.variables);
        if (
          !proposal.storyKey.startsWith(variables.jira.fields.project.key + "-")
        )
          throw new Error();
        return {
          operation: proposal.operation,
          path: "/api/v2/graphql" as const,
          body: { query: genericTestMutation, variables },
        };
      }
      case "xray.execution.create": {
        if (
          Object.keys(p).sort().join() !== "mutation,query,variables" ||
          p.mutation !== "createTestExecution" ||
          p.query !== executionTestMutation
        )
          throw new Error();
        const variables = executionVariablesSchema.parse(p.variables);
        if (
          !proposal.storyKey.startsWith(variables.jira.fields.project.key + "-")
        )
          throw new Error();
        return {
          operation: proposal.operation,
          path: "/api/v2/graphql" as const,
          body: { query: executionTestMutation, variables },
        };
      }
      case "xray.results.import": {
        if (
          Object.keys(p).sort().join() !== "body,endpoint" ||
          p.endpoint !== "/api/v2/import/execution"
        )
          throw new Error();
        const body = importBodySchema.parse(p.body),
          project = proposal.storyKey.split("-")[0]!;
        if (
          ![body.testExecutionKey, ...body.tests.map((t) => t.testKey)].every(
            (key) => key.startsWith(project + "-"),
          )
        )
          throw new Error();
        return {
          operation: proposal.operation,
          path: "/api/v2/import/execution" as const,
          body,
        };
      }
      case "jira.test.link": {
        const body = linkSchema.parse(p);
        if (
          body.outwardIssue.key !== proposal.storyKey ||
          !body.inwardIssue.key.startsWith(
            proposal.storyKey.split("-")[0] + "-",
          )
        )
          throw new Error();
        return {
          operation: proposal.operation,
          path: "/rest/api/3/issueLink" as const,
          body,
        };
      }
      default:
        throw new Error();
    }
  } catch {
    throw new PublicationTransportError("INVALID_REQUEST");
  }
}
/** Bind C/D and A/B to one identity per reservation. Multi-Test batches require separate reviewed scope. */
export function validatePublicationReservation(
  request: JournalReservationRequest,
  payload: unknown,
) {
  const prepared = publicationRequest({
    schemaVersion: "1.0.0",
    storyKey: request.target,
    target: request.target,
    operation: request.operation,
    payload,
    payloadDigest: request.payloadDigest,
    evidenceDigest: request.evidenceDigest,
    remoteWritesEnabled: false,
  });
  try {
    switch (prepared.operation) {
      case "xray.test.create":
        if (
          prepared.body.variables.unstructured !== request.automationIdentity ||
          prepared.body.variables.jira.fields.project.key !== request.projectKey
        )
          throw new Error();
        break;
      case "jira.test.link":
        if (prepared.body.inwardIssue.key !== request.testKey)
          throw new Error();
        break;
      case "xray.execution.create":
        if (
          prepared.body.variables.testIssueIds.length !== 1 ||
          prepared.body.variables.testIssueIds[0] !== request.testIssueId ||
          prepared.body.variables.jira.fields.project.key !== request.projectKey
        )
          throw new Error();
        break;
      case "xray.results.import":
        if (
          prepared.body.testExecutionKey !== request.executionKey ||
          prepared.body.tests.length !== 1 ||
          prepared.body.tests[0]!.testKey !== request.testKey
        )
          throw new Error();
    }
  } catch {
    throw new PublicationTransportError("INVALID_REQUEST");
  }
}

/** Real HTTP wire implementation exercised only through explicitly injected offline ports.
 * Dependency injection is not an authorization boundary. execute() never dispatches production writes.
 */
export class XrayPublicationTransport {
  readonly productionExecution = "DISABLED";
  #base: string;
  #timeout: number;
  constructor(apiBase: string, timeoutMs = 10000) {
    this.#base = approvedApiBase(apiBase);
    this.#timeout = boundedTimeout(timeoutMs);
  }
  execute(): never {
    return createProductionWriteExecutor();
  }
  async exchangeForOfflineValidation(
    raw: unknown,
    ports: { fetch: HttpFetch; tokens: TokenProvider },
  ): Promise<unknown> {
    return this.#exchange(raw, ports);
  }
  async executeLocalCreation(
    raw: unknown,
    ports: { fetch: HttpFetch; tokens: TokenProvider },
    ticket: object,
  ): Promise<unknown> {
    const proposal = proposalSchema.parse(structuredClone(raw));
    if (
      this.#base !== "https://xray.cloud.getxray.app" ||
      publicationRequest(proposal).operation !== "xray.test.create" ||
      proposal.storyKey !== "KAN-25"
    )
      throw new PublicationTransportError("INVALID_REQUEST");
    takeLocalCreationAttempt(ticket, proposal.payloadDigest);
    return this.#exchange(proposal, ports);
  }
  async executeLocalExecution(
    raw: unknown,
    ports: { fetch: HttpFetch; tokens: TokenProvider },
    ticket: object,
  ): Promise<unknown> {
    const proposal = proposalSchema.parse(structuredClone(raw));
    const request = publicationRequest(proposal);
    if (
      this.#base !== "https://xray.cloud.getxray.app" ||
      proposal.storyKey !== "KAN-25" ||
      request.operation !== "xray.execution.create" ||
      objectDigest(request.body.variables.testIssueIds) !==
        objectDigest(["10066"]) ||
      objectDigest(request.body.variables.testEnvironments) !==
        objectDigest(["chromium"]) ||
      request.body.variables.jira.fields.project.key !== "KAN" ||
      request.body.variables.jira.fields.project.id !== "10001" ||
      request.body.variables.jira.fields.issuetype.id !== "10046" ||
      request.body.variables.jira.fields.reporter.accountId !==
        "712020:a8fac447-b5f9-4da3-a23a-bb24d61b4baa" ||
      request.body.variables.jira.fields.summary !==
        "Automated validation for KAN-25"
    )
      throw new PublicationTransportError("INVALID_REQUEST");
    takeLocalExecutionAttempt(ticket, proposal.payloadDigest);
    return this.#exchange(proposal, ports);
  }
  async executeLocalImport(
    raw: unknown,
    ports: { fetch: HttpFetch; tokens: TokenProvider },
    ticket: object,
  ): Promise<unknown> {
    const proposal = proposalSchema.parse(structuredClone(raw));
    const request = publicationRequest(proposal);
    if (
      this.#base !== "https://xray.cloud.getxray.app" ||
      proposal.storyKey !== "KAN-25" ||
      request.operation !== "xray.results.import" ||
      request.body.testExecutionKey !== "KAN-27" ||
      request.body.tests.length !== 1 ||
      request.body.tests[0]?.testKey !== "KAN-26" ||
      request.body.tests[0].status !== "PASSED"
    )
      throw new PublicationTransportError("INVALID_REQUEST");
    takeLocalImportAttempt(ticket, proposal.payloadDigest);
    return this.#exchange(proposal, ports);
  }
  async #exchange(
    raw: unknown,
    ports: { fetch: HttpFetch; tokens: TokenProvider },
  ): Promise<unknown> {
    const request = publicationRequest(raw);
    if (request.operation === "jira.test.link")
      throw new PublicationTransportError("INVALID_REQUEST");
    return this.#send(request, ports);
  }
  async executeLocalManual(
    raw: unknown,
    ports: { fetch: HttpFetch; tokens: TokenProvider },
    ticket: object,
  ): Promise<unknown> {
    const proposal = proposalSchema.parse(structuredClone(raw));
    const payload = proposal.payload;
    const variables = manualVariables.parse(payload.variables);
    const kan29Case = variables.jira.fields.summary.split(": ", 1)[0];
    const allowedStory =
      proposal.storyKey === "KAN-25" ||
      (proposal.storyKey === "KAN-29" &&
        kan29ManualCaseId.safeParse(kan29Case).success &&
        variables.jira.fields.description.startsWith(
          `Manual case: agentic-demo-website:manual:KAN-29:${kan29Case}\nStory: KAN-29\n`,
        ));
    if (
      this.#base !== "https://xray.cloud.getxray.app" ||
      proposal.operation !== "xray.test.create" ||
      !allowedStory ||
      proposal.target !== proposal.storyKey ||
      payload.mutation !== "createTest" ||
      payload.query !== manualMutation ||
      proposal.payloadDigest !==
        objectDigest({
          mutation: "createTest",
          query: manualMutation,
          variables,
        })
    )
      throw new PublicationTransportError("INVALID_REQUEST");
    takeLocalCreationAttempt(ticket, proposal.payloadDigest);
    return this.#send(
      { path: "/api/v2/graphql", body: { query: manualMutation, variables } },
      ports,
    );
  }
  async #send(
    request: { path: string; body: unknown },
    ports: { fetch: HttpFetch; tokens: TokenProvider },
  ) {
    let token: string;
    try {
      token = await withTimeout(
        () => ports.tokens.getToken(this.#base),
        this.#timeout,
        "publication-auth",
      );
      if (!token || !/^[A-Za-z0-9._-]+$/.test(token)) throw new Error();
    } catch {
      throw new PublicationTransportError("AUTH_FAILED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      return await withTimeout(
        async () => {
          const response = await ports.fetch(this.#base + request.path, {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              authorization: "Bearer " + token,
            },
            body: JSON.stringify(request.body),
          });
          if (
            !response.ok ||
            response.redirected ||
            (response.url && response.url !== this.#base + request.path) ||
            !/^application\/(json|graphql-response\+json)(\s*;|$)/i.test(
              response.headers.get("content-type") ?? "",
            )
          ) {
            void response.body?.cancel().catch(() => undefined);
            throw new Error();
          }
          const result = await limitedJson(response, 1024 * 1024);
          if (
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            ("errors" in result &&
              (!Array.isArray(result.errors) || result.errors.length)) ||
            ("data" in result && !result.data)
          )
            throw new Error();
          // Acceptance is not confirmation: exact operation read-back is mandatory.
          return result;
        },
        this.#timeout,
        "publication-write",
      );
    } catch {
      throw new PublicationTransportError("WRITE_UNCERTAIN");
    } finally {
      clearTimeout(timer);
      controller.abort();
      token = "";
    }
  }
  toJSON() {
    return {
      type: "XrayPublicationTransport",
      productionExecution: this.productionExecution,
    };
  }
}

/** Uses the existing authenticated Jira MCP connection supplied by a future protected host. */
export class JiraMcpLinkAdapter {
  #timeout: number;
  constructor(timeoutMs = 10000) {
    this.#timeout = boundedTimeout(timeoutMs);
  }
  execute(): never {
    return createProductionWriteExecutor();
  }
  async exchangeForOfflineValidation(
    raw: unknown,
    linkType: { id: string; name: string; inward: string; outward: string },
    invoke: (inputs: {
      linkType: string;
      inwardIssue: string;
      outwardIssue: string;
    }) => Promise<unknown>,
  ) {
    const request = publicationRequest(raw);
    if (
      request.operation !== "jira.test.link" ||
      linkType.id !== request.body.type.id ||
      linkType.name !== "Test" ||
      linkType.inward !== "is tested by" ||
      linkType.outward !== "tests"
    )
      throw new PublicationTransportError("INVALID_REQUEST");
    try {
      return await withTimeout(
        () =>
          invoke({
            linkType: linkType.name,
            inwardIssue: request.body.inwardIssue.key,
            outwardIssue: request.body.outwardIssue.key,
          }),
        this.#timeout,
        "jira-link",
      );
    } catch {
      throw new PublicationTransportError("WRITE_UNCERTAIN");
    }
  }
}
