import type {
  ApprovalActionType,
  CanonicalActionType,
  NonApprovalActionType,
} from './contracts/approval.js';

/** @deprecated Use canonical dotted action names. These aliases remain for source compatibility. */
export type LegacyAction =
  | 'jira-create' | 'jira-update'
  | 'xray-create' | 'xray-update' | 'xray-publish'
  | 'test-execute'
  | 'git-commit' | 'git-push' | 'github-pr'
  | 'deploy' | 'destructive-change';

/** @deprecated Use CanonicalActionType; legacy aliases are normalized before policy evaluation. */
export type Action = CanonicalActionType | LegacyAction;

const legacyActionMap: Readonly<Record<LegacyAction, ApprovalActionType>> = {
  'jira-create': 'jira.issue.create',
  'jira-update': 'jira.issue.update',
  'xray-create': 'xray.test.create',
  'xray-update': 'xray.test.update',
  'xray-publish': 'xray.test.publish',
  'test-execute': 'test.execute',
  'git-commit': 'git.commit',
  'git-push': 'git.push',
  'github-pr': 'github.pull-request.create',
  deploy: 'deployment.execute',
  'destructive-change': 'destructive.change',
};

const autonomousActions: ReadonlySet<NonApprovalActionType> = new Set<NonApprovalActionType>([
  'read', 'analyze', 'draft', 'local-file-write',
]);

export function normalizeAction(action: Action): CanonicalActionType {
  return Object.hasOwn(legacyActionMap, action)
    ? legacyActionMap[action as LegacyAction]
    : action as CanonicalActionType;
}

/**
 * Classifies whether an action requires human approval. This is not an authorization gate.
 * @param _explicitlyRequested Deprecated compatibility parameter; ignored and never bypasses approval.
 */
export function requiresHumanApproval(action: Action, _explicitlyRequested?: boolean): boolean {
  const normalized = normalizeAction(action);
  return !autonomousActions.has(normalized as NonApprovalActionType);
}

export function describeAction(action: Action): string {
  return requiresHumanApproval(action)
    ? `Human approval required before: ${normalizeAction(action)}`
    : `May proceed within agent scope: ${normalizeAction(action)}`;
}
