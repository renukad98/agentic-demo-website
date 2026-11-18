/** Inert production-shaped requests only. No transport, authentication or writer registration. */
import { z } from "zod";
import { objectDigest } from "../agentic/artifacts.js";
import { proposalSchema, type Identity } from "../agentic/contracts/index.js";
import {
  journalReservationRequestSchema,
  type JournalReservationRequest,
} from "../agentic/journal-reservation.js";
import { TrustedHumanApprovalBoundary } from "../agentic/approval-authority.js";
import { IdentityRegistry, identityKey, verifyBinding } from "./identity.js";
import {
  genericProposal,
  genericVariablesSchema,
  linkProposal,
  duplicateDecision,
} from "./planner.js";
import { OperationJournal } from "./operation-journal.js";
import {
  createProductionWriteExecutor,
  writeOperationId,
} from "./write-integration.js";
import { approvedApiBase } from "./clients/http.js";

const id = z.string().regex(/^[1-9][0-9]*$/),
  key = z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
const contextSchema = z
  .object({
    tenant: z.string().min(1),
    projectKey: z.string().regex(/^[A-Z][A-Z0-9]*$/),
    projectId: id,
    testIssueTypeId: id,
    xrayApiBase: z.string(),
    jiraOrigin: z.string(),
  })
  .strict();
export type ExecutorContext = z.infer<typeof contextSchema>;
const preflightSchema = z
  .object({
    tenant: z.string().min(1),
    projectKey: z.string(),
    storyKey: key,
    identity: z.string(),
    sourceDigest: z.string(),
    evidenceDigest: z.string(),
    payloadDigest: z.string(),
    xrayApiBase: z.string(),
    jiraOrigin: z.string(),
    startedAt: z.number().int(),
    checkedAt: z.number().int(),
    complete: z.literal(true),
    ambiguous: z.boolean(),
    pages: z
      .array(
        z
          .object({
            total: z.number().int().nonnegative(),
            start: z.number().int().nonnegative(),
            ids: z.array(id),
          })
          .strict(),
      )
      .min(1),
    candidates: z.array(
      z
        .object({
          key,
          issueId: id,
          identity: z.string(),
          behaviorDigest: z.string(),
          type: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type CreationPreflight = z.infer<typeof preflightSchema>;
const linkTypeSchema = z
  .object({
    id,
    name: z.literal("Test"),
    inward: z.literal("is tested by"),
    outward: z.literal("tests"),
  })
  .strict();
const linkObservationSchema = z
  .object({
    preflight: preflightSchema,
    story: z
      .object({
        key,
        issueId: id,
        projectKey: z.string(),
        issueType: z.literal("Story"),
      })
      .strict(),
    test: z
      .object({
        key,
        issueId: id,
        projectKey: z.string(),
        testType: z.literal("Generic"),
        unstructured: z.string(),
      })
      .strict(),
    linkType: linkTypeSchema,
    links: z.array(
      z
        .object({
          testKey: key,
          storyKey: key,
          typeId: id,
          direction: z.enum(["tests", "is tested by"]),
        })
        .strict(),
    ),
  })
  .strict();
export type LinkObservation = z.infer<typeof linkObservationSchema>;
export interface PreparationInput {
  proposal: z.infer<typeof proposalSchema>;
  identity: Identity;
  approvalRequest: JournalReservationRequest;
  approvalReference: string;
}
function jsonDigest(value: unknown) {
  return objectDigest(JSON.parse(JSON.stringify(value)));
}

/** Shared validation only, preserving the existing publisher as the sole disabled boundary. */
class PreparationBase {
  protected readonly context: ExecutorContext;
  constructor(
    protected readonly root: string,
    protected readonly registry: IdentityRegistry,
    protected readonly journal: OperationJournal,
    context: ExecutorContext,
    protected readonly approval = new TrustedHumanApprovalBoundary(),
    protected readonly now = Date.now,
  ) {
    this.context = contextSchema.parse(structuredClone(context));
    this.context.xrayApiBase = approvedApiBase(this.context.xrayApiBase);
    const jira = new URL(this.context.jiraOrigin);
    if (
      jira.protocol !== "https:" ||
      jira.username ||
      jira.password ||
      jira.port ||
      jira.search ||
      jira.hash ||
      jira.pathname !== "/" ||
      !/^[-a-z0-9]+\.atlassian\.net$/i.test(jira.hostname)
    )
      throw new Error("INVALID_JIRA_ORIGIN");
    this.context.jiraOrigin = jira.origin;
  }
  protected async validate(
    input: PreparationInput,
    observation: CreationPreflight,
    wholeObservation: unknown = observation,
  ) {
    const proposal = proposalSchema.parse(input.proposal),
      request = journalReservationRequestSchema.parse(input.approvalRequest),
      identity = input.identity;
    if (
      proposal.payloadDigest !== objectDigest(proposal.payload) ||
      proposal.payloadDigest !== request.payloadDigest
    )
      throw new Error("EXECUTOR_PAYLOAD_DIGEST");
    const expectedOperationId = writeOperationId({
      tenant: this.context.tenant,
      projectKey: this.context.projectKey,
      operation: proposal.operation as "xray.test.create" | "jira.test.link",
      payloadDigest: proposal.payloadDigest,
    });
    if (
      request.tenant !== this.context.tenant ||
      request.projectKey !== this.context.projectKey ||
      request.target !== proposal.storyKey ||
      proposal.target !== proposal.storyKey ||
      request.operation !== proposal.operation ||
      request.operationId !== expectedOperationId ||
      request.automationIdentity !== identityKey(identity) ||
      request.sourceDigest !== identity.sourceDigest ||
      request.evidenceDigest !== proposal.evidenceDigest
    )
      throw new Error("EXECUTOR_CONTEXT");
    const registered = this.registry.resolveRunner(
      identity.repository,
      identity.runner,
      identity.binding!.runnerIds[0]!,
      proposal.storyKey,
    );
    if (jsonDigest(registered) !== jsonDigest(identity))
      throw new Error("EXECUTOR_IDENTITY_CONFLICT");
    const proof = await verifyBinding(this.root, identity);
    if (proof.evidenceDigest !== proposal.evidenceDigest)
      throw new Error("EXECUTOR_EVIDENCE");
    const preflight = preflightSchema.parse(observation);
    if (
      request.preflightDigest !== objectDigest(wholeObservation) ||
      preflight.tenant !== this.context.tenant ||
      preflight.projectKey !== this.context.projectKey ||
      preflight.storyKey !== proposal.storyKey ||
      preflight.identity !== identityKey(identity) ||
      preflight.sourceDigest !== proof.sourceDigest ||
      preflight.evidenceDigest !== proof.evidenceDigest ||
      preflight.payloadDigest !== proposal.payloadDigest ||
      preflight.xrayApiBase !== this.context.xrayApiBase ||
      preflight.jiraOrigin !== this.context.jiraOrigin
    )
      throw new Error("EXECUTOR_PREFLIGHT_BINDING");
    if (
      preflight.startedAt > preflight.checkedAt ||
      preflight.checkedAt > this.now() ||
      this.now() - preflight.startedAt > 300000 ||
      preflight.ambiguous
    )
      throw new Error("EXECUTOR_PREFLIGHT_STALE_OR_AMBIGUOUS");
    const seen = new Set<string>();
    let count = 0;
    const total = preflight.pages[0]!.total;
    for (const page of preflight.pages) {
      if (
        page.total !== total ||
        page.start !== count ||
        (!page.ids.length && count < total)
      )
        throw new Error("EXECUTOR_INCOMPLETE_PAGINATION");
      for (const id of page.ids) {
        if (seen.has(id)) throw new Error("EXECUTOR_DUPLICATE_PAGE_ID");
        seen.add(id);
      }
      count += page.ids.length;
    }
    if (
      count !== total ||
      count !== preflight.candidates.length ||
      preflight.candidates.some(
        (c) =>
          !seen.has(c.issueId) ||
          !c.key.startsWith(this.context.projectKey + "-"),
      ) ||
      new Set(preflight.candidates.map((c) => c.issueId)).size !== count
    )
      throw new Error("EXECUTOR_INCOMPLETE_PREFLIGHT");
    await this.journal.assertNoUncertainOperations();
    return { proposal, request, preflight };
  }
  execute(): never {
    return createProductionWriteExecutor();
  }
}

export class GenericTestCreationAdapter extends PreparationBase {
  async prepare(raw: PreparationInput, rawPreflight: CreationPreflight) {
    const input = structuredClone(raw),
      preflight = structuredClone(rawPreflight);
    const validated = await this.validate(input, preflight),
      { proposal, request } = validated;
    if (proposal.operation !== "xray.test.create" || input.identity.xray)
      throw new Error("EXECUTOR_CREATION_REQUIRED");
    const variables = genericVariablesSchema.parse(proposal.payload.variables),
      fields = variables.jira.fields;
    if (
      fields.project.key !== this.context.projectKey ||
      fields.project.id !== this.context.projectId ||
      fields.issuetype.id !== this.context.testIssueTypeId
    )
      throw new Error("EXECUTOR_JIRA_FIELDS");
    const reconstructed = genericProposal(
      proposal.storyKey,
      this.context.projectKey,
      input.identity,
      fields.summary,
      {
        projectId: this.context.projectId,
        issueTypeId: this.context.testIssueTypeId,
        reporter: fields.reporter,
      },
    );
    if (objectDigest(reconstructed) !== objectDigest(proposal))
      throw new Error("EXECUTOR_NONCANONICAL_PROPOSAL");
    const duplicate = duplicateDecision(
      input.identity,
      validated.preflight.candidates,
      true,
    );
    if (
      duplicate.disposition !== "new" ||
      (
        await this.journal.findCreation(
          this.context.tenant,
          this.context.projectKey,
          identityKey(input.identity),
        )
      ).length
    )
      throw new Error("EXECUTOR_DUPLICATE_TEST");
    const authorization = await this.approval.authorizeAndReserve(
      this.journal,
      input.approvalReference,
      request,
      proposal.payload,
    );
    return {
      status: "PREPARED_DISABLED" as const,
      authorization,
      proposal,
      request: {
        method: "POST" as const,
        origin: this.context.xrayApiBase,
        path: "/api/v2/graphql",
        body: {
          query: proposal.payload.query,
          variables: proposal.payload.variables,
        },
      },
      remoteWritesEnabled: false as const,
    };
  }
}

export class JiraStoryLinkAdapter extends PreparationBase {
  async prepare(raw: PreparationInput, rawObservation: LinkObservation) {
    const input = structuredClone(raw),
      observation = linkObservationSchema.parse(
        structuredClone(rawObservation),
      );
    const { proposal, request } = await this.validate(
      input,
      observation.preflight,
      observation,
    );
    if (
      !observation.preflight.candidates.some(
        (c) =>
          c.issueId === observation.test.issueId &&
          c.key === observation.test.key &&
          c.identity === identityKey(input.identity) &&
          c.type === "Generic",
      )
    )
      throw new Error("EXECUTOR_TEST_NOT_VISIBLE_IN_PREFLIGHT");
    if (
      proposal.operation !== "jira.test.link" ||
      request.testKey !== observation.test.key ||
      request.testIssueId !== observation.test.issueId ||
      observation.test.projectKey !== this.context.projectKey ||
      observation.test.unstructured !== identityKey(input.identity) ||
      observation.story.key !== proposal.storyKey ||
      observation.story.projectKey !== this.context.projectKey
    )
      throw new Error("EXECUTOR_LINK_CONTEXT");
    const confirmed = (
      await this.journal.findCreation(
        this.context.tenant,
        this.context.projectKey,
        identityKey(input.identity),
      )
    ).find(
      (e) =>
        e.status === "Confirmed" &&
        e.remoteTestKey === observation.test.key &&
        e.remoteIds.length === 1 &&
        e.remoteIds[0] === observation.test.issueId,
    );
    if (!confirmed) throw new Error("EXECUTOR_CONFIRMED_TEST_REQUIRED");
    const expected = linkProposal(
      proposal.storyKey,
      observation.test.key,
      observation.linkType,
      proposal.evidenceDigest,
    );
    if (objectDigest(expected) !== objectDigest(proposal))
      throw new Error("EXECUTOR_LINK_PAYLOAD");
    const matching = observation.links.filter(
      (l) =>
        l.testKey === observation.test.key && l.storyKey === proposal.storyKey,
    );
    if (
      matching.some(
        (l) => l.typeId !== observation.linkType.id || l.direction !== "tests",
      )
    )
      throw new Error("EXECUTOR_CONFLICTING_LINK");
    if (matching.length)
      return {
        status: "NO_WRITE_ALREADY_LINKED" as const,
        remoteWritesEnabled: false as const,
      };
    const authorization = await this.approval.authorizeAndReserve(
      this.journal,
      input.approvalReference,
      request,
      proposal.payload,
    );
    return {
      status: "PREPARED_DISABLED" as const,
      authorization,
      proposal,
      request: {
        method: "POST" as const,
        origin: this.context.jiraOrigin,
        path: "/rest/api/3/issueLink",
        body: proposal.payload,
      },
      remoteWritesEnabled: false as const,
    };
  }
}

/** Pure response classification, not read-back confirmation or an execution result. */
export function inspectGenericCreationResponse(
  raw: unknown,
  projectKey: string,
  identity: string,
) {
  const partial = z
    .object({
      data: z.object({
        createTest: z
          .object({
            test: z
              .object({
                issueId: z.unknown().optional(),
                jira: z.unknown().optional(),
                testType: z.unknown().optional(),
                unstructured: z.unknown().optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      }),
    })
    .safeParse(raw);
  const envelope = z
    .object({
      data: z
        .object({
          createTest: z
            .object({
              test: z
                .object({
                  issueId: z.unknown().optional(),
                  jira: z.unknown().optional(),
                  testType: z.unknown().optional(),
                  unstructured: z.unknown().optional(),
                })
                .passthrough(),
              warnings: z.array(z.unknown()).optional(),
            })
            .passthrough(),
        })
        .nullable()
        .optional(),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(raw);
  const test = partial.success ? partial.data.data.createTest.test : undefined;
  const parsedId = id.safeParse(test?.issueId),
    parsedKey = z.object({ key }).safeParse(test?.jira);
  const observed = {
    ...(parsedId.success ? { issueId: parsedId.data } : {}),
    ...(parsedKey.success ? { testKey: parsedKey.data.key } : {}),
  };
  const validType = z
    .object({ name: z.literal("Generic") })
    .safeParse(test?.testType).success;
  if (
    !envelope.success ||
    envelope.data.errors?.length ||
    !parsedId.success ||
    !parsedKey.success ||
    !parsedKey.data.key.startsWith(projectKey + "-") ||
    !validType ||
    test?.unstructured !== identity
  )
    return { status: "UNCERTAIN_RECONCILE" as const, ...observed };
  if (envelope.data.data?.createTest.warnings?.length)
    return { status: "REVIEW_WARNINGS" as const, ...observed };
  return { status: "REQUIRES_READ_BACK" as const, ...observed };
}
