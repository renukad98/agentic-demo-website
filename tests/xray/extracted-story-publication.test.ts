import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { mkdir, mkdtemp, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalDemoApprovalService } from '../../tools/xray-mcp/agents/local-demo-approval.js';
import { StoryExecutionStore } from '../../tools/xray-mcp/agents/xray-story-publication-store.js';
import { DemoStoryApprovalGate, StoryPublisher, type StoryPublicationAdapter } from '../../tools/xray-mcp/agents/xray-story-publication.js';
import { buildManualTestOperationPayload } from '../../tools/xray-mcp/helpers/xray-client.js';
import { caseInput, storyPublishingPayload } from '../../tools/xray-mcp/agents/xray-story-plan.js';
import type { CanonicalJsonValue } from '../../tools/xray-mcp/agents/approval-canonicalization.js';
import { parseStoryPlan, storyPlanDigest, type StoryPlan } from '../../tools/xray-mcp/agents/contracts/xray-story-publication.js';
import { XrayDuplicateReviewError } from '../../tools/xray-mcp/agents/xray-duplicate-review.js';
import { Ed25519ApprovalRecordSigner } from '../../tools/xray-mcp/agents/approval-signature.js';
import { LocalDemoGrantSession } from '../../tools/xray-mcp/agents/local-demo-scope-grant.js';
import { signLocalDemoScopeChallenge } from '../../tools/xray-mcp/agents/sign-local-demo-scope-grant.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createXrayMcpServer, pinPersonalBatchPlan } from '../../tools/xray-mcp/src/integrations/xray-mcp/server.js';

test('persistent stdio entry point exposes only read tools without an authorized publication host', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xray-persistent-startup-'));
  const client = new Client({ name: 'persistent-startup-test', version: '1' }, {
    capabilities: { elicitation: { form: {} } },
  });
  const serverPath = fileURLToPath(new URL('../../tools/xray-mcp/src/integrations/xray-mcp/server.ts', import.meta.url));
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), serverPath],
      cwd: directory,
      env: {
        XRAY_BASE_URL: 'https://xray-fixture.invalid',
        XRAY_CLIENT_ID: 'fixture-id',
        XRAY_CLIENT_SECRET: 'fixture-secret',
      },
    }));
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, ['xray_get_test', 'xray_get_test_coverage', 'xray_search_tests']);
    for (const name of ['xray_prepare_story_publication', 'xray_publish_story']) {
      assert.equal((await client.callTool({ name, arguments: {} })).isError, true);
    }
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('disabled batch startup exits before credentials, MCP approval or dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xray-disabled-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const qaDirectory = join(directory, 'qa');
  await mkdir(qaDirectory);
  const pipelinePath = join(qaDirectory, 'pipeline.json');
  await writeFile(pipelinePath, JSON.stringify({
    commands: { 'qa xray': { manualTestBatch: { liveDispatchEnabled: false } } },
  }));

  const serverPath = fileURLToPath(new URL('../../tools/xray-mcp/src/integrations/xray-mcp/server.ts', import.meta.url));
  const start = () => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), serverPath, '--personal-batch-demo', 'missing-plan.json',
  ], { cwd: directory, env: {}, encoding: 'utf8', timeout: 10_000 });

  const disabled = start();
  assert.ifError(disabled.error);
  assert.equal(disabled.status, 1);
  assert.equal(disabled.stdout, '');
  assert.equal(disabled.stderr, 'XRAY_BATCH_DISABLED: Live batch publishing is disabled by repository policy.\n');

  await writeFile(pipelinePath, 'invalid JSON');
  const unexpected = start();
  assert.ifError(unexpected.error);
  assert.equal(unexpected.status, 1);
  assert.equal(unexpected.stdout, '');
  assert.equal(unexpected.stderr, 'Xray MCP server failed to start; details withheld for safety.\n');
});

test('signed Windows startup exposes a challenge only with an external public key and still rejects an ungranted publish',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'xray-signed-startup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cwd = join(directory, 'workspace');
    await mkdir(cwd);
    const keyPath = join(directory, 'issuer.pem');
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const serverPath = fileURLToPath(new URL('../../tools/xray-mcp/src/integrations/xray-mcp/server.ts', import.meta.url));
    for (const publicPem of ['malformed key', publicKey]) {
      await writeFile(keyPath, publicPem);
      const client = new Client({ name: 'signed-startup-test', version: '1' });
      try {
        await client.connect(new StdioClientTransport({
          command: process.execPath, args: ['--import', import.meta.resolve('tsx'), serverPath, '--signed-local-demo'],
          cwd, stderr: 'pipe',
          env: {
            CI: 'false', NODE_ENV: 'test', LOCALAPPDATA: directory,
            JIRA_BASE_URL: 'https://jira.invalid', JIRA_EMAIL: 'fixture@example.invalid', JIRA_API_TOKEN: 'fixture-token',
            XRAY_BASE_URL: 'https://xray.invalid', XRAY_CLIENT_ID: 'fixture-id', XRAY_CLIENT_SECRET: 'fixture-secret',
            XRAY_LOCAL_DEMO_PUBLIC_KEY_FILE: keyPath,
          },
        }));
        const tools = (await client.listTools()).tools.map(tool => tool.name);
        assert(tools.includes('xray_search_tests'));
        assert.equal(tools.includes('xray_get_local_demo_challenge'), publicPem === publicKey);
        assert.equal(tools.includes('xray_publish_story'), publicPem === publicKey);
        assert(!tools.includes('xray_resume_story_publication'));
        assert.equal((await client.callTool({ name: 'xray_publish_story', arguments: {
          approvalId: '00000000-0000-4000-8000-000000000001', plan: nativeBatchPlan(),
        } })).isError, true);
      } finally {
        await client.close();
      }
    }
  });

const plan: StoryPlan = {
  schemaVersion: '1.0.0', operation: 'xray.publishStory', environmentId: 'demo', storyKey: 'QA-1', projectKey: 'QA',
  workflowId: 'wf-1', workflowCorrelationId: 'corr-1', review: { disposition: 'approved-for-human-review', evidence: ['review-1'] },
  linkType: { id: '10', name: 'Test', inward: 'is tested by', outward: 'tests' },
  cases: ['TC-1', 'TC-2'].map(testCaseId => ({ testCaseId, summary: testCaseId, description: 'Objective', preconditions: [],
    testData: 'none required', overallExpectedResult: 'Page appears', sourceReferences: ['QA-1/AC-1'],
    steps: [{ action: 'Open page', data: '', result: 'Page appears' }] })),
};

function nativeBatchPlan() {
  return parseStoryPlan({
    ...plan, schemaVersion: '1.1.0',
    storyEvidence: { issueId: '1', contentDigest: 'sha256:' + 'a'.repeat(64),
      requirements: [{ id: 'AC1', text: 'Page appears' }] },
    cases: plan.cases.map(c => ({ ...c, kind: 'new',
      steps: [{ action: 'Open page for ' + c.testCaseId, data: '', result: 'Page appears' }],
      requirementCoverage: [{ requirementId: 'AC1', stepNumbers: [1], rationale: 'Checks that the page appears.' }] })),
  });
}

test('native MCP confirmation authorizes exactly one batch and preserves the disabled default', async () => fixture(async f => {
  const nativePlan = nativeBatchPlan();
  const graphql = { async graphqlRequest<T>(): Promise<T> { throw new Error('No network in protocol test'); } };
  const directory = await mkdtemp(join(tmpdir(), 'native-story-'));
  const configuration = { directory, tenant: 'https://fixture.atlassian.net', projects: new Set(['QA']), adapter: f.adapter };
  const connect = async (enabled: boolean, supportsForms = true) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = enabled
      ? createXrayMcpServer(graphql, undefined, f.approvals, undefined, undefined, configuration)
      : createXrayMcpServer(graphql);
    const client = new Client({ name: 'native-test', version: '1' }, {
      capabilities: supportsForms ? { elicitation: { form: {} } } : {},
    });
    let decision: 'accept' | 'decline' | 'cancel' = 'decline';
    let prompts = 0;
    if (supportsForms) client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      prompts++;
      assert.equal(params.mode, 'form');
      assert.match(params.message, /fixture\.atlassian\.net/);
      assert.match(params.message, /QA-1/);
      assert.match(params.message, /TC-2/);
      return decision === 'accept' ? { action: decision, content: {} } : { action: decision };
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server, setDecision: (value: typeof decision) => { decision = value; }, promptCount: () => prompts };
  };
  const disabled = await connect(false);
  const enabled = await connect(true);
  const noForm = await connect(true, false);
  try {
    const defaultTools = (await disabled.client.listTools()).tools.map(t => t.name);
    assert(defaultTools.includes('xray_search_tests'));
    assert(defaultTools.includes('xray_get_test'));
    assert(defaultTools.includes('xray_get_test_coverage'));
    assert(!defaultTools.includes('xray_publish_story'));
    assert(!((await enabled.client.listTools()).tools.some(t => t.name === 'xray_prepare_manual_test_preview')));
    const prepare = () => enabled.client.callTool({ name: 'xray_prepare_story_publication', arguments: { plan: nativePlan } });
    assert.equal((await noForm.client.callTool({
      name: 'xray_prepare_story_publication', arguments: { plan: nativePlan },
    })).isError, true);
    const data = (result: unknown) => JSON.parse((result as {content: [{text: string}]}).content[0].text);
    assert.equal(data(await prepare()).status, 'NOT_APPROVED');
    enabled.setDecision('cancel');
    assert.equal(data(await prepare()).status, 'NOT_APPROVED');
    assert.equal(f.calls.length, 0);
    enabled.setDecision('accept');
    const first = data(await prepare());
    assert.equal(first.status, 'APPROVED');
    assert(!('approvalDigest' in first));
    const publish = (approvalId: string, batch: StoryPlan) => enabled.client.callTool({
      name: 'xray_publish_story', arguments: { approvalId, plan: batch },
    });
    const changed = structuredClone(nativePlan);
    changed.cases[0] = { ...changed.cases[0]!, sourceReferences: ['changed'] };
    assert.equal((await publish(first.approvalId, changed)).isError, true);
    assert.equal(f.calls.length, 0);
    const expired = data(await prepare());
    f.advanceClock(121_000);
    assert.equal((await publish(expired.approvalId, nativePlan)).isError, true);
    assert.equal(f.calls.length, 0);
    f.advanceClock(0);
    const preview = data(await prepare());
    assert.equal((await publish(preview.approvalId, nativePlan)).isError, undefined);
    assert.deepEqual(f.calls.map(call => call.split(':')[0]), ['create', 'link', 'create', 'link']);
    assert.equal((await publish(preview.approvalId, nativePlan)).isError, true);
    assert.equal(enabled.promptCount(), 5);
  } finally {
    await disabled.client.close();
    await enabled.client.close();
    await disabled.server.close();
    await enabled.server.close();
    await noForm.client.close();
    await noForm.server.close();
    await rm(directory, { recursive: true, force: true });
  }
}));
for (const changedAfterApproval of [false, true]) {
test(`pinned native session ${changedAfterApproval ? 'invalidates approval after a file change' : 'publishes the exact batch once'}`, () => fixture(async f => {
  const plan = nativeBatchPlan();
  const directory = await mkdtemp(join(tmpdir(), 'pinned-story-'));
  const path = join(directory, 'plan.json');
  await writeFile(path, JSON.stringify(plan));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scoped-native-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    prompts++;
    return { action: 'accept', content: {} };
  });
  const graphql = { async graphqlRequest<T>(): Promise<T> { throw new Error('Remote access forbidden in test'); } };
  const pin = await pinPersonalBatchPlan(directory, 'plan.json', storyPlanDigest(plan));
  await assert.rejects(pinPersonalBatchPlan(directory, 'plan.json', 'wrong'), /authorized batch digest/);
  const server = createXrayMcpServer(graphql, undefined, f.approvals, undefined, undefined, {
    directory, tenant: 'https://fixture.invalid', projects: new Set(['QA']), adapter: f.adapter, assertPinnedPlan: pin,
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert(!(await client.listTools()).tools.some(t => t.name === 'xray_resume_story_publication'));
    const prepare = (batch: StoryPlan) => client.callTool({ name: 'xray_prepare_story_publication', arguments: { plan: batch } });
    const changed = { ...plan, workflowId: 'unapproved-workflow' };
    assert.equal((await prepare(changed)).isError, true);
    await writeFile(path, JSON.stringify(changed));
    assert.equal((await prepare(plan)).isError, true);
    assert.equal(prompts, 0);
    await writeFile(path, JSON.stringify(plan));
    const prepared = await prepare(plan);
    const { approvalId, status } = JSON.parse((prepared as unknown as { content: [{ text: string }] }).content[0].text);
    assert.equal(status, 'APPROVED');
    assert.equal(prompts, 1);
    assert.equal((await prepare(plan)).isError, true);
    assert.equal(prompts, 1);
    assert.equal(f.calls.length, 0);
    const publish = () => client.callTool({ name: 'xray_publish_story', arguments: { approvalId, plan } });
    if (changedAfterApproval) {
      await writeFile(path, JSON.stringify(changed));
      assert.equal((await publish()).isError, true);
      await writeFile(path, JSON.stringify(plan));
      assert.equal((await publish()).isError, true);
      assert.equal(f.calls.length, 0);
    } else {
      assert.equal((await publish()).isError, undefined);
      assert.equal(f.calls.length, 4);
      assert.equal((await publish()).isError, true);
      const executionStore = new StoryExecutionStore(join(directory, 'story-executions'));
      await assert.rejects(executionStore.assertNoPriorBatch(plan), /prior batch execution/);
    }
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}));
}

test('one reusable native session loads active evidence, rejects unsafe batches and returns journaled outcomes', () => fixture(async f => {
  const root = await mkdtemp(join(tmpdir(), 'active-story-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'active-story-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let allow = false;
  let prompts = 0;
  let authorized = true;
  let duplicate = false;
  let failCoverage = false;
  const verified: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
    prompts++;
    assert.match(params.message, /"creations"/);
    assert.match(params.message, /"links"/);
    return allow ? { action: 'accept', content: {} } : { action: 'decline' };
  });
  f.adapter.assertNoDuplicate = async () => {
    if (duplicate) throw new XrayDuplicateReviewError('EXACT_DUPLICATE');
  };
  f.adapter.verify = async (p, _issueId, key) => {
    verified.push(p.storyKey + ':' + key);
    if (failCoverage) throw new Error('Mock coverage unavailable');
  };
  const graphql = { async graphqlRequest<T>(): Promise<T> { throw new Error('Network prohibited in active Story test'); } };
  const configuration = {
    directory: root, tenant: 'https://fixture.invalid', projects: new Set(['QA']), adapter: f.adapter,
    activeStory: {
      projectRoot: root,
      assertAuthorized: async () => {
        if (!authorized) throw new Error('Scope revoked');
      },
    },
  };
  const server = createXrayMcpServer(graphql, undefined, f.approvals, undefined, undefined, configuration);
  const urlOnlyServer = createXrayMcpServer(graphql, undefined, f.approvals, undefined, undefined, configuration);
  const urlOnlyClient = new Client({ name: 'url-only-test', version: '1' }, {
    capabilities: { elicitation: { url: {} } },
  });
  const select = async (batch: StoryPlan, paused = false) => {
    const storyKey = batch.storyKey;
    const feature = 'qa/' + storyKey;
    const evidence = 'artifacts/qa/' + storyKey;
    await mkdir(join(root, feature), { recursive: true });
    await mkdir(join(root, evidence), { recursive: true });
    await writeFile(join(root, evidence, 'batch.json'), JSON.stringify(batch));
    await writeFile(join(root, feature, 'feature.json'), JSON.stringify({
      storyKey, paused, stage: 'executed', completedStages: ['reviewed', 'implemented', 'automated', 'executed'],
      evidence: { reviewedBatchPlan: evidence + '/batch.json' },
    }));
    await writeFile(join(root, 'qa/current.json'), JSON.stringify({ storyKey, featureFile: feature + '/feature.json' }));
  };
  const prepare = () => client.callTool({ name: 'xray_prepare_story_publication', arguments: { activeStory: true } });
  const data = (result: unknown) => JSON.parse((result as { content: [{ text: string }] }).content[0].text);
  const publish = (approved: { approvalId: string; plan: StoryPlan }) => client.callTool({
    name: 'xray_publish_story', arguments: { approvalId: approved.approvalId, plan: approved.plan },
  });
  const status = (executionId: string) => client.callTool({
    name: 'xray_get_story_publication', arguments: { executionId },
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const first = nativeBatchPlan();
    await select(first, true);
    assert.equal((await prepare()).isError, true);
    await select(first);
    const [urlClientTransport, urlServerTransport] = InMemoryTransport.createLinkedPair();
    await urlOnlyServer.connect(urlServerTransport);
    await urlOnlyClient.connect(urlClientTransport);
    const withoutForm = await urlOnlyClient.callTool({
      name: 'xray_prepare_story_publication', arguments: { activeStory: true },
    });
    assert.equal(withoutForm.isError, true);
    assert.deepEqual(withoutForm.content, [
      { type: 'text', text: 'Xray request failed; details were withheld for safety.' },
    ]);
    const withoutApproval = await publish({ approvalId: '00000000-0000-4000-8000-000000000001', plan: first });
    assert.equal(withoutApproval.isError, true);
    assert.equal(f.calls.length, 0);
    authorized = false;
    assert.equal((await prepare()).isError, true);
    authorized = true;
    duplicate = true;
    assert.equal((await prepare()).isError, true);
    duplicate = false;
    assert.equal(prompts, 0);
    assert.equal(data(await prepare()).status, 'NOT_APPROVED');
    assert.equal(f.calls.length, 0);

    allow = true;
    const stale = data(await prepare());
    await select({ ...first, workflowId: 'changed-after-approval' });
    assert.equal((await publish(stale)).isError, true);
    assert.equal(f.calls.length, 0);
    await select(first);
    const approved = data(await prepare());
    assert.deepEqual(approved.plan, first);
    const complete = data(await publish(approved));
    assert.equal(complete.status, 'complete');
    assert.deepEqual(complete.cases.map((c: { key: string }) => c.key), ['QA-2', 'QA-4']);
    assert.deepEqual(verified, ['QA-1:QA-2', 'QA-1:QA-4']);
    assert.equal((await publish(approved)).isError, true);
    assert.equal((await prepare()).isError, true);

    const second = parseStoryPlan({ ...first, storyKey: 'QA-9' });
    await select(second);
    failCoverage = true;
    const partialApproval = data(await prepare());
    const partial = data(await publish(partialApproval));
    assert.equal(partial.status, 'stopped');
    assert.equal(partial.cases[0].key, 'QA-6');
    assert.equal(partial.cases[1].create, 'pending');
    assert.equal(f.calls.length, 6);
    assert.deepEqual(data(await status(complete.executionId)), complete);
    assert.deepEqual(data(await status(partial.executionId)), partial);
    assert.equal((await prepare()).isError, true);
    assert.equal(prompts, 4);
    assert.equal(f.calls.length, 6);
  } finally {
    await urlOnlyClient.close();
    await urlOnlyServer.close();
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}));

for (const decision of ['accept', 'decline', 'cancel'] as const) {
  test('signed local demo requires one native ' + decision + ' decision for the frozen batch', () => fixture(async f => {
    const root = await mkdtemp(join(tmpdir(), 'signed-demo-'));
    const batch = nativeBatchPlan();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'signed-demo-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    const keys = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const tenant = 'https://fixture.invalid';
    const scope = new LocalDemoGrantSession({ tenant, xrayOrigin: 'https://xray.invalid' }, new Ed25519ApprovalRecordSigner(keys.publicKey));
    const graphql = { async graphqlRequest<T>(): Promise<T> { throw new Error('Network prohibited in signed demo test'); } };
    const server = createXrayMcpServer(graphql, undefined, f.approvals, undefined, undefined, {
      tenant, projects: new Set(), directory: root, adapter: f.adapter,
      activeStory: { projectRoot: root, signedScope: scope },
    });
    let prompts = 0;
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      prompts++;
      assert.match(params.message, /"operatorIdentity": "unverified"/);
      assert.match(params.message, /"creations"/);
      assert.match(params.message, /"links"/);
      return decision === 'accept' ? { action: decision, content: {} } : { action: decision };
    });
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const read = (result: unknown) => JSON.parse((result as { content: [{ text: string }] }).content[0].text);
    try {
      await mkdir(join(root, 'qa', 'QA-1'), { recursive: true });
      await mkdir(join(root, 'artifacts', 'qa', 'QA-1'), { recursive: true });
      await writeFile(join(root, 'qa', 'current.json'), JSON.stringify({ storyKey: 'QA-1', featureFile: 'qa/QA-1/feature.json' }));
      await writeFile(join(root, 'qa', 'QA-1', 'feature.json'), JSON.stringify({
        storyKey: 'QA-1', paused: false, stage: 'executed', completedStages: ['reviewed', 'implemented', 'automated', 'executed'],
        evidence: { reviewedBatchPlan: 'artifacts/qa/QA-1/batch.json' },
      }));
      await writeFile(join(root, 'artifacts', 'qa', 'QA-1', 'batch.json'), JSON.stringify(batch));
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const challenge = read(await call('xray_get_local_demo_challenge'));
      const grant = signLocalDemoScopeChallenge(challenge, new Ed25519ApprovalRecordSigner(keys.publicKey, keys.privateKey), 30);
      const prepare = (scopeGrant: unknown) => call('xray_prepare_story_publication', { activeStory: true, scopeGrant });
      assert.equal((await call('xray_prepare_story_publication', { activeStory: true })).isError, true);
      assert.equal((await prepare({ ...grant, signature: 'a'.repeat(86) })).isError, true);
      assert.equal(prompts, 0);
      const approved = read(await prepare(grant));
      assert.equal(prompts, 1);
      assert.equal(f.calls.length, 0);
      assert.equal((await prepare(grant)).isError, true);
      if (decision !== 'accept') {
        assert.equal(approved.status, 'NOT_APPROVED');
        assert.equal(f.calls.length, 0);
        return;
      }
      assert.equal(approved.status, 'APPROVED');
      assert.equal(Date.parse(approved.expiresAt), grant.claims.expiresAt);
      const publish = () => call('xray_publish_story', { approvalId: approved.approvalId, plan: approved.plan });
      const result = read(await publish());
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.localDemoScope, { grantId: grant.claims.grantId, operatorIdentity: 'unverified' });
      assert.deepEqual(result.cases.map((c: { key: string }) => c.key), ['QA-2', 'QA-4']);
      assert.deepEqual(read(await call('xray_get_story_publication', { executionId: result.executionId })), result);
      assert.equal((await publish()).isError, true);
      assert.equal(f.calls.length, 4);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }));
}

function mixedPlan(): StoryPlan {
  return parseStoryPlan({ ...plan, schemaVersion: '1.1.0',
    storyEvidence: { issueId: '1', contentDigest: 'sha256:' + 'a'.repeat(64),
      requirements: [{ id: 'AC1', text: 'Option available' }, { id: 'AC2', text: 'Prices ascend' }] },
    cases: [{ kind: 'existing', testCaseId: 'TC-existing', sourceReferences: ['QA-1/AC1'],
      requirementCoverage: [{ requirementId: 'AC1', stepNumbers: [1], rationale: 'Existing step verifies option availability.' }],
      expectedAlreadyLinked: false, existingTest: { issueId: '12', key: 'QA-12', jiraIssueType: 'Test',
        summary: 'Existing option test', description: 'Option coverage', coverage: [],
        steps: [{ action: 'Open sorting options', data: '', result: 'Option available' }] } },
    { ...plan.cases[1]!, kind: 'new', requirementCoverage: [
      { requirementId: 'AC2', stepNumbers: [1], rationale: 'New Test checks the displayed ascending prices.' }] }],
  });
}
async function fixture(run: (f: { publisher: StoryPublisher; approvals: LocalDemoApprovalService; gate: DemoStoryApprovalGate;
  adapter: StoryPublicationAdapter; calls: string[]; store: StoryExecutionStore; advanceClock(offset: number): void }) => Promise<void>,
  replace?: typeof rename, platform?: NodeJS.Platform) {
  const dir = await mkdtemp(join(tmpdir(), 'story-publication-'));
  try {
    let offset = 0;
    const approvals = new LocalDemoApprovalService(join(dir, 'approvals'), () => new Date(Date.now() + offset), undefined, 120_000);
    const gate = new DemoStoryApprovalGate(approvals); const calls: string[] = [];
    const adapter: StoryPublicationAdapter = {
      preflight: async () => {}, assertNoDuplicate: async () => {}, validateExisting: async () => {},
      create: async (input, gate) => gate.execute(input.approvalId, { action: 'xray.test.create', projectKey: input.projectKey,
        workflowId: input.workflowId, correlationId: input.workflowCorrelationId, operationPayload: buildManualTestOperationPayload(input) }, async () => {
        calls.push('create:' + input.testCaseId); return { status: 'created-and-verified' as const, key: 'QA-' + (calls.length + 1), issueId: String(calls.length + 1), reconciled: false };
      }),
      prepareLink: async (p, key) => ({ storyKey: p.storyKey, testKey: key, projectKey: p.projectKey, alreadyLinked: false,
        payload: { operation: 'jira.issueLink', inwardIssue: { key }, outwardIssue: { key: p.storyKey },
          type: { id: p.linkType.id, name: p.linkType.name },
          discoveredLinkMetadata: { ...p.linkType, inwardIssueKey: key, outwardIssueKey: p.storyKey } } }),
      link: async (preview, execution, gate) => gate.execute(execution.approvalId, { action: 'jira.issue.link', projectKey: plan.projectKey,
        workflowId: plan.workflowId, correlationId: plan.workflowCorrelationId, operationPayload: preview.payload as CanonicalJsonValue }, async () => {
        calls.push('link:' + preview.testKey); return { status: 'linked' as const, storyKey: preview.storyKey, testKey: preview.testKey, linkId: 'link-1', reconciled: false };
      }),
      verify: async () => {}, verifyTest: async () => {},
    };
    const store = new StoryExecutionStore(join(dir, 'executions'), undefined, replace, platform);
    await run({ publisher: new StoryPublisher(store, gate, adapter), approvals, gate, adapter, calls, store,
      advanceClock(value) { offset = value; } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Windows journal retries the same flushed temporary file without repeating writes', async () => {
  const attempts: [string, string][] = [];
  await fixture(async f => {
    const request = await f.approvals.createRequest(f.gate.request(plan));
    await f.approvals.approve(request.approvalId, request.digest);
    const result = await f.publisher.start(request.approvalId, plan);
    assert.equal(result.status, 'complete');
    assert.deepEqual(attempts[0], attempts[1]);
    assert.deepEqual(attempts[1], attempts[2]);
    assert.equal(f.calls.filter(c => c === 'create:TC-1').length, 1);
    await assert.rejects(f.publisher.start(request.approvalId, plan), /already exists/);
  }, async (source, destination) => {
    attempts.push([String(source), String(destination)]);
    if (attempts.length <= 2) throw Object.assign(new Error('simulated sharing denial'), { code: 'EPERM' });
    await rename(source, destination);
  }, 'win32');
});

test('exhausted post-dispatch rename keeps the prior writing state and recovery never retries the create', async () => {
  let fail = true;
  let denied = 0;
  await fixture(async f => {
    const request = await f.approvals.createRequest(f.gate.request(plan));
    await f.approvals.approve(request.approvalId, request.digest);
    await assert.rejects(f.publisher.start(request.approvalId, plan), { code: 'EPERM' });
    assert.equal(denied, 10);
    assert.equal((await f.store.get(request.approvalId))?.cases[0]?.create, 'writing');
    assert.deepEqual(f.calls.slice(), ['create:TC-1']);
    fail = false;
    const recovered = await f.publisher.resume(request.approvalId);
    assert.equal(recovered.status, 'stopped');
    assert.equal(recovered.cases[0]?.create, 'uncertain');
    assert.deepEqual(f.calls, ['create:TC-1']);
    await assert.rejects(f.publisher.start(request.approvalId, plan), /already exists/);
  }, async (source, destination) => {
    const snapshot = JSON.parse(await readFile(source, 'utf8'));
    if (fail && snapshot.execution.cases[0]?.create === 'verified') {
      denied++;
      throw Object.assign(new Error('simulated persistent sharing denial'), { code: 'EPERM' });
    }
    await rename(source, destination);
  }, 'win32');
});

test('non-retryable or non-Windows rename errors propagate before any dispatch', async () => {
  for (const [code, platform] of [['EXDEV', 'win32'], ['EPERM', 'linux']] as const) {
    let attempts = 0;
    await fixture(async f => {
      const request = await f.approvals.createRequest(f.gate.request(plan));
      await f.approvals.approve(request.approvalId, request.digest);
      await assert.rejects(f.publisher.start(request.approvalId, plan), { code });
      assert.equal(attempts, 1);
      assert.equal(await f.store.get(request.approvalId), undefined);
      assert.equal(f.calls.length, 0);
      assert.equal((await f.approvals.get(request.approvalId)).status, 'consumed');
    }, async () => {
      attempts++;
      throw Object.assign(new Error('simulated replacement error'), { code });
    }, platform);
  }
});

test('late duplicate-review blocker preserves completed case and resumes only pending work', () => fixture(async f => {
  let block = true;
  f.adapter.assertNoDuplicate = async (_plan, id) => {
    if (block && id === 'TC-2' && f.calls.includes('create:TC-1')) throw new XrayDuplicateReviewError('DUPLICATE_REVIEW_REQUIRED');
  };
  const request = await f.approvals.createRequest(f.gate.request(plan));
  await f.approvals.approve(request.approvalId, request.digest);
  const stopped = await f.publisher.start(request.approvalId, plan);
  assert.equal(stopped.cases[0]!.create, 'verified'); assert.equal(stopped.cases[0]!.link, 'verified');
  assert.equal(stopped.cases[1]!.create, 'pending'); assert.match(stopped.message!, /DUPLICATE_REVIEW_REQUIRED/);
  const completedKey = stopped.cases[0]!.key;
  block = false; // Simulated restored evidence under the same unexpired immutable plan.
  const completed = await f.publisher.resume(request.approvalId);
  assert.equal(completed.status, 'complete'); assert.equal(completed.cases[0]!.key, completedKey);
  assert.equal(f.calls.filter(c => c === 'create:TC-1').length, 1);
  assert.equal(f.calls.filter(c => c === 'create:TC-2').length, 1);
  assert.equal((await f.approvals.get(request.approvalId)).status, 'consumed');
}));

test('recovery plan verifies already-linked AC1 and creates only three remaining cases', () => fixture(async f => {
  const recovery = mixedPlan(); const existing = recovery.cases[0]!;
  if (existing.kind !== 'existing') throw new Error('fixture');
  existing.expectedAlreadyLinked = true;
  existing.existingTest.coverage = [{ issueId: '1', key: recovery.storyKey }];
  const remaining = recovery.cases[1]!;
  if (remaining.kind === 'existing') throw new Error('fixture');
  recovery.cases = [existing, ...['TC-02', 'TC-03', 'TC-04'].map((id, i) => ({ ...remaining,
    testCaseId: id, summary: id, steps: [{ action: `Select option ${i}`, data: '', result: `Order ${i}` }] }))];
  const prepare = f.adapter.prepareLink, link = f.adapter.link;
  f.adapter.prepareLink = async (...args) => ({ ...await prepare(...args), alreadyLinked: args[1] === existing.existingTest.key });
  f.adapter.link = async (preview, execution, gate) => preview.alreadyLinked
    ? { status: 'already-linked', storyKey: preview.storyKey, testKey: preview.testKey, linkId: 'existing' }
    : link(preview, execution, gate);
  const request = await f.approvals.createRequest(f.gate.request(recovery));
  await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, recovery);
  assert.equal(result.status, 'complete', result.message);
  assert.deepEqual(f.calls.filter(c => c.startsWith('create:')), ['create:TC-02', 'create:TC-03', 'create:TC-04']);
  assert.equal(f.calls.filter(c => c.startsWith('link:')).length, 3);
  const calls = [...f.calls]; await f.publisher.resume(request.approvalId); assert.deepEqual(f.calls, calls);
}));
test('complete Story plan fingerprint covers steps, links, review and environment', () => {
  for (const changed of [ { ...plan, environmentId: 'other' }, { ...plan, linkType: { ...plan.linkType, id: '11' } },
    { ...plan, review: { ...plan.review, evidence: ['other'] } },
    { ...plan, cases: plan.cases.map(c => ({ ...c, steps: [{ action: 'Changed', data: '', result: 'Changed' }] })) } ]) {
    assert.notEqual(storyPlanDigest(changed), storyPlanDigest(plan));
  }
  assert.throws(() => parseStoryPlan({ ...plan, cases: [plan.cases[0]!, plan.cases[0]!] }));
});
test('one approval publishes all cases and links; replay rejected and completed resume writes nothing', () => fixture(async f => {
  const request = await f.approvals.createRequest(f.gate.request(plan));
  await assert.rejects(f.publisher.start(request.approvalId, plan), /not approved/);
  await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, plan);
  assert.equal(result.status, 'complete'); assert.equal(f.calls.length, 4);
  await assert.rejects(f.publisher.start(request.approvalId, plan), /already exists/);
  assert.equal((await f.publisher.resume(result.executionId)).status, 'complete'); assert.equal(f.calls.length, 4);
}));
test('changed and missing approvals cannot start writes', () => fixture(async f => {
  const request = await f.approvals.createRequest(f.gate.request(plan));
  await f.approvals.approve(request.approvalId, request.digest);
  await assert.rejects(f.publisher.start(request.approvalId, { ...plan, environmentId: 'changed' }), /does not match/);
  await assert.rejects(f.publisher.start('00000000-0000-4000-8000-000000000099', plan), /not found/);
  assert.equal(f.calls.length, 0);
}));
test('failure before linking safely resumes without recreating Test', () => fixture(async f => {
  const original = f.adapter.prepareLink; let failed = false;
  f.adapter.prepareLink = async (...args) => { if (!failed) { failed = true; throw new Error('Unavailable'); } return original(...args); };
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, plan);
  assert.equal(result.status, 'stopped'); assert.equal(result.cases[0]!.create, 'verified'); assert.equal(result.cases[0]!.link, 'pending');
  assert.equal((await f.publisher.resume(result.executionId)).status, 'complete');
  assert.equal(f.calls.filter(c => c === 'create:TC-1').length, 1);
}));
test('uncertain creation stops remaining cases and is never repeated on resume', () => fixture(async f => {
  f.adapter.create = async () => { f.calls.push('uncertain'); return { status: 'uncertain', message: 'Timeout', matchedCandidates: 0 }; };
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, plan);
  assert.equal(result.status, 'stopped'); assert.equal(result.cases[0]!.create, 'uncertain'); assert.equal(result.cases[1]!.create, 'pending');
  assert.equal((await f.publisher.resume(result.executionId)).status, 'stopped'); assert.deepEqual(f.calls, ['uncertain']);
}));
test('exception during link is recorded before sending and blocks retries', () => fixture(async f => {
  f.adapter.link = async () => { f.calls.push('link-throw'); throw new Error('Connection dropped'); };
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, plan);
  assert.equal(result.status, 'stopped');
  const resumed = await f.publisher.resume(result.executionId);
  assert.equal(resumed.cases[0]!.link, 'uncertain'); assert.equal(f.calls.filter(c => c === 'link-throw').length, 1);
}));
test('duplicate preflight blocks approval consumption', () => fixture(async f => {
  f.adapter.assertNoDuplicate = async () => { throw new Error('Duplicate'); };
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  await assert.rejects(f.publisher.start(request.approvalId, plan), /Duplicate/);
  assert.equal((await f.approvals.get(request.approvalId)).status, 'approved'); assert.equal(f.calls.length, 0);
}));
test('child gate rejects a changed payload before its write callback', () => fixture(async f => {
  let writes = 0;
  f.adapter.create = async (input, gate) => gate.execute(input.approvalId, {
    action: 'xray.test.create', projectKey: plan.projectKey, workflowId: plan.workflowId,
    correlationId: plan.workflowCorrelationId, operationPayload: buildManualTestOperationPayload({ ...input, summary: 'Changed' }),
  }, async () => { writes++; throw new Error('Must not run'); });
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  assert.equal((await f.publisher.start(request.approvalId, plan)).status, 'stopped'); assert.equal(writes, 0);
}));
test('execution lock rejects concurrent resume', () => fixture(async f => {
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  await f.publisher.start(request.approvalId, plan);
  await f.store.locked(request.approvalId, async () => {
    await assert.rejects(f.publisher.resume(request.approvalId), /locked/);
  });
}));
test('expired execution cannot perform remaining writes on resume', () => fixture(async f => {
  f.adapter.prepareLink = async () => { throw new Error('Temporary failure'); };
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  await f.publisher.start(request.approvalId, plan);
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse(request.expiresAt);
    assert.equal((await f.publisher.resume(request.approvalId)).status, 'stopped');
    assert.equal(f.calls.length, 1);
  } finally { Date.now = originalNow; }
}));
test('verification failure stops subsequent cases and resume performs reads only for completed writes', () => fixture(async f => {
  f.adapter.verify = async () => { throw new Error('Coverage unavailable'); };
  const request = await f.approvals.createRequest(f.gate.request(plan)); await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, plan);
  assert.equal(result.status, 'stopped'); assert.equal(result.cases[0]!.link, 'verified'); assert.equal(result.cases[1]!.create, 'pending');
  await f.publisher.resume(request.approvalId); assert.equal(f.calls.length, 2);
}));
test('durable journal detects content changes and does not trust modified progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-journal-'));
  try {
    const store = new StoryExecutionStore(dir);
    const id = '00000000-0000-4000-8000-000000000001';
    await store.locked(id, async () => store.save({ schemaVersion: '1.0.0', executionId: id, approvalId: id,
      planDigest: storyPlanDigest(plan), plan, expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'running',
      cases: plan.cases.map(c => ({ testCaseId: c.testCaseId, create: 'pending', link: 'pending' })) }));
    const path = join(dir, id + '.json');
    const entry = JSON.parse(await readFile(path, 'utf8'));
    entry.execution.cases[0]!.create = 'verified';
    await writeFile(path, JSON.stringify(entry));
    await assert.rejects(store.get(id), /integrity/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one approval links existing Test and creates/links new Test without recreating existing content', () => fixture(async f => {
  const mixed = mixedPlan(); const checked: string[] = [];
  f.adapter.assertNoDuplicate = async (_p, id) => { checked.push(id); };
  const request = await f.approvals.createRequest(f.gate.request(mixed));
  await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, mixed);
  assert.equal(result.status, 'complete');
  assert.deepEqual(f.calls.filter(c => c.startsWith('create:')), ['create:TC-2']);
  assert.equal(f.calls.filter(c => c.startsWith('link:')).length, 2);
  assert.equal(result.cases[0]!.create, 'not-applicable'); assert.equal(result.cases[0]!.key, 'QA-12');
  assert.ok(checked.every(id => id === 'TC-2'));
  assert.equal((await f.approvals.get(request.approvalId)).status, 'consumed');
  const calls = [...f.calls];
  assert.equal((await f.publisher.resume(result.executionId)).status, 'complete');
  assert.deepEqual(f.calls, calls);
  await assert.rejects(f.publisher.start(request.approvalId, mixed), /already exists/);
}));

test('mixed payload includes exact existing identity, evidence and links but no existing creation', () => {
  const mixed = mixedPlan(); const payload = storyPublishingPayload(mixed) as Record<string, CanonicalJsonValue>;
  assert.equal((payload.creations as CanonicalJsonValue[]).length, 1);
  assert.deepEqual((payload.links as Array<Record<string, CanonicalJsonValue>>)[0]!.inwardIssue, { key: 'QA-12' });
  assert.throws(() => caseInput(mixed, 'TC-existing', 'id'), /not an approved new/);
  const c = mixed.cases[0]!; assert.equal(c.kind, 'existing');
  if (c.kind !== 'existing') return;
  for (const changed of [{ ...c, existingTest: { ...c.existingTest, key: 'QA-13' } },
    { ...c, existingTest: { ...c.existingTest, description: 'Changed' } },
    { ...c, requirementCoverage: [{ ...c.requirementCoverage[0]!, rationale: 'Changed rationale' }] }]) {
    assert.notEqual(storyPlanDigest({ ...mixed, cases: [changed, mixed.cases[1]!] }), storyPlanDigest(mixed));
  }
});

test('mixed schema rejects missing or fabricated coverage, duplicate identities and existing recreation', () => {
  const mixed = mixedPlan(), c = mixed.cases[0]!; assert.equal(c.kind, 'existing');
  if (c.kind !== 'existing') return;
  for (const changed of [{ ...mixed, schemaVersion: '1.0.0' }, { ...mixed, storyEvidence: undefined },
    { ...mixed, cases: [{ ...c, requirementCoverage: [{ requirementId: 'UNKNOWN', stepNumbers: [1], rationale: 'Evidence' }] }, mixed.cases[1]!] },
    { ...mixed, cases: [{ ...c, requirementCoverage: [{ requirementId: 'AC1', stepNumbers: [99], rationale: 'Evidence' }] }, mixed.cases[1]!] },
    { ...mixed, cases: [c, { ...c, testCaseId: 'different' }, mixed.cases[1]!] },
    { ...mixed, cases: [{ ...c, steps: c.existingTest.steps }, mixed.cases[1]!] }]) assert.throws(() => parseStoryPlan(changed));
});

test('existing snapshot change blocks before approval consumption and leaves all writes untouched', () => fixture(async f => {
  const mixed = mixedPlan();
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  f.adapter.validateExisting = async () => { throw new Error('Existing content changed'); };
  await assert.rejects(f.publisher.start(request.approvalId, mixed), /content changed/);
  assert.equal((await f.approvals.get(request.approvalId)).status, 'approved'); assert.equal(f.calls.length, 0);
}));

test('changing an approved existing key rejects exact approval before writes', () => fixture(async f => {
  const mixed = mixedPlan(), c = mixed.cases[0]!; if (c.kind !== 'existing') throw new Error('fixture');
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  const changed = { ...mixed, cases: [{ ...c, existingTest: { ...c.existingTest, key: 'QA-13' } }, mixed.cases[1]!] };
  await assert.rejects(f.publisher.start(request.approvalId, changed), /does not match/);
  assert.equal(f.calls.length, 0);
}));

test('uncertain existing-Test link is never repeated and blocks remaining new creation', () => fixture(async f => {
  const mixed = mixedPlan();
  f.adapter.link = async () => { f.calls.push('uncertain-existing-link'); throw new Error('Transport lost'); };
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  const execution = await f.publisher.start(request.approvalId, mixed);
  assert.equal(execution.status, 'stopped'); assert.equal(execution.cases[0]!.link, 'uncertain');
  assert.equal((await f.publisher.resume(execution.executionId)).status, 'stopped');
  assert.deepEqual(f.calls, ['uncertain-existing-link']);
}));

test('association appearing after approval stops instead of silently skipping an approved link', () => fixture(async f => {
  const mixed = mixedPlan(), original = f.adapter.prepareLink;
  f.adapter.prepareLink = async (...args) => ({ ...await original(...args), alreadyLinked: true });
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  const execution = await f.publisher.start(request.approvalId, mixed);
  assert.equal(execution.status, 'stopped'); assert.equal(execution.cases[0]!.link, 'pending');
  assert.equal(f.calls.length, 0);
}));

test('changed content or revoked permissions on resume blocks every remaining operation', () => fixture(async f => {
  const mixed = mixedPlan(), original = f.adapter.prepareLink;
  let unavailable = true;
  f.adapter.prepareLink = async (...args) => { if (unavailable) throw new Error('Unavailable'); return original(...args); };
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  await f.publisher.start(request.approvalId, mixed);
  unavailable = false;
  f.adapter.preflight = async () => { throw new Error('Permissions revoked'); };
  assert.equal((await f.publisher.resume(request.approvalId)).status, 'stopped'); assert.equal(f.calls.length, 0);
}));

test('an explicitly approved already-linked Test is verified without another link or creation', () => fixture(async f => {
  const mixed = mixedPlan(), c = mixed.cases[0]!; if (c.kind !== 'existing') throw new Error('fixture');
  c.expectedAlreadyLinked = true; c.existingTest.coverage = [{ issueId: '1', key: mixed.storyKey }];
  const prepare = f.adapter.prepareLink, link = f.adapter.link;
  f.adapter.prepareLink = async (...args) => ({ ...await prepare(...args), alreadyLinked: args[1] === 'QA-12' });
  f.adapter.link = async (preview, execution, gate) => preview.alreadyLinked
    ? { status: 'already-linked', storyKey: preview.storyKey, testKey: preview.testKey, linkId: 'existing-link' }
    : link(preview, execution, gate);
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, mixed);
  assert.equal(result.status, 'complete'); assert.equal(result.cases[0]!.link, 'verified');
  assert.equal(f.calls.filter(c => c.startsWith('link:')).length, 1);
  assert.equal(f.calls.filter(c => c.startsWith('create:')).length, 1);
}));

test('mixed execution resumes a safe failure without repeating an existing-Test link', () => fixture(async f => {
  const mixed = mixedPlan(), original = f.adapter.prepareLink;
  let first = true;
  f.adapter.prepareLink = async (...args) => {
    if (args[1] !== 'QA-12' && first) { first = false; throw new Error('Read unavailable'); }
    return original(...args);
  };
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  assert.equal((await f.publisher.start(request.approvalId, mixed)).status, 'stopped');
  assert.equal((await f.publisher.resume(request.approvalId)).status, 'complete');
  assert.equal(f.calls.filter(c => c === 'link:QA-12').length, 1);
  assert.equal(f.calls.filter(c => c === 'create:TC-2').length, 1);
}));

test('a late existing-Test change is detected inside the child write gate before dispatch', () => fixture(async f => {
  const mixed = mixedPlan(); let reads = 0;
  f.adapter.validateExisting = async () => { if (++reads >= 4) throw new Error('Evidence changed immediately before write'); };
  const request = await f.approvals.createRequest(f.gate.request(mixed)); await f.approvals.approve(request.approvalId, request.digest);
  const result = await f.publisher.start(request.approvalId, mixed);
  assert.equal(result.status, 'stopped'); assert.ok(reads >= 4); assert.equal(f.calls.length, 0);
  assert.equal((await f.approvals.get(request.approvalId)).status, 'consumed');
  // The adapter was entered with a journaled write intent; conservatively retain uncertainty.
  assert.equal(result.cases[0]!.link, 'uncertain');
  await f.publisher.resume(request.approvalId); assert.equal(f.calls.length, 0);
}));
