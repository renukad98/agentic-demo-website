import { z } from 'zod';
import { digestOperationPayload } from '../approval-canonicalization.js';
import { duplicateReviewsSchema } from '../xray-duplicate-review.js';

const text = z.string().min(1).refine(value => value.trim().length > 0, 'Must not be blank.');
const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/);
const steps = z.array(z.object({ action: text, data: z.string(), result: text }).strict()).min(1).max(200);
const coverage = z.array(z.object({ requirementId: text, stepNumbers: z.array(z.number().int().positive()).min(1),
  rationale: text }).strict()).min(1);
const newCase = z.object({
  kind: z.literal('new').optional(), testCaseId: text, summary: text.max(255), description: text,
  sourceReferences: z.array(text).min(1), preconditions: z.array(z.string()),
  testData: z.string(), overallExpectedResult: text, steps, requirementCoverage: coverage.optional(),
}).strict();
export const existingTestSnapshotSchema = z.object({ issueId: z.string().regex(/^[1-9]\d*$/), key,
  jiraIssueType: z.literal('Test'), summary: text, description: z.string().nullable(), steps,
  coverage: z.array(z.object({ issueId: text, key }).strict()),
}).strict();
const existingCase = z.object({ kind: z.literal('existing'), testCaseId: text,
  sourceReferences: z.array(text).min(1), requirementCoverage: coverage,
  existingTest: existingTestSnapshotSchema, expectedAlreadyLinked: z.boolean(),
}).strict();
export const storyPlanSchema = z.object({
  schemaVersion: z.enum(['1.0.0', '1.1.0']),
  operation: z.literal('xray.publishStory'),
  environmentId: text,
  storyKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}$/),
  workflowId: text,
  workflowCorrelationId: text,
  review: z.object({ disposition: z.literal('approved-for-human-review'), evidence: z.array(text).min(1) }).strict(),
  duplicateReview: duplicateReviewsSchema.optional(),
  linkType: z.object({ id: text, name: z.literal('Test'), inward: z.literal('is tested by'), outward: z.literal('tests') }).strict(),
  storyEvidence: z.object({ issueId: text, contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    requirements: z.array(z.object({ id: text, text }).strict()).min(1),
  }).strict().optional(),
  cases: z.array(z.union([newCase, existingCase])).min(1).max(100),
}).strict().superRefine((p, ctx) => {
  if (!p.storyKey.startsWith(p.projectKey + '-') || new Set(p.cases.map(c => c.testCaseId)).size !== p.cases.length) {
    ctx.addIssue({ code: 'custom', message: 'Story project mismatch or duplicate case IDs.' });
  }
  if (p.schemaVersion === '1.0.0' && (p.duplicateReview || p.storyEvidence || p.cases.some(c => c.kind === 'existing' || c.requirementCoverage))) {
    ctx.addIssue({ code: 'custom', message: 'Mixed operations and coverage evidence require schema 1.1.0.' });
  }
  if (p.schemaVersion === '1.1.0') {
    const requirements = p.storyEvidence?.requirements ?? [];
    const ids = new Set(requirements.map(r => r.id));
    const existing = p.cases.filter(c => c.kind === 'existing');
    const titles = p.cases.map(c => (c.kind === 'existing' ? c.existingTest.summary : c.summary).normalize('NFKC').trim().toLowerCase());
    const stepSets = p.cases.map(c => JSON.stringify(c.kind === 'existing' ? c.existingTest.steps : c.steps));
    if (!p.storyEvidence || ids.size !== requirements.length ||
      new Set(titles).size !== titles.length || new Set(stepSets).size !== stepSets.length ||
      new Set(existing.map(c => c.existingTest.key)).size !== existing.length ||
      new Set(existing.map(c => c.existingTest.issueId)).size !== existing.length ||
      p.cases.some(c => !c.kind || !c.requirementCoverage?.length ||
        new Set(c.requirementCoverage.map(r => r.requirementId)).size !== c.requirementCoverage.length ||
        c.requirementCoverage.some(r => !ids.has(r.requirementId) || new Set(r.stepNumbers).size !== r.stepNumbers.length ||
        r.stepNumbers.some(n => n > (c.kind === 'existing' ? c.existingTest.steps.length : c.steps.length)))) ||
      existing.some(c => !c.existingTest.key.startsWith(p.projectKey + '-') ||
        new Set(c.existingTest.coverage.map(r => r.key)).size !== c.existingTest.coverage.length ||
        new Set(c.existingTest.coverage.map(r => r.issueId)).size !== c.existingTest.coverage.length ||
        c.expectedAlreadyLinked !== c.existingTest.coverage.some(r => r.key === p.storyKey && r.issueId === p.storyEvidence?.issueId)) ||
      requirements.some(r => !p.cases.some(c => c.requirementCoverage?.some(m => m.requirementId === r.id)))) {
      ctx.addIssue({ code: 'custom', message: 'Story evidence, unique Test identities and complete step-level requirement coverage are required.' });
    }
  }
});
export type StoryPlan = z.infer<typeof storyPlanSchema>;
export type ExistingStoryCase = Extract<StoryPlan['cases'][number], { kind: 'existing' }>;
export function parseStoryPlan(value: unknown): StoryPlan { return storyPlanSchema.parse(value); }
export function storyPlanDigest(plan: StoryPlan): string { return digestOperationPayload(parseStoryPlan(plan)); }
export type OperationState = 'pending' | 'writing' | 'verified' | 'uncertain';
export interface StoryCaseProgress {
  testCaseId: string;
  create: OperationState | 'not-applicable';
  link: OperationState;
  issueId?: string;
  key?: string;
}
export interface StoryExecution {
  schemaVersion: '1.0.0' | '1.1.0';
  executionId: string;
  approvalId: string;
  planDigest: string;
  plan: StoryPlan;
  expiresAt: string;
  status: 'starting' | 'running' | 'stopped' | 'complete';
  cases: StoryCaseProgress[];
  localDemoScope?: { grantId: string; operatorIdentity: 'unverified' };
  message?: string;
}
