/** TEST-ONLY integration harness. Never imported by tools or application entry points.
 * Transports accept data, not callbacks/URLs; they cannot perform network operations.
 */
import { z } from "zod";
import type { Identity } from "../../../tools/agentic/contracts/index.js";
import { proposalSchema } from "../../../tools/agentic/contracts/index.js";
import { objectDigest } from "../../../tools/agentic/artifacts.js";
import {
  TrustedApprovalGate,
  type TrustedApprovalRequest,
} from "../../../tools/agentic/approvals.js";
import {
  IdentityRegistry,
  identityKey,
  verifyBinding,
} from "../../../tools/xray/identity.js";
import {
  genericProposal,
  genericVariablesSchema,
  linkProposal,
} from "../../../tools/xray/planner.js";
import { OperationJournal } from "../../../tools/xray/operation-journal.js";
import {
  writeApprovalRequestSchema,
  writeOperationId,
  type GenericMutationTransport,
  type JiraLinkTransport,
} from "../../../tools/xray/write-integration.js";

const key = z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
const id = z.string().regex(/^[1-9][0-9]*$/);
const linkType = {
  id: "10037",
  name: "Test",
  inward: "is tested by",
  outward: "tests",
};
export type Proposal = z.infer<typeof proposalSchema>;
export interface Clearance {
  tenant: string;
  projectKey: string;
  storyKey: string;
  identity: string;
  sourceDigest: string;
  evidenceDigest: string;
  checkedAt: number;
  complete: boolean;
  matches: number;
}
export interface ReadBack {
  issueId: string;
  testKey: string;
  projectKey: string;
  storyKey: string;
  identity: string;
  testType: string;
  payloadDigest: string;
  links: {
    testKey: string;
    storyKey: string;
    typeId: string;
    direction: string;
  }[];
}
const genuineTransports = new WeakSet<object>();
export class MockWriteTransport
  implements GenericMutationTransport, JiraLinkTransport
{
  #response: unknown;
  #readBack: ReadBack | null;
  #failure: boolean;
  #afterLink: ReadBack | null;
  createCalls = 0;
  linkCalls = 0;
  constructor(
    response: unknown,
    readBack: ReadBack | null,
    failure = false,
    afterLink: ReadBack | null = readBack,
  ) {
    this.#response = structuredClone(response);
    this.#readBack = structuredClone(readBack);
    this.#failure = failure;
    this.#afterLink = structuredClone(afterLink);
    genuineTransports.add(this);
    Object.seal(this);
  }
  async create(_payload: unknown) {
    this.createCalls++;
    if (this.#failure) throw new Error("MOCK_TIMEOUT");
    return structuredClone(this.#response);
  }
  async link(_payload: unknown) {
    this.linkCalls++;
    if (this.#failure) throw new Error("MOCK_TIMEOUT");
    this.#readBack = structuredClone(this.#afterLink);
  }
  async read() {
    return structuredClone(this.#readBack);
  }
}

export class MockWriteExecutors {
  constructor(
    private readonly root: string,
    private readonly tenant: string,
    private readonly projectKey: string,
    private readonly registry: IdentityRegistry,
    private readonly journal: OperationJournal,
    private readonly gate: TrustedApprovalGate,
    private readonly transport: MockWriteTransport,
    private readonly now = Date.now,
  ) {
    if (
      !genuineTransports.has(transport) ||
      Object.getPrototypeOf(transport) !== MockWriteTransport.prototype
    )
      throw new Error("TEST_TRANSPORT_REQUIRED");
  }
  request(
    proposal: Proposal,
    identity: Identity,
    testKey?: string,
  ): TrustedApprovalRequest {
    return writeApprovalRequestSchema.parse({
      schemaVersion: "1.0.0",
      tenant: this.tenant,
      projectKey: this.projectKey,
      operationId: writeOperationId({
        tenant: this.tenant,
        projectKey: this.projectKey,
        operation: proposal.operation as "xray.test.create" | "jira.test.link",
        payloadDigest: proposal.payloadDigest,
      }),
      operation: proposal.operation,
      target: proposal.storyKey,
      automationIdentity: identityKey(identity),
      sourceDigest: identity.sourceDigest,
      evidenceDigest: proposal.evidenceDigest,
      payloadDigest: proposal.payloadDigest,
      scope: [proposal.operation],
      ...(testKey ? { testKey } : {}),
    });
  }
  private async verify(proposal: Proposal, identity: Identity) {
    proposalSchema.parse(proposal);
    if (
      proposal.target !== proposal.storyKey ||
      proposal.payloadDigest !== objectDigest(proposal.payload)
    )
      throw new Error("PROPOSAL_BINDING");
    const registered = this.registry.resolveRunner(
      identity.repository,
      identity.runner,
      identity.binding!.runnerIds[0]!,
      proposal.storyKey,
    );
    // Registry's optional xray member may be explicitly undefined; hash its JSON value.
    if (
      objectDigest(JSON.parse(JSON.stringify(registered))) !==
      objectDigest(JSON.parse(JSON.stringify(identity)))
    )
      throw new Error("IDENTITY_CONFLICT");
    const proof = await verifyBinding(this.root, identity);
    if (proof.evidenceDigest !== proposal.evidenceDigest)
      throw new Error("EVIDENCE_BINDING");
    await this.journal.assertNoUncertainOperations();
  }
  private async begin(
    proposal: Proposal,
    identity: Identity,
    request: TrustedApprovalRequest,
    reference: string,
    testKey?: string,
  ) {
    const expected = this.request(proposal, identity, testKey);
    writeApprovalRequestSchema.parse(request);
    if (objectDigest(request) !== objectDigest(expected))
      throw new Error("APPROVAL_CONTEXT");
    const base = {
      schemaVersion: "1.0.0" as const,
      operationId: expected.operationId,
      storyKey: proposal.storyKey,
      operation: proposal.operation,
      payloadDigest: proposal.payloadDigest,
      tenant: this.tenant,
      projectKey: this.projectKey,
      sourceDigest: identity.sourceDigest,
      evidenceDigest: proposal.evidenceDigest,
      automationIdentity: identityKey(identity),
      remoteIds: [] as string[],
    };
    const record = async (
      status: "Planned" | "Awaiting approval" | "Approved" | "Attempted",
      extra = {},
    ) =>
      this.journal.record({
        ...base,
        status,
        at: new Date(this.now()).toISOString(),
        ...extra,
      });
    await record("Planned"); // Atomic journal lock/unique snapshot before consuming or calling transport.
    await record("Awaiting approval");
    const receipt = await this.gate.consume(
      reference,
      expected,
      proposal.payload,
    );
    const authorization = {
      approvalReference: reference,
      approvalConsumptionId: receipt.consumptionId,
    };
    await record("Approved", authorization);
    if (this.now() >= Date.parse(receipt.expiresAt))
      throw new Error("APPROVAL_EXPIRED_BEFORE_ATTEMPT");
    await record("Attempted", authorization); // Persist before the single attempt. Crash => reconciliation.
    if (this.now() >= Date.parse(receipt.expiresAt))
      throw new Error("ATTEMPT_RESERVED_RECONCILIATION_REQUIRED");
    return { ...base, ...authorization };
  }
  private async verifyReadBack(
    identity: Identity,
    proposal: Proposal,
    remote: { issueId: string; testKey: string },
  ) {
    const read = await this.transport.read();
    if (
      !read ||
      read.issueId !== remote.issueId ||
      read.testKey !== remote.testKey ||
      read.projectKey !== this.projectKey ||
      read.storyKey !== proposal.storyKey ||
      read.identity !== identityKey(identity) ||
      read.testType !== "Generic" ||
      read.payloadDigest !== proposal.payloadDigest
    )
      throw new Error("READ_BACK_REQUIRED");
    return read;
  }
  async create(
    raw: Proposal,
    identity: Identity,
    clearance: Clearance,
    request: TrustedApprovalRequest,
    reference: string,
  ) {
    const proposal = proposalSchema.parse(structuredClone(raw));
    identity = structuredClone(identity);
    clearance = structuredClone(clearance);
    request = structuredClone(request);
    await this.verify(proposal, identity);
    if (proposal.operation !== "xray.test.create" || identity.xray)
      throw new Error("CREATE_CONTEXT");
    const variables = genericVariablesSchema.parse(proposal.payload.variables);
    const expected = genericProposal(
      proposal.storyKey,
      this.projectKey,
      identity,
      variables.jira.fields.summary,
      {
        projectId: variables.jira.fields.project.id,
        issueTypeId: variables.jira.fields.issuetype.id,
        reporter: variables.jira.fields.reporter,
      },
    );
    if (objectDigest(expected) !== objectDigest(proposal))
      throw new Error("CREATE_PAYLOAD");
    if (
      !clearance ||
      clearance.tenant !== this.tenant ||
      clearance.projectKey !== this.projectKey ||
      clearance.storyKey !== proposal.storyKey ||
      clearance.identity !== identityKey(identity) ||
      clearance.sourceDigest !== identity.sourceDigest ||
      clearance.evidenceDigest !== proposal.evidenceDigest ||
      !clearance.complete ||
      clearance.matches !== 0 ||
      !Number.isFinite(clearance.checkedAt) ||
      this.now() - clearance.checkedAt > 300_000 ||
      clearance.checkedAt > this.now()
    )
      throw new Error("DUPLICATE_CLEARANCE");
    const base = await this.begin(proposal, identity, request, reference);
    let issueId: string | undefined;
    let testKey: string | undefined;
    try {
      if (
        this.now() - clearance.checkedAt > 300_000 ||
        objectDigest(proposal.payload) !== proposal.payloadDigest
      )
        throw new Error("ATTEMPT_INPUTS_STALE");
      const rawResponse = await this.transport.create(
        structuredClone(proposal.payload),
      );
      const partial = z
        .object({
          data: z.object({
            createTest: z
              .object({
                test: z
                  .object({
                    issueId: z.unknown().optional(),
                    jira: z.unknown().optional(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          }),
        })
        .parse(rawResponse);
      const returned = partial.data.createTest.test;
      const parsedId = id.safeParse(returned.issueId);
      if (parsedId.success) issueId = parsedId.data;
      const parsedKey = z.object({ key }).safeParse(returned.jira);
      if (parsedKey.success) testKey = parsedKey.data.key;
      if (!issueId || !testKey || !testKey.startsWith(this.projectKey + "-"))
        throw new Error("PARTIAL_RESPONSE");
      const definition = z
        .object({
          testType: z.object({ name: z.literal("Generic") }),
          unstructured: z.literal(identityKey(identity)),
        })
        .safeParse(returned);
      if (!definition.success || (rawResponse as { errors?: unknown }).errors)
        throw new Error("INVALID_CREATION_RESPONSE");
      const read = await this.verifyReadBack(identity, proposal, {
        issueId,
        testKey,
      });
      await this.journal.record({
        ...base,
        status: "Confirmed",
        remoteIds: [issueId],
        remoteTestKey: testKey,
        at: new Date(this.now()).toISOString(),
      });
      return { kind: "MOCK_ONLY" as const, issueId, testKey, read };
    } catch {
      await this.journal.record({
        ...base,
        status: "Uncertain",
        remoteIds: issueId ? [issueId] : [],
        ...(testKey ? { remoteTestKey: testKey } : {}),
        errorCode: "TRANSPORT",
        at: new Date(this.now()).toISOString(),
      });
      throw new Error("CREATE_UNCERTAIN_RECONCILE");
    }
  }
  async link(
    creation: Proposal,
    identity: Identity,
    request: TrustedApprovalRequest,
    reference: string,
  ) {
    creation = structuredClone(creation);
    identity = structuredClone(identity);
    request = structuredClone(request);
    await this.verify(creation, identity);
    if (creation.operation !== "xray.test.create")
      throw new Error("CREATION_REQUIRED");
    const creationRequest = this.request(creation, identity);
    const confirmed = (
      await this.journal.entries(creationRequest.operationId)
    ).at(-1);
    if (
      confirmed?.status !== "Confirmed" ||
      !confirmed.remoteTestKey ||
      confirmed.remoteIds.length !== 1
    )
      throw new Error("CONFIRMED_TEST_REQUIRED");
    const read = await this.verifyReadBack(identity, creation, {
      issueId: confirmed.remoteIds[0]!,
      testKey: confirmed.remoteTestKey,
    });
    const proposal = linkProposal(
      creation.storyKey,
      confirmed.remoteTestKey,
      linkType,
      creation.evidenceDigest,
    );
    // Verify the entire exact link request before even returning an already-present outcome.
    if (
      objectDigest(request) !==
      objectDigest(this.request(proposal, identity, confirmed.remoteTestKey))
    )
      throw new Error("LINK_CONTEXT");
    if (
      read.links.some(
        (l) =>
          l.testKey === confirmed.remoteTestKey &&
          (l.storyKey !== creation.storyKey ||
            l.typeId !== linkType.id ||
            l.direction !== "tests"),
      )
    )
      throw new Error("CONFLICTING_LINK");
    if (
      read.links.some(
        (l) =>
          l.testKey === confirmed.remoteTestKey &&
          l.storyKey === creation.storyKey &&
          l.typeId === linkType.id &&
          l.direction === "tests",
      )
    )
      return { kind: "MOCK_ALREADY_LINKED" as const };
    const base = await this.begin(
      proposal,
      identity,
      request,
      reference,
      confirmed.remoteTestKey,
    );
    try {
      await this.transport.link(structuredClone(proposal.payload));
      const after = await this.transport.read();
      if (
        !after?.links.some(
          (l) =>
            l.testKey === confirmed.remoteTestKey &&
            l.storyKey === creation.storyKey &&
            l.typeId === linkType.id &&
            l.direction === "tests",
        )
      )
        throw new Error("LINK_READ_BACK");
      await this.journal.record({
        ...base,
        status: "Confirmed",
        remoteIds: [confirmed.remoteIds[0]!],
        remoteTestKey: confirmed.remoteTestKey,
        at: new Date(this.now()).toISOString(),
      });
      return { kind: "MOCK_ONLY" as const };
    } catch {
      await this.journal.record({
        ...base,
        status: "Uncertain",
        remoteIds: [confirmed.remoteIds[0]!],
        remoteTestKey: confirmed.remoteTestKey,
        errorCode: "TRANSPORT",
        at: new Date(this.now()).toISOString(),
      });
      throw new Error("LINK_UNCERTAIN_RECONCILE");
    }
  }
}
