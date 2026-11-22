import { canonicalizeJson } from '../agents/approval-canonicalization.js';
import { caseInput, type StoryPublicationAdapter } from '../agents/xray-story-publication.js';
import { existingTestSnapshotSchema, type ExistingStoryCase, type StoryPlan } from '../agents/contracts/xray-story-publication.js';
import { buildManualTestOperationPayload, type XrayClient } from './xray-client.js';
import type { JiraIssueLinkClient } from './jira-link-client.js';
import { duplicateContentSchema, duplicatePacket, validateDuplicateReview, XrayDuplicateReviewError,
  type DuplicateContent } from '../agents/xray-duplicate-review.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote response.');
  return value as Record<string, unknown>;
}
export function createStoryAdapter(xray: XrayClient, jira: JiraIssueLinkClient): StoryPublicationAdapter & {
  inspectDuplicates(plan: StoryPlan, caseId: string): Promise<ReturnType<typeof duplicatePacket>>;
  inspect(storyKey: string, existingTestKeys: string[]): Promise<{
    story: Awaited<ReturnType<JiraIssueLinkClient['storyEvidence']>>;
    projectKey: string; linkType: StoryPlan['linkType'];
    existingTests: { existingTest: ExistingStoryCase['existingTest']; expectedAlreadyLinked: boolean }[];
  }>;
} {
  const plannedContent = (plan: StoryPlan, id: string): DuplicateContent => {
    const input = caseInput(plan, id, 'read-only');
    return { ref: `planned:${id}`, summary: input.summary, description: input.description ?? null,
      manual: true, steps: input.steps.map(s => ({ ...s })) };
  };
  async function inspectDuplicates(plan: StoryPlan, caseId: string) {
    const proposed = plannedContent(plan, caseId);
    const planned = plan.cases.filter(c => c.kind !== 'existing' && c.testCaseId !== caseId)
      .map(c => plannedContent(plan, c.testCaseId));
    const candidates = [...planned];
    const ids = new Set<string>();
    const represented = new Set<string>();
    let total: number | undefined;
    // A complete bounded project inventory avoids title-token false positives and missed renamed Tests.
    for (let page = 0; page < 100; page++) {
      const response = object(await xray.graphqlRequest(`query StoryDuplicates($jql: String!, $start: Int!, $limit: Int!) {
        getTests(jql: $jql, start: $start, limit: $limit) { total results { issueId } }
      }`, { jql: `project = ${plan.projectKey}`, start: ids.size, limit: 100 }));
      const data = object(response.getTests);
      if (!Number.isInteger(data.total) || Number(data.total) < 0 || !Array.isArray(data.results) ||
        (total !== undefined && total !== data.total)) throw new XrayDuplicateReviewError('DUPLICATE_EVIDENCE_INCOMPLETE');
      total = Number(data.total);
      for (const entry of data.results) {
        const id = object(entry).issueId;
        if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || ids.has(id)) throw new XrayDuplicateReviewError('DUPLICATE_EVIDENCE_INCOMPLETE');
        ids.add(id);
        const raw = object(await xray.graphqlRequest(`query StoryDuplicateContent($id: String) {
          getTest(issueId: $id) { issueId testType { name kind } unstructured steps { action data result } jira(fields: ["key", "summary", "description", "project"]) }
        }`, { id }));
        const test = object(raw.getTest), fields = object(test.jira);
        if (test.issueId !== id || object(fields.project).key !== plan.projectKey ||
          typeof fields.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/.test(fields.key) ||
          !fields.key.startsWith(plan.projectKey + '-') || !Array.isArray(test.steps)) {
          throw new XrayDuplicateReviewError('DUPLICATE_EVIDENCE_INCOMPLETE');
        }
        const testType = object(test.testType);
        const candidate = duplicateContentSchema.parse({ ref: fields.key, summary: fields.summary,
          description: fields.description, manual: testType.name === 'Manual',
          ...(testType.name === 'Generic' && testType.kind === 'Unstructured'
            ? { generic: { kind: testType.kind, definition: test.unstructured } } : {}),
          steps: test.steps.map(s => { const step = object(s); return { action: step.action, data: step.data ?? '', result: step.result }; }) });
        // Anticipated cases are explicitly included in review before creation. Collapse a returned
        // Test only when its entire mapped content matches that approved planned candidate.
        const same = planned.filter(p => canonicalizeJson({ ...p, ref: '' }) === canonicalizeJson({ ...candidate, ref: '' }));
        if (same.length === 1) {
          if (represented.has(same[0]!.ref)) throw new XrayDuplicateReviewError('DUPLICATE_EVIDENCE_INCOMPLETE');
          represented.add(same[0]!.ref);
          const coverage = await existingCoverage(id);
          if (coverage.length !== 1 || coverage[0]?.key !== plan.storyKey || coverage[0]?.issueId !== plan.storyEvidence?.issueId) {
            throw new XrayDuplicateReviewError('DUPLICATE_EVIDENCE_INCOMPLETE');
          }
        } else candidates.push(candidate);
      }
      if (ids.size === total) return duplicatePacket(caseId, proposed, candidates);
      if (ids.size > total || data.results.length === 0) break;
    }
    throw new XrayDuplicateReviewError('DUPLICATE_EVIDENCE_INCOMPLETE');
  }
  async function preflight(plan: StoryPlan): Promise<void> {
    const metadata = await jira.prepareStory(plan.storyKey);
    if (metadata.projectKey !== plan.projectKey || canonicalizeJson(metadata.type) !== canonicalizeJson(plan.linkType)) throw new Error('Story or link metadata changed.');
    if (plan.storyEvidence) {
      const source = await jira.storyEvidence(plan.storyKey);
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (source.issueId !== plan.storyEvidence.issueId || source.contentDigest !== plan.storyEvidence.contentDigest ||
        plan.storyEvidence.requirements.some(r => !normalize(source.text).includes(normalize(r.text)))) {
        throw new Error('Story source or requirement evidence changed.');
      }
    }
  }
  async function existingContent(plan: StoryPlan, c: ExistingStoryCase): Promise<void> {
    const expected = c.existingTest;
    await jira.verifyTestIssue(expected.key, expected.issueId);
    const response = object(await xray.graphqlRequest(`query ExistingStoryTest($id: String) {
      getTest(issueId: $id) { issueId testType { name } steps { action data result } jira(fields: ["key", "summary", "description", "project"]) }
    }`, { id: expected.issueId }));
    const test = object(response.getTest), fields = object(test.jira);
    if (test.issueId !== expected.issueId || fields.key !== expected.key || object(fields.project).key !== plan.projectKey ||
      object(test.testType).name !== 'Manual' || fields.summary !== expected.summary || fields.description !== expected.description ||
      !Array.isArray(test.steps) || canonicalizeJson(test.steps.map(s => {
        const step = object(s); return { action: step.action, data: step.data ?? '', result: step.result };
      })) !== canonicalizeJson(expected.steps)) throw new Error('Existing Test content changed.');
  }
  async function existingCoverage(issueId: string): Promise<{ issueId: string; key: string }[]> {
    const results: { issueId: string; key: string }[] = [];
    let total: number | undefined;
    for (let page = 0; page < 100; page++) {
      const response = object(await xray.graphqlRequest(`query ExistingStoryCoverage($id: String, $start: Int, $limit: Int!) {
        getTest(issueId: $id) { coverableIssues(start: $start, limit: $limit) { total results { issueId jira(fields: ["key"]) } } }
      }`, { id: issueId, start: results.length, limit: 100 }));
      const data = object(object(response.getTest).coverableIssues);
      if (!Number.isInteger(data.total) || Number(data.total) < 0 || !Array.isArray(data.results) ||
        (total !== undefined && total !== data.total)) throw new Error('Existing Test coverage incomplete.');
      total = Number(data.total);
      for (const item of data.results) {
        const value = object(item), fields = object(value.jira);
        if (typeof value.issueId !== 'string' || typeof fields.key !== 'string' || results.some(r => r.issueId === value.issueId || r.key === fields.key)) {
          throw new Error('Existing Test coverage ambiguous.');
        }
        results.push({ issueId: value.issueId, key: fields.key });
      }
      if (results.length === total) return results;
      if (results.length > total || !data.results.length) break;
    }
    throw new Error('Existing Test coverage incomplete.');
  }
  async function validateExisting(plan: StoryPlan, c: ExistingStoryCase, linkVerified = false): Promise<void> {
    await existingContent(plan, c);
    const preview = await jira.prepare(plan.storyKey, c.existingTest.key, xray);
    if (preview.alreadyLinked !== (linkVerified || c.expectedAlreadyLinked)) throw new Error('Existing Test association changed.');
    const actual = await existingCoverage(c.existingTest.issueId);
    const expected = [...c.existingTest.coverage];
    if (linkVerified && !expected.some(r => r.key === plan.storyKey)) {
      if (!plan.storyEvidence) throw new Error('Story evidence missing.');
      expected.push({ key: plan.storyKey, issueId: plan.storyEvidence.issueId });
    }
    const sorted = (items: typeof expected) => [...items].sort((a, b) => a.key.localeCompare(b.key));
    if (canonicalizeJson(sorted(actual)) !== canonicalizeJson(sorted(expected))) throw new Error('Existing Test coverage evidence changed.');
  }
  async function readMatch(plan: StoryPlan, issueId: string, key: string, caseId: string): Promise<void> {
    const c = plan.cases.find(c => c.testCaseId === caseId);
    if (c?.kind === 'existing') {
      if (issueId !== c.existingTest.issueId || key !== c.existingTest.key) throw new Error('Existing Test identity changed.');
      return existingContent(plan, c);
    }
    const input = caseInput(plan, caseId, 'read-only');
    const response = object(await xray.graphqlRequest(`query VerifyStoryTest($id: String) {
      getTest(issueId: $id) { issueId testType { name } steps { action data result } jira(fields: ["key", "summary", "description", "project"]) }
    }`, { id: issueId }));
    const test = object(response.getTest); const fields = object(test.jira);
    const payload = object(buildManualTestOperationPayload(input));
    const expected = object(object(payload.jira).fields);
    if (test.issueId !== issueId || fields.key !== key || object(test.testType).name !== 'Manual' ||
      fields.summary !== expected.summary || fields.description !== expected.description || object(fields.project).key !== plan.projectKey ||
      !Array.isArray(test.steps) || canonicalizeJson(test.steps.map(s => { const step = object(s); return { action: step.action, data: step.data ?? '', result: step.result }; })) !== canonicalizeJson(input.steps)) throw new Error('Test read-back mismatch.');
  }
  return {
    inspectDuplicates,
    async inspect(storyKey, existingTestKeys) {
      const metadata = await jira.prepareStory(storyKey), story = await jira.storyEvidence(storyKey);
      const existingTests: { existingTest: ExistingStoryCase['existingTest']; expectedAlreadyLinked: boolean }[] = [];
      for (const key of existingTestKeys) {
        const identity = await jira.testIdentity(key);
        if (identity.projectKey !== metadata.projectKey) throw new Error('Existing Test project mismatch.');
        const response = object(await xray.graphqlRequest(`query InspectExistingStoryTest($id: String) {
          getTest(issueId: $id) { issueId testType { name } steps { action data result } jira(fields: ["key", "summary", "description", "project"]) }
        }`, { id: identity.issueId }));
        const test = object(response.getTest), fields = object(test.jira);
        if (test.issueId !== identity.issueId || fields.key !== key || object(test.testType).name !== 'Manual' ||
          object(fields.project).key !== metadata.projectKey || !Array.isArray(test.steps)) throw new Error('Existing Manual Test identity could not be verified.');
        const coverage = await existingCoverage(identity.issueId);
        const existingTest = existingTestSnapshotSchema.parse({ issueId: identity.issueId, key, jiraIssueType: 'Test',
          summary: fields.summary, description: fields.description, coverage,
          steps: test.steps.map(value => { const step = object(value); return { action: step.action, data: step.data ?? '', result: step.result }; }),
        });
        const preview = await jira.prepare(storyKey, key, xray);
        if (preview.alreadyLinked !== coverage.some(c => c.key === storyKey && c.issueId === story.issueId)) {
          throw new Error('Jira links and Xray coverage disagree.');
        }
        existingTests.push({ existingTest, expectedAlreadyLinked: preview.alreadyLinked });
      }
      if (metadata.type.name !== 'Test' || metadata.type.inward !== 'is tested by' || metadata.type.outward !== 'tests') throw new Error('Link metadata mismatch.');
      return { story, projectKey: metadata.projectKey, linkType: {
        id: metadata.type.id, name: 'Test', inward: 'is tested by', outward: 'tests',
      }, existingTests };
    },
    preflight,
    validateExisting,
    verifyTest: readMatch,
    async assertNoDuplicate(plan, caseId) {
      validateDuplicateReview(await inspectDuplicates(plan, caseId), plan.duplicateReview);
    },
    create: (input, gate) => xray.createManualTestWithExecutionGate(input, gate),
    async prepareLink(plan, key) {
      await preflight(plan);
      const preview = await jira.prepare(plan.storyKey, key, xray);
      const type = object(preview.payload.type);
      if (preview.projectKey !== plan.projectKey || type.id !== plan.linkType.id || type.name !== plan.linkType.name) throw new Error('Link plan mismatch.');
      return preview;
    },
    link: (preview, execution, gate) => jira.createApproved(preview, execution.approvalId, execution.plan.workflowId, execution.plan.workflowCorrelationId, gate),
    async verify(plan, issueId, key, caseId) {
      await readMatch(plan, issueId, key, caseId);
      const preview = await jira.prepare(plan.storyKey, key, xray);
      if (!preview.alreadyLinked) throw new Error('Story link verification failed.');
      const c = plan.cases.find(c => c.testCaseId === caseId);
      if (c?.kind === 'existing') return validateExisting(plan, c, true);
      let start = 0;
      for (;;) {
        const response = object(await xray.graphqlRequest(`query StoryCoverage($id: String, $start: Int, $limit: Int!) {
          getTest(issueId: $id) { coverableIssues(start: $start, limit: $limit) { total results { jira(fields: ["key"]) } } }
        }`, { id: issueId, start, limit: 100 }));
        const coverage = object(object(response.getTest).coverableIssues);
        if (!Array.isArray(coverage.results) || typeof coverage.total !== 'number') throw new Error('Coverage response incomplete.');
        if (coverage.results.some(r => object(object(r).jira).key === plan.storyKey)) return;
        start += coverage.results.length;
        if (coverage.results.length === 0 || start >= coverage.total || start > 10000) throw new Error('Story coverage not verified.');
      }
    },
  };
}
