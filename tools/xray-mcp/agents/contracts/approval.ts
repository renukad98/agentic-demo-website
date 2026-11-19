import type {
  ApprovalId,
  ArtifactEnvelope,
  EvidenceReference,
  ISO8601DateTime,
  JiraIssueKey,
  TestCaseId,
  WorkflowCorrelationId,
  WorkflowId,
} from './workflow.js';
import {
  isArtifactEnvelope,
  isEvidenceReferenceArray,
  isISO8601DateTime,
} from './workflow.js';

export type NonApprovalActionType = 'read' | 'analyze' | 'draft' | 'local-file-write';

/** Consequential operations that require a separately scoped approval record. */
export type ApprovalActionType =
  | 'jira.issue.create'
  | 'jira.issue.update'
  | 'jira.issue.delete'
  | 'jira.issue.link'
  | 'jira.comment.create'
  | 'xray.story.publish'
  | 'xray.test.create'
  | 'xray.test.update'
  | 'xray.test.delete'
  | 'xray.test.link'
  | 'xray.test.publish'
  | 'xray.test-set.publish'
  | 'xray.test-plan.publish'
  | 'xray.execution.publish'
  | 'test.execute'
  | 'git.commit'
  | 'git.push'
  | 'github.pull-request.create'
  | 'github.workflow.dispatch'
  | 'deployment.execute'
  | 'destructive.change';

export type CanonicalActionType = NonApprovalActionType | ApprovalActionType;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';

export interface ApprovalScope {
  readonly projectKey: string;
  readonly environmentId: string;
  /** Exact Jira issue keys; wildcard values are not valid. */
  readonly jiraIssueKeys: readonly JiraIssueKey[];
  /** Exact test case IDs; wildcard values are not valid. */
  readonly testCaseIds: readonly TestCaseId[];
  /** Exact additional targets such as repository, branch, or deployment target. */
  readonly targetResourceIds: readonly [string, ...string[]];
}

export type Sha256Digest = `sha256:${string}`;

export interface RequestedOperation {
  /** Stable identifier for this one requested operation. */
  readonly operationId: string;
  readonly description: string;
  /** Digest of canonical action parameters; execution must verify the same digest. */
  readonly canonicalRequestSha256: Sha256Digest;
}

export interface ApprovalRequest extends ArtifactEnvelope {
  readonly approvalId: ApprovalId;
  readonly actionType: ApprovalActionType;
  readonly scope: ApprovalScope;
  readonly requestedOperation: RequestedOperation;
  readonly requestedBy: string;
  readonly requestedAt: ISO8601DateTime;
  readonly expiresAt: ISO8601DateTime;
}

export interface ApprovalDecision {
  readonly approver: string;
  readonly decidedAt: ISO8601DateTime;
  readonly reason?: string;
  readonly evidenceReferences: readonly EvidenceReference[];
}

export interface PendingApprovalRecord extends ApprovalRequest {
  readonly status: 'pending';
  readonly decision?: never;
}

export interface ApprovedApprovalRecord extends ApprovalRequest {
  readonly status: 'approved';
  readonly decision: ApprovalDecision;
}

export interface RejectedApprovalRecord extends ApprovalRequest {
  readonly status: 'rejected';
  readonly decision: ApprovalDecision;
}

export interface RevokedApprovalRecord extends ApprovalRequest {
  readonly status: 'revoked';
  readonly decision: ApprovalDecision;
}

export interface ExpiredApprovalRecord extends ApprovalRequest {
  readonly status: 'expired';
  readonly decision: ApprovalDecision;
}

export type ApprovalRecord =
  | PendingApprovalRecord
  | ApprovedApprovalRecord
  | RejectedApprovalRecord
  | RevokedApprovalRecord
  | ExpiredApprovalRecord;

const approvalActions: ReadonlySet<string> = new Set<ApprovalActionType>([
  'jira.issue.create',
  'jira.issue.update',
  'jira.issue.delete',
  'jira.issue.link',
  'jira.comment.create',
  'xray.story.publish',
  'xray.test.create',
  'xray.test.update',
  'xray.test.delete',
  'xray.test.link',
  'xray.test.publish',
  'xray.test-set.publish',
  'xray.test-plan.publish',
  'xray.execution.publish',
  'test.execute',
  'git.commit',
  'git.push',
  'github.pull-request.create',
  'github.workflow.dispatch',
  'deployment.execute',
  'destructive.change',
]);

const approvalStatuses: ReadonlySet<string> = new Set<ApprovalStatus>([
  'pending', 'approved', 'rejected', 'revoked', 'expired',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasExactIdentifiers(values: readonly string[], allowEmpty: boolean): boolean {
  if (!allowEmpty && values.length === 0) return false;
  const seen = new Set<string>();
  for (const value of values) {
    if (!isNonEmptyString(value) || value !== value.trim()) return false;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'all' || normalized === 'any' || /[?*]/.test(value) || seen.has(normalized)
    ) return false;
    seen.add(normalized);
  }
  return true;
}

function isExactIdentifier(value: unknown): value is string {
  return isNonEmptyString(value) && hasExactIdentifiers([value], false);
}

function isApprovalScope(value: unknown): value is ApprovalScope {
  return isObject(value) &&
    isExactIdentifier(value.projectKey) &&
    isExactIdentifier(value.environmentId) &&
    Array.isArray(value.jiraIssueKeys) && hasExactIdentifiers(value.jiraIssueKeys, true) &&
    Array.isArray(value.testCaseIds) && hasExactIdentifiers(value.testCaseIds, true) &&
    Array.isArray(value.targetResourceIds) && hasExactIdentifiers(value.targetResourceIds, false);
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return isObject(value) &&
    isNonEmptyString(value.approver) &&
    isISO8601DateTime(value.decidedAt) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    isEvidenceReferenceArray(value.evidenceReferences);
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

/** Runtime structural validation for approval records received from storage or tools. */
export function isApprovalRecord(value: unknown): value is ApprovalRecord {
  try {
    if (!isObject(value) || !isArtifactEnvelope(value)) return false;
    if (
      !isExactIdentifier(value.approvalId) ||
      !isExactIdentifier(value.artifactId) ||
      !isExactIdentifier(value.workflowId) ||
      !isExactIdentifier(value.workflowCorrelationId) ||
      typeof value.actionType !== 'string' || !approvalActions.has(value.actionType) ||
      !isApprovalScope(value.scope) || !isObject(value.requestedOperation) ||
      !isExactIdentifier(value.requestedOperation.operationId) ||
      !isNonEmptyString(value.requestedOperation.description) ||
      !isSha256Digest(value.requestedOperation.canonicalRequestSha256) ||
      !isNonEmptyString(value.requestedBy) ||
      !isISO8601DateTime(value.requestedAt) || !isISO8601DateTime(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.requestedAt) ||
      typeof value.status !== 'string' || !approvalStatuses.has(value.status)
    ) return false;

    if (value.status === 'pending') return value.decision === undefined;
    return isApprovalDecision(value.decision) && value.decision.approver !== value.requestedBy;
  } catch {
    return false;
  }
}

export interface ApprovalMatchRequest {
  readonly workflowId: WorkflowId;
  readonly workflowCorrelationId: WorkflowCorrelationId;
  readonly actionType: ApprovalActionType;
  readonly scope: ApprovalScope;
  readonly operationId: string;
  readonly canonicalRequestSha256: Sha256Digest;
}

/** Runtime structural validation for a proposed operation before any approval comparison. */
export function isApprovalMatchRequest(value: unknown): value is ApprovalMatchRequest {
  try {
    return isObject(value) &&
      isExactIdentifier(value.workflowId) &&
      isExactIdentifier(value.workflowCorrelationId) &&
      typeof value.actionType === 'string' && approvalActions.has(value.actionType) &&
      isApprovalScope(value.scope) &&
      isExactIdentifier(value.operationId) &&
      isSha256Digest(value.canonicalRequestSha256);
  } catch {
    return false;
  }
}

/**
 * Checks that a structurally valid approved record is current and bound to this exact request.
 * This matcher is not an authorization service: callers must still establish approver trust and
 * enforce the result at the operation boundary.
 */
export function approvalMatchesRequest(
  value: unknown,
  request: unknown,
  now: unknown,
): boolean {
  try {
    if (!isApprovalRecord(value) || value.status !== 'approved') return false;
    if (!isApprovalMatchRequest(request) || !isISO8601DateTime(now)) return false;

    const nowMs = Date.parse(now);
    const requestedAtMs = Date.parse(value.requestedAt);
    const approvedAtMs = Date.parse(value.decision.decidedAt);
    const expiresAtMs = Date.parse(value.expiresAt);
    const isCurrent =
      requestedAtMs <= approvedAtMs &&
      approvedAtMs <= nowMs &&
      nowMs < expiresAtMs;

    return (
      isCurrent &&
      value.workflowId === request.workflowId &&
      value.workflowCorrelationId === request.workflowCorrelationId &&
      value.actionType === request.actionType &&
      value.scope.projectKey === request.scope.projectKey &&
      value.scope.environmentId === request.scope.environmentId &&
      value.scope.jiraIssueKeys.length === request.scope.jiraIssueKeys.length &&
      value.scope.jiraIssueKeys.every((id) => request.scope.jiraIssueKeys.includes(id)) &&
      value.scope.testCaseIds.length === request.scope.testCaseIds.length &&
      value.scope.testCaseIds.every((id) => request.scope.testCaseIds.includes(id)) &&
      value.scope.targetResourceIds.length === request.scope.targetResourceIds.length &&
      value.scope.targetResourceIds.every((id) => request.scope.targetResourceIds.includes(id)) &&
      value.requestedOperation.operationId === request.operationId &&
      value.requestedOperation.canonicalRequestSha256 === request.canonicalRequestSha256
    );
  } catch {
    return false;
  }
}
