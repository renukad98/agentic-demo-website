import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalizeJson, digestOperationPayload } from './approval-canonicalization.js';
import type { ApprovalRecordSigner } from './approval-signature.js';
import { storyPlanDigest, type StoryPlan } from './contracts/xray-story-publication.js';
import { storyPublishingPayload } from './xray-story-plan.js';

const MAX_GRANT_MS = 10 * 60_000;
const operations = ['xray.test.create', 'jira.issue.link'] as const;
const origin = z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch { return false; }
});
const scopeSchema = z.object({
  purpose: z.literal('xray.windows-demo.story-publication.v1'),
  sessionNonce: z.string().uuid(),
  tenant: origin,
  xrayOrigin: origin,
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}$/),
  storyKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/),
  storyIssueId: z.string().regex(/^[1-9]\d*$/),
  operations: z.tuple([z.literal(operations[0]), z.literal(operations[1])]),
  planDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export const localDemoGrantClaimsSchema = scopeSchema.extend({
  grantId: z.string().uuid(),
  issuedAt: z.number().int().safe(),
  expiresAt: z.number().int().safe(),
}).strict();
export const localDemoScopeGrantSchema = z.object({
  claims: localDemoGrantClaimsSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type LocalDemoScopeGrant = z.infer<typeof localDemoScopeGrantSchema>;

export function localDemoScopeForPlan(
  session: { sessionNonce: string; tenant: string; xrayOrigin: string },
  plan: StoryPlan,
) {
  return scopeSchema.parse({
    purpose: 'xray.windows-demo.story-publication.v1', ...session,
    projectKey: plan.projectKey, storyKey: plan.storyKey, storyIssueId: plan.storyEvidence?.issueId,
    operations, planDigest: storyPlanDigest(plan),
    payloadDigest: digestOperationPayload(storyPublishingPayload(plan)),
  });
}

export class LocalDemoGrantSession {
  private readonly session: { sessionNonce: string; tenant: string; xrayOrigin: string };
  private grant?: LocalDemoScopeGrant;
  private dispatched = false;

  constructor(
    origins: { tenant: string; xrayOrigin: string },
    private readonly verifier: Pick<ApprovalRecordSigner, 'verify'>,
    private readonly now = Date.now,
  ) {
    this.session = { ...origins, sessionNonce: randomUUID() };
  }

  challenge(plan: StoryPlan) {
    const scope = localDemoScopeForPlan(this.session, plan);
    return { scope, plan, payload: storyPublishingPayload(plan), operatorIdentity: 'unverified' as const };
  }

  accept(value: unknown, plan: StoryPlan): void {
    const grant = localDemoScopeGrantSchema.parse(value);
    if (!this.verifier.verify(canonicalizeJson(grant.claims), grant.signature)) {
      throw new Error('Invalid local demo scope grant signature.');
    }
    this.check(grant, plan, true);
    if (this.grant && canonicalizeJson(this.grant) !== canonicalizeJson(grant)) {
      throw new Error('This MCP session already has a different scope grant.');
    }
    this.grant = grant;
  }

  assertAuthorized(plan: StoryPlan, requireFresh = true): number {
    return this.check(this.requireGrant(), plan, requireFresh);
  }

  reserveDispatch(plan: StoryPlan): void {
    this.assertAuthorized(plan);
    if (this.dispatched) throw new Error('This local demo grant has already dispatched.');
    this.dispatched = true;
  }

  audit(plan: StoryPlan) {
    const grant = this.requireGrant();
    this.check(grant, plan, false);
    return { grantId: grant.claims.grantId, operatorIdentity: 'unverified' as const };
  }

  assertGrantInstalled(): void {
    this.requireGrant();
  }

  private requireGrant(): LocalDemoScopeGrant {
    if (!this.grant) throw new Error('A signed local demo scope grant is required.');
    return this.grant;
  }

  private check(grant: LocalDemoScopeGrant, plan: StoryPlan, requireFresh: boolean): number {
    const { issuedAt, expiresAt, ...scope } = grant.claims;
    const now = this.now();
    if (issuedAt > now || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_GRANT_MS ||
        (requireFresh && expiresAt <= now) ||
        canonicalizeJson(scope) !== canonicalizeJson({
          ...localDemoScopeForPlan(this.session, plan),
          grantId: grant.claims.grantId,
        })) {
      throw new Error('Local demo scope grant is expired or does not match this session and batch.');
    }
    return expiresAt;
  }
}
