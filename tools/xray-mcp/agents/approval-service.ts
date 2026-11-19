import { parseStoryPlan } from './contracts/xray-story-publication.js';
import { storyPublishingPayload } from './xray-story-plan.js';
import { randomUUID } from 'node:crypto';
import { parseJiraStoryPayload, jiraStoryScope } from './contracts/jira-story-creation.js';
import type {
  ApprovalActionType,
  ApprovalMatchRequest,
  ApprovalRecord,
  ApprovalScope,
  ApprovedApprovalRecord,
  Sha256Digest,
} from './contracts/approval.js';
import { approvalMatchesRequest, isApprovalRecord } from './contracts/approval.js';
import { requiresHumanApproval } from './approval-policy.js';
import { canonicalizeJson, digestOperationPayload, type CanonicalJsonValue } from './approval-canonicalization.js';
import type { ApprovalRecordSigner } from './approval-signature.js';
import type { ApprovalRecordStore, StoredApprovalRecord } from './approval-store.js';
import type { ApprovalId, ArtifactId, ISO8601DateTime, WorkflowCorrelationId, WorkflowId } from './contracts/workflow.js';

export type ApprovalActorType = 'human' | 'agent' | 'service';

export interface AuthenticatedApprovalPrincipal {
  readonly issuer: string;
  readonly subjectId: string;
  readonly actorType: ApprovalActorType;
  readonly authenticatedAt: ISO8601DateTime;
}

/** The host must validate its authenticated session/token; callers must not supply identity claims directly. */
export interface ApprovalIdentityProvider {
  authenticate(context: unknown): Promise<AuthenticatedApprovalPrincipal>;
}

/** The host supplies this policy from trusted identity/role configuration. */
export interface ApprovalApproverAuthorizer {
  isAuthorizedApprover(principalId: string, actionType: ApprovalActionType): Promise<boolean>;
  isAuthorizedExecutor(principalId: string, actionType: ApprovalActionType): Promise<boolean>;
}

export type SupportedApprovalWriteAction = 'jira.issue.create' | 'xray.test.create' | 'jira.issue.link' | 'xray.story.publish';

export interface CreateApprovalRequestInput {
  readonly actionType: SupportedApprovalWriteAction;
  readonly scope: ApprovalScope;
  readonly operationId: string;
  readonly description: string;
  readonly operationPayload: CanonicalJsonValue;
  readonly workflowId: WorkflowId;
  readonly workflowCorrelationId: WorkflowCorrelationId;
  readonly expiresAt: ISO8601DateTime;
}

export interface ApprovalRecordDetails {
  readonly record: ApprovalRecord;
  readonly operationPayload: CanonicalJsonValue;
  readonly consumedAt: ISO8601DateTime | null;
}

export interface ApprovalWriteInput extends CreateApprovalRequestInput {
  readonly approvalId: ApprovalId;
}

export type ApprovalServiceErrorCode =
  | 'invalid-request'
  | 'not-found'
  | 'unauthorized'
  | 'invalid-state'
  | 'expired'
  | 'mismatch'
  | 'reused'
  | 'tampered'
  | 'storage-conflict';

export class ApprovalServiceError extends Error {
  constructor(readonly code: ApprovalServiceErrorCode, message: string) {
    super(message);
    this.name = 'ApprovalServiceError';
  }
}

const supportedActions: ReadonlySet<string> = new Set<SupportedApprovalWriteAction>([
  'jira.issue.create',
  'xray.story.publish',
  'xray.test.create',
  'jira.issue.link',
]);

function principalId(principal: AuthenticatedApprovalPrincipal): string {
  return `${principal.issuer}:${principal.actorType}:${principal.subjectId}`;
}

function isPrincipal(value: unknown): value is AuthenticatedApprovalPrincipal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  return typeof principal.issuer === 'string' && principal.issuer.trim().length > 0 &&
    typeof principal.subjectId === 'string' && principal.subjectId.trim().length > 0 &&
    (principal.actorType === 'human' || principal.actorType === 'agent' || principal.actorType === 'service') &&
    typeof principal.authenticatedAt === 'string' && Number.isFinite(Date.parse(principal.authenticatedAt));
}

function asJsonClone(value: CanonicalJsonValue): CanonicalJsonValue {
  return JSON.parse(canonicalizeJson(value)) as CanonicalJsonValue;
}

function asRecord(value: CanonicalJsonValue): Record<string, CanonicalJsonValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, CanonicalJsonValue>
    : null;
}

function exactKeyList(scope: ApprovalScope, keys: readonly string[]): boolean {
  return keys.every((key) => scope.jiraIssueKeys.includes(key as ApprovalScope['jiraIssueKeys'][number]));
}

function validateActionScope(
  actionType: SupportedApprovalWriteAction,
  scope: ApprovalScope,
  operationId: string,
  payload: CanonicalJsonValue,
): void {
  const body = asRecord(payload);
  if (!body) throw new ApprovalServiceError('invalid-request', 'Operation payload must be a JSON object.');

  if (actionType === 'jira.issue.create') {
    const story = parseJiraStoryPayload(body);
    const expected = jiraStoryScope(story);
    if (operationId !== 'jira.createStory' || canonicalizeJson(scope) !== canonicalizeJson(expected)) {
      throw new ApprovalServiceError('invalid-request', 'Jira Story approval must bind the exact site, project and Story type scope.');
    }
    return;
  }

  if (actionType === 'xray.story.publish') {
    const plan = parseStoryPlan(body.plan);
    const issueKeys = [plan.storyKey, ...plan.cases.flatMap(c => c.kind === 'existing' ? [c.existingTest.key] : [])];
    if (canonicalizeJson(payload) !== canonicalizeJson(storyPublishingPayload(plan))) {
      throw new ApprovalServiceError('invalid-request', 'Story payload differs from the complete mapped plan.');
    }
    if (operationId !== 'xray.publishStory' || scope.projectKey !== plan.projectKey || scope.environmentId !== plan.environmentId ||
      scope.jiraIssueKeys.length !== issueKeys.length || !issueKeys.every(key => scope.jiraIssueKeys.some(k => k === key)) || scope.testCaseIds.length !== plan.cases.length ||
      !plan.cases.every(c => scope.testCaseIds.includes(c.testCaseId as ApprovalScope['testCaseIds'][number])) ||
      scope.targetResourceIds.length !== 3 || !scope.targetResourceIds.includes('jira-project:' + plan.projectKey) ||
      !scope.targetResourceIds.includes('jira-link-type:' + plan.linkType.id) || !scope.targetResourceIds.includes('xray-test-type:Manual')) {
      throw new ApprovalServiceError('invalid-request', 'Story approval must bind the complete exact plan scope.');
    }
    return;
  }
  if (actionType === 'xray.test.create') {
    const projectKey = body.projectKey;
    const testType = asRecord(body.testType as CanonicalJsonValue);
    const jira = asRecord(body.jira as CanonicalJsonValue);
    const jiraFields = asRecord(jira?.fields as CanonicalJsonValue);
    const steps = body.steps;
    const testCaseId = body.testCaseId;
    if (
      operationId !== 'xray.createManualTest' || body.operation !== 'xray.createManualTest' ||
      projectKey !== scope.projectKey || testType?.name !== 'Manual' ||
      !jiraFields || asRecord(jiraFields.project as CanonicalJsonValue)?.key !== scope.projectKey ||
      jiraFields.summary !== body.summary || typeof testCaseId !== 'string' ||
      !scope.testCaseIds.includes(testCaseId as ApprovalScope['testCaseIds'][number]) ||
      !Array.isArray(steps) || steps.length === 0 || scope.jiraIssueKeys.length === 0 ||
      scope.testCaseIds.length !== 1 ||
      !scope.targetResourceIds.includes(`jira-project:${scope.projectKey}`) ||
      !scope.targetResourceIds.includes('xray-test-type:Manual')
    ) {
      throw new ApprovalServiceError('invalid-request', 'Xray creation payload or scope is incomplete or inconsistent.');
    }
    return;
  }

  // Bind the approval to discovered runtime link metadata. This service does not assume
  // a link type name, id, project, or inward/outward direction.
  const inwardIssue = asRecord(body.inwardIssue as CanonicalJsonValue);
  const outwardIssue = asRecord(body.outwardIssue as CanonicalJsonValue);
  const linkType = asRecord(body.type as CanonicalJsonValue);
  const metadata = asRecord(body.discoveredLinkMetadata as CanonicalJsonValue);
  const inwardKey = inwardIssue?.key;
  const outwardKey = outwardIssue?.key;
  const linkId = metadata?.id;
  const linkName = metadata?.name;
  if (
    operationId !== 'jira.issueLink' || body.operation !== 'jira.issueLink' ||
    typeof inwardKey !== 'string' || typeof outwardKey !== 'string' || inwardKey === outwardKey ||
    inwardIssue?.key !== metadata?.inwardIssueKey || outwardIssue?.key !== metadata?.outwardIssueKey ||
    typeof linkId !== 'string' || typeof linkName !== 'string' ||
    linkType?.id !== linkId || linkType?.name !== linkName ||
    typeof metadata?.inward !== 'string' || typeof metadata?.outward !== 'string' ||
    scope.jiraIssueKeys.length !== 2 || !exactKeyList(scope, [inwardKey, outwardKey]) ||
    !scope.targetResourceIds.includes(`jira-issue:${inwardKey}`) ||
    !scope.targetResourceIds.includes(`jira-issue:${outwardKey}`) ||
    !scope.targetResourceIds.includes(`jira-link-type:${linkId}`)
  ) {
    throw new ApprovalServiceError('invalid-request', 'Jira link payload must include matching discovered link metadata and exact issue scope.');
  }
}

function signedContent(entry: Omit<StoredApprovalRecord, 'signature'>): string {
  return canonicalizeJson({ purpose: 'agentic-qa-approval-record-v1', ...entry });
}

function details(entry: StoredApprovalRecord): ApprovalRecordDetails {
  return {
    record: entry.record,
    operationPayload: entry.operationPayload,
    consumedAt: entry.consumedAt,
  };
}

function approvalMatchInput(input: ApprovalWriteInput): ApprovalMatchRequest {
  return {
    workflowId: input.workflowId,
    workflowCorrelationId: input.workflowCorrelationId,
    actionType: input.actionType,
    scope: input.scope,
    operationId: input.operationId,
    canonicalRequestSha256: digestOperationPayload(input.operationPayload),
  };
}

/**
 * Trusted approval service. Identity, approver authorization, signing keys, and storage are
 * supplied by the host composition root; without those trusted providers it cannot approve or run writes.
 */
export class ApprovalService {
  constructor(
    private readonly store: ApprovalRecordStore,
    private readonly signer: ApprovalRecordSigner,
    private readonly identityProvider: ApprovalIdentityProvider,
    private readonly approverAuthorizer: ApprovalApproverAuthorizer,
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {}

  async createRequest(input: CreateApprovalRequestInput, identityContext: unknown): Promise<ApprovalRecordDetails> {
    if (!supportedActions.has(input.actionType) || !requiresHumanApproval(input.actionType)) {
      throw new ApprovalServiceError('invalid-request', 'Action is not supported by the approval service.');
    }
    const now = this.clock();
    const nowIso = now.toISOString();
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      throw new ApprovalServiceError('expired', 'Approval expiry must be in the future.');
    }
    const principal = await this.identityProvider.authenticate(identityContext);
    if (!isPrincipal(principal) || Date.parse(principal.authenticatedAt) > now.getTime()) {
      throw new ApprovalServiceError('unauthorized', 'Authenticated caller identity is invalid.');
    }
    const payload = asJsonClone(input.operationPayload);
    validateActionScope(input.actionType, input.scope, input.operationId, payload);
    const digest: Sha256Digest = digestOperationPayload(payload);
    const approvalId = this.idFactory() as ApprovalId;
    const record = {
      artifactId: `artifact-${approvalId}` as ArtifactId,
      schemaVersion: '1.0.0',
      workflowId: input.workflowId,
      workflowCorrelationId: input.workflowCorrelationId,
      createdAt: nowIso,
      updatedAt: nowIso,
      revision: 1,
      sourceReferences: [],
      evidenceReferences: [],
      approvalId,
      actionType: input.actionType,
      scope: input.scope,
      requestedOperation: {
        operationId: input.operationId,
        description: input.description,
        canonicalRequestSha256: digest,
      },
      requestedBy: principalId(principal),
      requestedAt: nowIso,
      expiresAt: input.expiresAt,
      status: 'pending',
    } satisfies ApprovalRecord;
    if (!isApprovalRecord(record)) {
      throw new ApprovalServiceError('invalid-request', 'Approval request fields or exact resource scope are invalid.');
    }
    const entry = await this.signEntry(record, payload, null);
    await this.store.create(entry);
    return details(entry);
  }

  async getApproval(approvalId: ApprovalId): Promise<ApprovalRecordDetails> {
    const entry = await this.readVerified(approvalId);
    return details(entry);
  }

  async approve(
    approvalId: ApprovalId,
    identityContext: unknown,
    reason?: string,
  ): Promise<ApprovalRecordDetails> {
    const entry = await this.readVerified(approvalId);
    if (entry.consumedAt !== null || entry.record.status !== 'pending') {
      throw new ApprovalServiceError('invalid-state', 'Only an unused pending approval can be approved.');
    }
    const now = this.clock();
    if (now.getTime() >= Date.parse(entry.record.expiresAt)) {
      throw new ApprovalServiceError('expired', 'Approval request has expired.');
    }
    const principal = await this.identityProvider.authenticate(identityContext);
    if (!isPrincipal(principal) || principal.actorType !== 'human' || Date.parse(principal.authenticatedAt) > now.getTime()) {
      throw new ApprovalServiceError('unauthorized', 'Only an authenticated human can approve a write.');
    }
    const approverId = principalId(principal);
    if (approverId === entry.record.requestedBy) {
      throw new ApprovalServiceError('unauthorized', 'The requester cannot approve their own operation.');
    }
    if (!await this.approverAuthorizer.isAuthorizedApprover(approverId, entry.record.actionType)) {
      throw new ApprovalServiceError('unauthorized', 'This human is not authorized to approve the requested action.');
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 2_000)) {
      throw new ApprovalServiceError('invalid-request', 'Approval reason is invalid.');
    }

    const updatedAt = now.toISOString();
    const approvedRecord = {
      ...entry.record,
      updatedAt,
      revision: entry.record.revision + 1,
      status: 'approved',
      decision: {
        approver: approverId,
        decidedAt: updatedAt,
        ...(reason === undefined ? {} : { reason }),
        evidenceReferences: [],
      },
    } satisfies ApprovedApprovalRecord;
    const replacement = await this.signEntry(approvedRecord, entry.operationPayload, null);
    if (!await this.store.compareAndSet(approvalId, entry.signature, replacement)) {
      throw new ApprovalServiceError('storage-conflict', 'Approval changed while it was being reviewed.');
    }
    return details(replacement);
  }

  /** Consume a matching approval durably, then invoke the write immediately. The token cannot be reused. */
  async executeApprovedWrite<T>(
    input: ApprovalWriteInput,
    identityContext: unknown,
    write: (approvedPayload: CanonicalJsonValue) => Promise<T>,
  ): Promise<T> {
    if (!supportedActions.has(input.actionType)) {
      throw new ApprovalServiceError('invalid-request', 'Action is not supported by the approval gate.');
    }
    const entry = await this.readVerified(input.approvalId);
    if (entry.consumedAt !== null) {
      throw new ApprovalServiceError('reused', 'Approval has already been consumed.');
    }
    if (entry.record.status !== 'approved') {
      throw new ApprovalServiceError('invalid-state', 'Only an approved record can authorize a write.');
    }
    const caller = await this.identityProvider.authenticate(identityContext);
    const now = this.clock();
    if (!isPrincipal(caller) || caller.actorType !== 'human' || Date.parse(caller.authenticatedAt) > now.getTime()) {
      throw new ApprovalServiceError('unauthorized', 'An authenticated human caller is required at the write boundary.');
    }
    if (!await this.approverAuthorizer.isAuthorizedExecutor(principalId(caller), entry.record.actionType)) {
      throw new ApprovalServiceError('unauthorized', 'The authenticated caller is not authorized to execute this action.');
    }
    if (this.clock().getTime() >= Date.parse(entry.record.expiresAt)) {
      throw new ApprovalServiceError('expired', 'Approval has expired.');
    }
    const match = approvalMatchInput(input);
    validateActionScope(input.actionType, input.scope, input.operationId, input.operationPayload);
    if (!approvalMatchesRequest(entry.record, match, this.clock().toISOString())) {
      throw new ApprovalServiceError('mismatch', 'Approval does not match this exact write request.');
    }
    if (canonicalizeJson(entry.operationPayload) !== canonicalizeJson(input.operationPayload)) {
      throw new ApprovalServiceError('mismatch', 'Write payload differs from the reviewed payload.');
    }
    if (!await this.approverAuthorizer.isAuthorizedApprover(entry.record.decision.approver, entry.record.actionType)) {
      throw new ApprovalServiceError('unauthorized', 'Approver is no longer authorized for this action.');
    }

    const consumedAt = this.clock().toISOString();
    if (Date.parse(consumedAt) >= Date.parse(entry.record.expiresAt)) {
      throw new ApprovalServiceError('expired', 'Approval expired before the write could begin.');
    }
    const consumed = await this.signEntry(entry.record, entry.operationPayload, consumedAt);
    if (!await this.store.compareAndSet(input.approvalId, entry.signature, consumed)) {
      throw new ApprovalServiceError('reused', 'Approval was changed or consumed by another request.');
    }

    return write(asJsonClone(entry.operationPayload));
  }

  /** Revalidate a consumed approval only for continuation of its existing durable execution. */
  async validateStoryContinuation(input: ApprovalWriteInput, identityContext: unknown): Promise<void> {
    const entry = await this.readVerified(input.approvalId);
    const now = this.clock();
    const caller = await this.identityProvider.authenticate(identityContext);
    if (input.actionType !== 'xray.story.publish' || entry.consumedAt === null || !isPrincipal(caller) ||
      caller.actorType !== 'human' || Date.parse(caller.authenticatedAt) > now.getTime() ||
      !approvalMatchesRequest(entry.record, approvalMatchInput(input), now.toISOString()) ||
      canonicalizeJson(entry.operationPayload) !== canonicalizeJson(input.operationPayload) ||
      entry.record.status !== 'approved' ||
      !await this.approverAuthorizer.isAuthorizedExecutor(principalId(caller), input.actionType) ||
      !await this.approverAuthorizer.isAuthorizedApprover(entry.record.decision.approver, input.actionType)) {
      throw new ApprovalServiceError('unauthorized', 'Story continuation authorization failed.');
    }
    validateActionScope(input.actionType, input.scope, input.operationId, input.operationPayload);
  }

  private async readVerified(approvalId: ApprovalId): Promise<StoredApprovalRecord> {
    const entry = await this.store.get(approvalId);
    if (!entry) throw new ApprovalServiceError('not-found', 'Approval record was not found.');
    if (
      !isApprovalRecord(entry.record) || entry.record.approvalId !== approvalId ||
      typeof entry.signature !== 'string' ||
      (entry.consumedAt !== null && !Number.isFinite(Date.parse(entry.consumedAt)))
    ) throw new ApprovalServiceError('tampered', 'Approval record is malformed.');
    let content: string;
    try {
      content = signedContent({
        record: entry.record,
        operationPayload: entry.operationPayload,
        consumedAt: entry.consumedAt,
      });
      if (digestOperationPayload(entry.operationPayload) !== entry.record.requestedOperation.canonicalRequestSha256) {
        throw new Error('payload digest mismatch');
      }
    } catch {
      throw new ApprovalServiceError('tampered', 'Approval record payload failed integrity validation.');
    }
    if (!this.signer.verify(content, entry.signature)) {
      throw new ApprovalServiceError('tampered', 'Approval record signature is invalid.');
    }
    return entry;
  }

  private async signEntry(
    record: ApprovalRecord,
    operationPayload: CanonicalJsonValue,
    consumedAt: ISO8601DateTime | null,
  ): Promise<StoredApprovalRecord> {
    const unsigned = { record, operationPayload, consumedAt };
    return { ...unsigned, signature: this.signer.sign(signedContent(unsigned)) };
  }
}

