import type { ManualTestPublicationInput } from './contracts/xray-publication.js';
import type { CanonicalJsonValue } from './approval-canonicalization.js';

export function buildManualTestOperationPayload(input: Omit<ManualTestPublicationInput, 'approvalId'>): CanonicalJsonValue {
  const jiraFields = {
    ...input.jiraFields,
    project: { key: input.projectKey },
    summary: input.summary,
    ...(input.description === undefined ? {} : { description: input.description }),
  };
  return {
    operation: 'xray.createManualTest', projectKey: input.projectKey, testCaseId: input.testCaseId,
    summary: input.summary, testType: { name: 'Manual' },
    steps: input.steps.map((step) => ({ action: step.action, data: step.data, result: step.result })),
    jira: { fields: jiraFields },
  } as unknown as CanonicalJsonValue;
}

