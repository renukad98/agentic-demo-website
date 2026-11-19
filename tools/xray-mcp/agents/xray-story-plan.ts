import type { CanonicalJsonValue } from './approval-canonicalization.js';
import type { ManualTestPublicationInput } from './contracts/xray-publication.js';
import { parseStoryPlan, type StoryPlan } from './contracts/xray-story-publication.js';
import { buildManualTestOperationPayload } from './xray-payload.js';

/** Fingerprinted request includes exact mapped API payloads, not just source case details. */
export function storyPublishingPayload(value: StoryPlan): CanonicalJsonValue {
  const plan = parseStoryPlan(value);
  return { plan, creations: plan.cases.filter(c => c.kind !== 'existing').map(c => buildManualTestOperationPayload(caseInput(plan, c.testCaseId, 'preview'))),
    links: plan.cases.map(c => ({ testCaseId: c.testCaseId, inwardIssue: (c.kind === 'existing'
      ? { key: c.existingTest.key } : { createdByCaseId: c.testCaseId }) as CanonicalJsonValue,
      outwardIssue: { key: plan.storyKey }, type: plan.linkType })) };
}
export function caseInput(plan: StoryPlan, testCaseId: string, approvalId: string): ManualTestPublicationInput {
  const c = plan.cases.find(c => c.testCaseId === testCaseId);
  if (!c || c.kind === 'existing') throw new Error('Case is not an approved new Test creation.');
  return { approvalId, projectKey: plan.projectKey, summary: c.summary,
    description: c.description + '\n\nPreconditions:\n' + c.preconditions.join('\n') + '\nTest data: ' + c.testData + '\nExpected: ' + c.overallExpectedResult + '\nSources:\n' + c.sourceReferences.join('\n'),
    jiraFields: {}, steps: c.steps, testCaseId, workflowId: plan.workflowId, workflowCorrelationId: plan.workflowCorrelationId };
}
