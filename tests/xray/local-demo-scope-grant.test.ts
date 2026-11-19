import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalizeJson } from '../../tools/xray-mcp/agents/approval-canonicalization.js';
import { Ed25519ApprovalRecordSigner } from '../../tools/xray-mcp/agents/approval-signature.js';
import { parseStoryPlan } from '../../tools/xray-mcp/agents/contracts/xray-story-publication.js';
import { LocalDemoGrantSession } from '../../tools/xray-mcp/agents/local-demo-scope-grant.js';
import { signLocalDemoScopeChallenge } from '../../tools/xray-mcp/agents/sign-local-demo-scope-grant.js';

const plan = parseStoryPlan({
  schemaVersion: '1.1.0', operation: 'xray.publishStory', environmentId: 'fixture',
  storyKey: 'QA-1', projectKey: 'QA', workflowId: 'wf-one', workflowCorrelationId: 'corr-one',
  storyEvidence: { issueId: '1', contentDigest: 'sha256:' + 'a'.repeat(64), requirements: [{ id: 'AC-1', text: 'Task remains.' }] },
  review: { disposition: 'approved-for-human-review', evidence: ['test-fixture'] },
  linkType: { id: '1', name: 'Test', inward: 'is tested by', outward: 'tests' },
  cases: [{ kind: 'new', testCaseId: 'TC-1', summary: 'Cancel deletion', description: 'Cancellation preserves the task.',
    sourceReferences: ['AC-1'], preconditions: ['Open the confirmation.'], testData: '', overallExpectedResult: 'Task remains.',
    steps: [{ action: 'Click Cancel.', data: '', result: 'Task remains.' }],
    requirementCoverage: [{ requirementId: 'AC-1', stepNumbers: [1], rationale: 'Checks the retained task.' }],
  }],
});

test('signed Windows demo grant binds exact operations, endpoints, Story, session and expiry', () => {
  const keys = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const signer = new Ed25519ApprovalRecordSigner(keys.publicKey, keys.privateKey);
  const verifier = new Ed25519ApprovalRecordSigner(keys.publicKey);
  let now = 1_000_000;
  const origins = { tenant: 'https://jira.invalid', xrayOrigin: 'https://xray.invalid' };
  const session = new LocalDemoGrantSession(origins, verifier, () => now);
  const challenge = session.challenge(plan);
  const grant = signLocalDemoScopeChallenge(challenge, signer, 60, now);
  assert.throws(() => session.assertAuthorized(plan), /grant is required/);
  assert.throws(() => session.accept({ ...grant, signature: 'a'.repeat(86) }, plan), /signature/);
  for (const change of [
    { tenant: 'https://other-jira.invalid' }, { xrayOrigin: 'https://other-xray.invalid' },
    { projectKey: 'ZZ' }, { storyKey: 'QA-2' }, { storyIssueId: '2' },
    { planDigest: 'sha256:' + 'b'.repeat(64) }, { payloadDigest: 'sha256:' + 'c'.repeat(64) },
    { issuedAt: now + 1 }, { expiresAt: now + 600_001 },
  ]) {
    const claims = { ...grant.claims, ...change };
    assert.throws(() => session.accept({ claims, signature: signer.sign(canonicalizeJson(claims)) }, plan), /expired or does not match/);
  }
  const claims = { ...grant.claims, operations: ['xray.test.create'] };
  assert.throws(() => session.accept({ claims, signature: signer.sign(canonicalizeJson(claims)) }, plan));
  assert.throws(() => new LocalDemoGrantSession(origins, verifier, () => now).accept(grant, plan), /does not match/);
  assert.throws(() => signLocalDemoScopeChallenge({ ...challenge, plan: { ...plan, workflowId: 'changed' } }, signer, 60, now), /does not match/);
  session.accept(grant, plan);
  assert.equal(session.assertAuthorized(plan), now + 60_000);
  assert.equal(session.audit(plan).operatorIdentity, 'unverified');
  assert.throws(() => session.accept(signLocalDemoScopeChallenge(challenge, signer, 60, now), plan), /different scope grant/);
  session.reserveDispatch(plan);
  assert.throws(() => session.reserveDispatch(plan), /already dispatched/);
  now += 60_000;
  assert.throws(() => session.assertAuthorized(plan), /expired/);
  assert.equal(session.audit(plan).grantId, grant.claims.grantId);
});
