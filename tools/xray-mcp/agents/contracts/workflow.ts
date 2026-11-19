/** Shared, versioned identifiers and references used by QA workflow artifacts. */

export type SchemaVersion = '1.0.0';

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

/** Stable identifiers are assigned once and retained across artifact revisions. */
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type WorkflowCorrelationId = Brand<string, 'WorkflowCorrelationId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type RequirementId = Brand<string, 'RequirementId'>;
export type ScenarioId = Brand<string, 'ScenarioId'>;
export type TestCaseId = Brand<string, 'TestCaseId'>;
export type ReviewId = Brand<string, 'ReviewId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type ExecutionId = Brand<string, 'ExecutionId'>;
export type ReportId = Brand<string, 'ReportId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type TestDataId = Brand<string, 'TestDataId'>;
export type JiraIssueKey = Brand<string, 'JiraIssueKey'>;
export type XrayTestId = Brand<string, 'XrayTestId'>;
export type PlaywrightTestId = Brand<string, 'PlaywrightTestId'>;
export type GitHubRepositoryId = Brand<string, 'GitHubRepositoryId'>;
export type GitHubPullRequestId = Brand<string, 'GitHubPullRequestId'>;
export type GitHubWorkflowRunId = Brand<string, 'GitHubWorkflowRunId'>;

export type ISO8601DateTime = string;

/** Runtime validator for the ISO 8601 date-time format used by persisted artifacts. */
export function isISO8601DateTime(value: unknown): value is ISO8601DateTime {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
    (offsetHourText !== undefined && Number(offsetHourText) > 23) ||
    (offsetMinuteText !== undefined && Number(offsetMinuteText) > 59)
  ) return false;
  return Number.isFinite(Date.parse(value));
}

export interface ArtifactEnvelope {
  readonly artifactId: ArtifactId;
  readonly schemaVersion: SchemaVersion;
  readonly workflowId: WorkflowId;
  readonly workflowCorrelationId: WorkflowCorrelationId;
  readonly createdAt: ISO8601DateTime;
  readonly updatedAt: ISO8601DateTime;
  /** Increment when the same stable artifact is revised. */
  readonly revision: number;
  readonly sourceReferences: readonly SourceReference[];
  readonly evidenceReferences: readonly EvidenceReference[];
}

export interface JiraIssueReference {
  readonly system: 'jira';
  readonly issueKey: JiraIssueKey;
  readonly projectKey: string;
  readonly url?: string;
}

export interface XrayTestReference {
  readonly system: 'xray';
  readonly testId: XrayTestId;
  readonly issueKey?: JiraIssueKey;
  readonly url?: string;
}

export interface PlaywrightTestReference {
  readonly system: 'playwright';
  /** Stable ID assigned to the logical test, not a run-specific result ID. */
  readonly testId: PlaywrightTestId;
  readonly specPath: string;
  readonly title: string;
}

export interface GitHubPullRequestReference {
  readonly system: 'github';
  readonly repositoryId: GitHubRepositoryId;
  readonly pullRequestId: GitHubPullRequestId;
  readonly url?: string;
}

export interface GitHubWorkflowRunReference {
  readonly system: 'github';
  readonly repositoryId: GitHubRepositoryId;
  readonly workflowRunId: GitHubWorkflowRunId;
  readonly url?: string;
}

export interface LocalArtifactReference {
  readonly system: 'local';
  readonly artifactId: ArtifactId;
  readonly path: string;
}

export type SourceReference =
  | JiraIssueReference
  | XrayTestReference
  | PlaywrightTestReference
  | GitHubPullRequestReference
  | GitHubWorkflowRunReference
  | LocalArtifactReference;

export type EvidenceKind =
  | 'artifact'
  | 'playwright-result'
  | 'trace'
  | 'screenshot'
  | 'video'
  | 'log'
  | 'xray-response'
  | 'jira-response'
  | 'github-check'
  | 'ci-result'
  | 'other';

export interface EvidenceReference {
  readonly evidenceId: EvidenceId;
  readonly kind: EvidenceKind;
  /** Local path or sanitized URL; never embed credentials or secret query parameters. */
  readonly location: string;
  readonly mediaType?: string;
  readonly sha256?: string;
  readonly capturedAt: ISO8601DateTime;
  readonly sourceReferences: readonly SourceReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isSourceReference(value: unknown): value is SourceReference {
  if (!isRecord(value) || !isNonEmptyString(value.system)) return false;
  switch (value.system) {
    case 'jira':
      return isNonEmptyString(value.issueKey) && isNonEmptyString(value.projectKey);
    case 'xray':
      return isNonEmptyString(value.testId);
    case 'playwright':
      return isNonEmptyString(value.testId) &&
        isNonEmptyString(value.specPath) && isNonEmptyString(value.title);
    case 'github':
      return isNonEmptyString(value.repositoryId) &&
        (isNonEmptyString(value.pullRequestId) || isNonEmptyString(value.workflowRunId));
    case 'local':
      return isNonEmptyString(value.artifactId) && isNonEmptyString(value.path);
    default:
      return false;
  }
}

const evidenceKinds: ReadonlySet<string> = new Set([
  'artifact', 'playwright-result', 'trace', 'screenshot', 'video', 'log',
  'xray-response', 'jira-response', 'github-check', 'ci-result', 'other',
]);

export function isEvidenceReference(value: unknown): value is EvidenceReference {
  return isRecord(value) &&
    isNonEmptyString(value.evidenceId) &&
    typeof value.kind === 'string' && evidenceKinds.has(value.kind) &&
    isNonEmptyString(value.location) &&
    isISO8601DateTime(value.capturedAt) &&
    Array.isArray(value.sourceReferences) && value.sourceReferences.every(isSourceReference) &&
    (value.mediaType === undefined || typeof value.mediaType === 'string') &&
    (value.sha256 === undefined ||
      (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)));
}

export function isEvidenceReferenceArray(value: unknown): value is readonly EvidenceReference[] {
  return Array.isArray(value) && value.every(isEvidenceReference);
}

export function isArtifactEnvelope(value: unknown): value is ArtifactEnvelope {
  return isRecord(value) &&
    isNonEmptyString(value.artifactId) &&
    value.schemaVersion === '1.0.0' &&
    isNonEmptyString(value.workflowId) &&
    isNonEmptyString(value.workflowCorrelationId) &&
    isISO8601DateTime(value.createdAt) &&
    isISO8601DateTime(value.updatedAt) &&
    Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
    Number.isInteger(value.revision) && (value.revision as number) >= 1 &&
    Array.isArray(value.sourceReferences) && value.sourceReferences.every(isSourceReference) &&
    isEvidenceReferenceArray(value.evidenceReferences);
}

export type WorkflowStatus =
  | 'created'
  | 'in-progress'
  | 'waiting-for-input'
  | 'waiting-for-approval'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkflowRecord extends ArtifactEnvelope {
  readonly workflowType: 'agentic-qa';
  readonly status: WorkflowStatus;
  readonly projectKey: string;
  readonly environmentId?: string;
  readonly sourceJiraIssues: readonly JiraIssueReference[];
  readonly artifactIds: readonly ArtifactId[];
  readonly startedAt?: ISO8601DateTime;
  readonly completedAt?: ISO8601DateTime;
}
