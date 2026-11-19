import { canonicalizeJson, type CanonicalJsonValue } from './approval-canonicalization.js';
import type { LocalDemoApprovalRequest, LocalDemoApprovalService } from './local-demo-approval.js';
import { parseStoryPlan, storyPlanDigest, type ExistingStoryCase, type StoryExecution, type StoryPlan } from './contracts/xray-story-publication.js';
import { StoryExecutionStore } from './xray-story-publication-store.js';
import { buildManualTestOperationPayload } from './xray-payload.js';
import type { ManualTestPublicationInput } from './contracts/xray-publication.js';
import type { ManualTestPublicationResult } from '../helpers/xray-client.js';
import { caseInput, storyPublishingPayload } from './xray-story-plan.js';
export { caseInput, storyPublishingPayload } from './xray-story-plan.js';
import type { JiraLinkPreview, JiraLinkResult } from '../helpers/jira-link-client.js';
import { XrayDuplicateReviewError } from './xray-duplicate-review.js';
import type { ApprovalService, ApprovalWriteInput } from './approval-service.js';

export interface StoryApprovalGate {
  readonly trusted?: boolean;
  start<T>(approvalId: string, plan: StoryPlan, write: () => Promise<T>): Promise<T>;
  check(approvalId: string, plan: StoryPlan): Promise<{ expiresAt: string }>;
}
/** Host-injected identity and signed durable storage are required in production. */
export class TrustedStoryApprovalGate implements StoryApprovalGate {
  readonly trusted = true;
  constructor(private readonly approvals: ApprovalService, private readonly identityContext: unknown) {}
  private async input(id: string, plan: StoryPlan): Promise<ApprovalWriteInput> {
    const { record } = await this.approvals.getApproval(id as ApprovalWriteInput['approvalId']);
    return { approvalId: record.approvalId, actionType: 'xray.story.publish', scope: record.scope,
      operationId: 'xray.publishStory', description: record.requestedOperation.description,
      operationPayload: storyPublishingPayload(plan), workflowId: plan.workflowId as ApprovalWriteInput['workflowId'],
      workflowCorrelationId: plan.workflowCorrelationId as ApprovalWriteInput['workflowCorrelationId'], expiresAt: record.expiresAt };
  }
  async start<T>(id: string, plan: StoryPlan, write: () => Promise<T>): Promise<T> {
    return this.approvals.executeApprovedWrite(await this.input(id, plan), this.identityContext, write);
  }
  async check(id: string, plan: StoryPlan): Promise<{ expiresAt: string }> {
    const input = await this.input(id, plan);
    await this.approvals.validateStoryContinuation(input, this.identityContext);
    return { expiresAt: input.expiresAt };
  }
}
export class DemoStoryApprovalGate implements StoryApprovalGate {
  constructor(private readonly approvals: LocalDemoApprovalService) {}
  request(plan: StoryPlan): LocalDemoApprovalRequest {
    return { action: 'xray.story.publish', projectKey: plan.projectKey, workflowId: plan.workflowId,
      correlationId: plan.workflowCorrelationId, operationPayload: storyPublishingPayload(plan) };
  }
  async start<T>(id: string, plan: StoryPlan, write: () => Promise<T>): Promise<T> {
    return this.approvals.execute(id, this.request(plan), write);
  }
  async check(id: string, plan: StoryPlan): Promise<{ expiresAt: string }> {
    const record = await this.approvals.get(id);
    if (record.status !== 'consumed' || canonicalizeJson(this.request(plan)) !== canonicalizeJson({
      action: record.action, projectKey: record.projectKey, workflowId: record.workflowId,
      correlationId: record.correlationId, operationPayload: record.operationPayload,
    }) || Date.now() >= Date.parse(record.expiresAt)) throw new Error('Execution approval missing, changed, unused or expired.');
    return { expiresAt: record.expiresAt };
  }
}
export interface StoryPublicationAdapter {
  preflight(plan: StoryPlan): Promise<void>;
  validateExisting(plan: StoryPlan, test: ExistingStoryCase, linkVerified?: boolean): Promise<void>;
  assertNoDuplicate(plan: StoryPlan, testCaseId: string): Promise<void>;
  create(input: ManualTestPublicationInput, gate: Pick<LocalDemoApprovalService, 'execute'>): Promise<ManualTestPublicationResult>;
  prepareLink(plan: StoryPlan, key: string): Promise<JiraLinkPreview>;
  link(preview: JiraLinkPreview, execution: StoryExecution, gate: Pick<LocalDemoApprovalService, 'execute'>): Promise<JiraLinkResult>;
  verifyTest(plan: StoryPlan, issueId: string, key: string, testCaseId: string): Promise<void>;
  verify(plan: StoryPlan, issueId: string, key: string, testCaseId: string): Promise<void>;
}

export class StoryPublisher {
  constructor(private readonly store: StoryExecutionStore, private readonly approvals: StoryApprovalGate,
    private readonly adapter: StoryPublicationAdapter,
    private readonly beforeStart?: (plan: StoryPlan) => Promise<void>,
    private readonly beforeDispatch?: (plan: StoryPlan) => Promise<void>,
    private readonly localDemoAudit?: (plan: StoryPlan) => NonNullable<StoryExecution['localDemoScope']>) {
    if (approvals.trusted && !store.trusted) throw new Error('Production execution storage requires a trusted signer.');
  }

  async start(approvalId: string, value: unknown): Promise<StoryExecution> {
    const plan = parseStoryPlan(value);
    return this.store.lockedStory(this.beforeStart ? 'personal-batch' : plan.environmentId, plan.storyKey, () => this.store.locked(approvalId, async () => {
      if (await this.store.get(approvalId)) throw new Error('Execution already exists; use resume.');
      await this.beforeStart?.(plan);
      await this.adapter.preflight(plan);
      for (const c of plan.cases) {
        if (c.kind === 'existing') await this.adapter.validateExisting(plan, c);
        else await this.adapter.assertNoDuplicate(plan, c.testCaseId);
      }
      return this.approvals.start(approvalId, plan, async () => {
        const { expiresAt } = await this.approvals.check(approvalId, plan);
        const execution: StoryExecution = { schemaVersion: plan.schemaVersion, executionId: approvalId, approvalId,
          planDigest: storyPlanDigest(plan), plan, expiresAt, status: 'running',
          ...(this.localDemoAudit ? { localDemoScope: this.localDemoAudit(plan) } : {}),
          cases: plan.cases.map(c => c.kind === 'existing'
            ? { testCaseId: c.testCaseId, create: 'not-applicable', link: 'pending', key: c.existingTest.key, issueId: c.existingTest.issueId }
            : { testCaseId: c.testCaseId, create: 'pending', link: 'pending' }) };
        await this.store.save(execution);
        return this.run(execution);
      });
    }));
  }
  async resume(id: string): Promise<StoryExecution> {
    return this.store.locked(id, async () => {
      const execution = await this.store.get(id);
      if (!execution) throw new Error('Execution not found.');
      return this.store.lockedStory(execution.plan.environmentId, execution.plan.storyKey, () => this.run(execution));
    });
  }
  async status(id: string): Promise<StoryExecution | undefined> { return this.store.get(id); }

  private async run(e: StoryExecution): Promise<StoryExecution> {
    try {
      parseStoryPlan(e.plan);
      if (storyPlanDigest(e.plan) !== e.planDigest || e.schemaVersion !== e.plan.schemaVersion) throw new Error('Plan changed.');
      if (e.executionId !== e.approvalId || e.cases.length !== e.plan.cases.length ||
        e.cases.some((c, i) => c.testCaseId !== e.plan.cases[i]?.testCaseId ||
          (e.plan.cases[i]?.kind === 'existing'
            ? c.create !== 'not-applicable' || c.key !== (e.plan.cases[i] as ExistingStoryCase).existingTest.key ||
              c.issueId !== (e.plan.cases[i] as ExistingStoryCase).existingTest.issueId
            : !['pending', 'writing', 'verified', 'uncertain'].includes(c.create)) ||
          !['pending', 'writing', 'verified', 'uncertain'].includes(c.link))) throw new Error('Plan changed.');
      await this.approvals.check(e.approvalId, e.plan);
      const revalidate = async () => {
        await this.beforeDispatch?.(e.plan);
        await this.adapter.preflight(e.plan);
        for (const c of e.plan.cases) if (c.kind === 'existing') {
          await this.adapter.validateExisting(e.plan, c, e.cases.find(p => p.testCaseId === c.testCaseId)?.link === 'verified');
        }
      };
      await revalidate();
      e.status = 'running';
      for (const progress of e.cases) {
        if (progress.create === 'writing') progress.create = 'uncertain';
        if (progress.link === 'writing') progress.link = 'uncertain';
        if (progress.create === 'uncertain' || progress.link === 'uncertain') throw new Error('Uncertain write requires read-only reconciliation; automatic retry blocked.');
        const c = e.plan.cases.find(c => c.testCaseId === progress.testCaseId)!;
        const childGate = (action: LocalDemoApprovalRequest['action'], payload: CanonicalJsonValue): Pick<LocalDemoApprovalService, 'execute'> => {
          let used = false;
          return ({
          execute: async (id, expected, write) => {
            await this.approvals.check(e.approvalId, e.plan);
            await revalidate();
            if (used || id !== e.approvalId || expected.action !== action || expected.projectKey !== e.plan.projectKey ||
              expected.workflowId !== e.plan.workflowId || expected.correlationId !== e.plan.workflowCorrelationId ||
              canonicalizeJson(expected.operationPayload) !== canonicalizeJson(payload)) throw new Error('Child operation differs from plan.');
            await this.store.save(e);
            used = true;
            await this.beforeDispatch?.(e.plan);
            return write(payload);
          },
        }); };
        if (progress.create === 'pending') {
          const input = caseInput(e.plan, progress.testCaseId, e.approvalId);
          await this.adapter.assertNoDuplicate(e.plan, progress.testCaseId);
          // Persist before entering an adapter: crashes and exceptions fail closed.
          progress.create = 'writing'; await this.store.save(e);
          const created = await this.adapter.create(input, childGate('xray.test.create', buildManualTestOperationPayload(input)));
          if (created.status !== 'created-and-verified') { progress.create = 'uncertain'; throw new Error('Test creation outcome uncertain.'); }
          progress.issueId = created.issueId; progress.key = created.key; progress.create = 'verified';
          await this.store.save(e);
        }
        if (!progress.key || !progress.issueId) throw new Error('Verified Test identity missing.');
        await this.adapter.verifyTest(e.plan, progress.issueId, progress.key, progress.testCaseId);
        if (progress.link === 'pending') {
          await revalidate();
          const preview = await this.adapter.prepareLink(e.plan, progress.key);
          if (preview.storyKey !== e.plan.storyKey || preview.testKey !== progress.key || preview.projectKey !== e.plan.projectKey ||
            (c.kind === 'existing' && preview.alreadyLinked !== c.expectedAlreadyLinked)) throw new Error('Plan changed: link target or association.');
          if (e.plan.schemaVersion === '1.1.0' && canonicalizeJson(preview.payload) !== canonicalizeJson({
            operation: 'jira.issueLink', inwardIssue: { key: progress.key }, outwardIssue: { key: e.plan.storyKey },
            type: { id: e.plan.linkType.id, name: e.plan.linkType.name },
            discoveredLinkMetadata: { ...e.plan.linkType, inwardIssueKey: progress.key, outwardIssueKey: e.plan.storyKey },
          })) throw new Error('Plan changed: link payload.');
          progress.link = 'writing'; await this.store.save(e);
          const result = await this.adapter.link(preview, e, childGate('jira.issue.link', preview.payload as CanonicalJsonValue));
          if (result.status === 'uncertain') { progress.link = 'uncertain'; throw new Error('Link outcome uncertain.'); }
          progress.link = 'verified'; await this.store.save(e);
        }
        await this.adapter.verify(e.plan, progress.issueId, progress.key, progress.testCaseId);
      }
      e.status = 'complete'; delete e.message;
    } catch (error) {
      e.status = 'stopped';
      for (const progress of e.cases) {
        if (progress.create === 'writing') progress.create = 'uncertain';
        if (progress.link === 'writing') progress.link = 'uncertain';
      }
      // Adapter errors may contain sensitive remote content; report only controlled state.
      e.message = error instanceof XrayDuplicateReviewError
        ? `${error.code}: ${error.packet?.candidates.map(c => c.ref).join(', ') ?? 'search evidence'}`
        : error instanceof Error && /^(Uncertain write|Plan changed|Verified Test identity|Test creation outcome|Link outcome)/.test(error.message)
        ? error.message : 'Stopped: approval, preflight, adapter or verification failed. Inspect operation states; no uncertain write will be repeated.';
    }
    await this.store.save(e);
    return e;
  }
}
