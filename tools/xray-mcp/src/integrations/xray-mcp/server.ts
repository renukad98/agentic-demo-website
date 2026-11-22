import { isAbsolute, join, relative, resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readActiveStoryPublication } from '../../../agents/active-story-publication.js';
import { Ed25519ApprovalRecordSigner } from '../../../agents/approval-signature.js';
import { LocalDemoGrantSession, localDemoScopeGrantSchema } from '../../../agents/local-demo-scope-grant.js';
import { storyPlanSchema, parseStoryPlan, storyPlanDigest } from '../../../agents/contracts/xray-story-publication.js';
import { StoryExecutionStore } from '../../../agents/xray-story-publication-store.js';
import { StoryPublisher, DemoStoryApprovalGate, type StoryPublicationAdapter } from '../../../agents/xray-story-publication.js';
import { createStoryAdapter } from '../../../helpers/xray-story-adapter.js';
import { XrayDuplicateReviewError } from '../../../agents/xray-duplicate-review.js';
import { config } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildManualTestOperationPayload,
  createXrayClientFromEnvironment,
  XrayClientError,
  type ManualTestPublisher,
  type ManualTestPublicationInput,
  type XrayClient,
} from '../../../helpers/xray-client.js';
import { LocalDemoApprovalService, isLocalDemoModeEnabled, type LocalDemoApprovalRequest } from '../../../agents/local-demo-approval.js';
import { JiraIssueLinkClient } from '../../../helpers/jira-link-client.js';

interface GraphqlClient {
  graphqlRequest<TData>(query: string, variables?: Record<string, unknown>): Promise<TData>;
}

const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,9}$/);
const positiveIssueIdSchema = z.string().regex(/^[1-9]\d*$/);
const limitSchema = z.number().int().min(1).max(100).default(50);
const startSchema = z.number().int().min(0).max(10_000).default(0);

export const searchTestsInputSchema = z.object({
  projectKey: projectKeySchema,
  summaryQuery: z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N}\s._-]+$/u).optional(),
  limit: limitSchema,
  start: startSchema,
}).strict();

export const getTestInputSchema = z.object({
  issueId: positiveIssueIdSchema,
}).strict();

export const getTestCoverageInputSchema = z.object({
  testIssueId: positiveIssueIdSchema,
  limit: z.number().int().min(1).max(100).default(100),
  start: startSchema,
}).strict();

const manualStepSchema = z.object({
  action: z.string().trim().min(1),
  data: z.string(),
  result: z.string().trim().min(1),
}).strict();

/** Exact payload passed to the trusted publisher; this input is not itself an approval. */
export const createManualTestInputSchema = z.object({
  approvalId: z.string().uuid(),
  projectKey: projectKeySchema,
  summary: z.string().trim().min(1).max(255),
  description: z.string().optional(),
  steps: z.array(manualStepSchema).min(1).max(200),
  jiraFields: z.record(z.string(), z.unknown()).default({}),
  testCaseId: z.string().trim().min(1),
  workflowId: z.string().trim().min(1),
  workflowCorrelationId: z.string().trim().min(1),
}).strict();

export const prepareManualTestPreviewInputSchema = createManualTestInputSchema.omit({ approvalId: true });
export const prepareTestLinkPreviewInputSchema = z.object({
  storyKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/),
  testKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/),
  workflowId: z.string().trim().min(1),
  workflowCorrelationId: z.string().trim().min(1),
}).strict();
export const createTestLinkInputSchema = prepareTestLinkPreviewInputSchema.extend({
  approvalId: z.string().uuid(),
}).strict();

type SearchTestsInput = z.infer<typeof searchTestsInputSchema>;
type GetTestInput = z.infer<typeof getTestInputSchema>;
type GetTestCoverageInput = z.infer<typeof getTestCoverageInputSchema>;

const SEARCH_TESTS_QUERY = `
  query SearchXrayTests($jql: String!, $limit: Int!, $start: Int, $fields: [String]) {
    getTests(jql: $jql, limit: $limit, start: $start) {
      total
      start
      limit
      results {
        issueId
        testType { name kind }
        jira(fields: $fields)
      }
    }
  }
`;

const GET_TEST_QUERY = `
  query ReadXrayTest($issueId: String, $fields: [String]) {
    getTest(issueId: $issueId) {
      issueId
      testType { name kind }
      steps { action data result }
      jira(fields: $fields)
    }
  }
`;

const GET_TEST_COVERAGE_QUERY = `
  query ReadXrayTestCoverage(
    $issueId: String,
    $fields: [String],
    $limit: Int!,
    $start: Int
  ) {
    getTest(issueId: $issueId) {
      issueId
      jira(fields: $fields)
      coverableIssues(limit: $limit, start: $start) {
        total
        start
        limit
        warnings
        results {
          issueId
          jira(fields: $fields)
        }
      }
    }
  }
`;

const JIRA_FIELDS = ['key', 'summary', 'description'];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return redactKnownSecrets(value);
}

function redactKnownSecrets(value: string): string {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  const jiraBasic = JIRA_EMAIL && JIRA_API_TOKEN
    ? Buffer.from(`${JIRA_EMAIL.trim()}:${JIRA_API_TOKEN.trim()}`).toString('base64')
    : undefined;
  const secrets = [process.env.XRAY_CLIENT_ID, process.env.XRAY_CLIENT_SECRET, JIRA_EMAIL, JIRA_API_TOKEN, jiraBasic]
    .map(secret => secret?.trim())
    .filter((secret): secret is string => Boolean(secret))
    .sort((left, right) => right.length - left.length);
  let sanitized = value;
  for (const secret of secrets) sanitized = sanitized.split(secret).join('[REDACTED]');
  return sanitized
    .replace(/\bauthorization\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, 'authorization=[REDACTED]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .slice(0, 2_000);
}

function jiraFields(value: unknown): Record<string, string | null> {
  const fields = record(value);
  return {
    key: text(fields?.key),
    summary: text(fields?.summary),
    description: text(fields?.description),
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function escapeJqlPhrase(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function safeErrorMessage(error: unknown): string {
  return redactKnownSecrets(error instanceof Error ? error.message : String(error));
}

function errorResult(error: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  if (error instanceof XrayDuplicateReviewError) return { content: [{ type: 'text', text: JSON.stringify({
    code: error.code, testCaseId: error.packet?.testCaseId,
    candidates: error.packet?.candidates.map(c => c.ref),
  }) }], isError: true };
  const message = safeErrorMessage(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function toolResult(
  operation: () => Promise<unknown>,
): Promise<{ content: [{ type: 'text'; text: string }]; isError?: true }> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await operation()) }] };
  } catch (error: unknown) {
    return errorResult(error);
  }
}

export async function searchTests(client: GraphqlClient, input: unknown): Promise<unknown> {
  const parsed: SearchTestsInput = searchTestsInputSchema.parse(input);
  const jql = parsed.summaryQuery
    ? `project = ${parsed.projectKey} AND summary ~ "${escapeJqlPhrase(parsed.summaryQuery)}"`
    : `project = ${parsed.projectKey}`;
  const response = record(await client.graphqlRequest<unknown>(SEARCH_TESTS_QUERY, {
    jql,
    limit: parsed.limit,
    start: parsed.start,
    fields: ['key', 'summary'],
  }));
  const results = record(response?.getTests);
  if (!results || !Array.isArray(results.results)) {
    throw new XrayClientError('Xray search returned an unexpected response shape.');
  }

  return {
    total: asNumber(results.total),
    start: asNumber(results.start),
    limit: asNumber(results.limit),
    results: results.results.map((item: unknown) => {
      const test = record(item);
      const type = record(test?.testType);
      return {
        issueId: text(test?.issueId),
        testType: { name: text(type?.name), kind: text(type?.kind) },
        jira: jiraFields(test?.jira),
      };
    }),
  };
}

export async function getTest(client: GraphqlClient, input: unknown): Promise<unknown> {
  const parsed: GetTestInput = getTestInputSchema.parse(input);
  const response = record(await client.graphqlRequest<unknown>(GET_TEST_QUERY, {
    issueId: parsed.issueId,
    fields: JIRA_FIELDS,
  }));
  const test = record(response?.getTest);
  if (!test) return { found: false, issueId: parsed.issueId };

  const testType = record(test.testType);
  const steps = Array.isArray(test.steps) ? test.steps : [];
  return {
    found: true,
    issueId: text(test.issueId),
    testType: { name: text(testType?.name), kind: text(testType?.kind) },
    jira: jiraFields(test.jira),
    steps: steps.map((item: unknown) => {
      const step = record(item);
      return {
        action: text(step?.action),
        data: text(step?.data),
        result: text(step?.result),
      };
    }),
  };
}

export async function getTestCoverage(
  client: GraphqlClient,
  input: unknown,
): Promise<unknown> {
  const parsed: GetTestCoverageInput = getTestCoverageInputSchema.parse(input);
  const response = record(await client.graphqlRequest<unknown>(GET_TEST_COVERAGE_QUERY, {
    issueId: parsed.testIssueId,
    fields: ['key', 'summary'],
    limit: parsed.limit,
    start: parsed.start,
  }));
  const test = record(response?.getTest);
  if (!test) return { found: false, testIssueId: parsed.testIssueId };
  const coverage = record(test.coverableIssues);
  if (!coverage || !Array.isArray(coverage.results)) {
    throw new XrayClientError('Xray coverage query returned an unexpected response shape.');
  }

  return {
    found: true,
    test: { issueId: text(test.issueId), jira: jiraFields(test.jira) },
    coverage: {
      total: asNumber(coverage.total),
      start: asNumber(coverage.start),
      limit: asNumber(coverage.limit),
      warnings: Array.isArray(coverage.warnings)
        ? coverage.warnings.map((warning: unknown) => text(warning)).filter((warning): warning is string => warning !== null)
        : [],
      results: coverage.results.map((item: unknown) => {
        const issue = record(item);
        return { issueId: text(issue?.issueId), jira: jiraFields(issue?.jira) };
      }),
    },
  };
}

/** Trusted host owns request creation and supplies authenticated per-call publishers. */
export interface StoryPublicationHost {
  inspectDuplicates?(plan: ReturnType<typeof parseStoryPlan>, identity: unknown): Promise<unknown>;
  inspect?(input: { storyKey: string; existingTestKeys: string[] }, identity: unknown): Promise<unknown>;
  prepare(plan: ReturnType<typeof parseStoryPlan>, identity: unknown): Promise<unknown>;
  publisher(identity: unknown): StoryPublisher;
}

export function createXrayMcpServer(
  client: GraphqlClient = createXrayClientFromEnvironment(),
  manualTestPublisher?: ManualTestPublisher,
  localDemoApprovals?: LocalDemoApprovalService,
  jiraIssueLinkClient?: JiraIssueLinkClient,
  storyPublicationHost?: StoryPublicationHost,
  personalBatch?: {
    directory: string;
    tenant: string;
    projects: ReadonlySet<string>;
    adapter?: StoryPublicationAdapter;
    confirmationProbe?: boolean;
    assertPinnedPlan?: (plan: ReturnType<typeof parseStoryPlan>) => Promise<void>;
    activeStory?: {
      projectRoot: string;
      assertAuthorized?(plan: ReturnType<typeof parseStoryPlan>, requireFresh?: boolean): Promise<void>;
      signedScope?: LocalDemoGrantSession;
    };
  },
): McpServer {
  const activeStory = personalBatch?.activeStory;
  const signedScope = activeStory?.signedScope;
  if (activeStory && (!localDemoApprovals || storyPublicationHost || personalBatch.confirmationProbe ||
      personalBatch.assertPinnedPlan || (!signedScope && !activeStory.assertAuthorized))) {
    throw new Error('Active Story publication requires a separately authorized native operator session.');
  }
  const server = new McpServer({ name: 'xray-cloud', version: '1.0.0' });
  const sessionApprovals = new Set<string>();
  let nativePromptShown = false;
  const personalStore = personalBatch && (personalBatch.assertPinnedPlan || activeStory)
    ? new StoryExecutionStore(join(personalBatch.directory, 'story-executions'))
    : undefined;
  const checkPersonalScope = async (plan: ReturnType<typeof parseStoryPlan>, checkActive = true) => {
    if (!personalBatch) return;
    if (plan.schemaVersion !== '1.1.0') throw new Error('Personal batch requires reviewed Story identity and requirement evidence.');
    if ((!signedScope && !personalBatch.projects.has(plan.projectKey)) || plan.storyKey === 'KAN-29' ||
        (activeStory && plan.storyKey === 'KAN-30') ||
        plan.cases.some(c => c.kind === 'existing' && c.existingTest.key === 'KAN-30')) {
      throw new Error('Personal batch target is paused or outside the authorized projects.');
    }
    await personalBatch.assertPinnedPlan?.(plan);
    if (activeStory) {
      signedScope?.assertAuthorized(plan, checkActive);
      await activeStory.assertAuthorized?.(plan, checkActive);
      if (checkActive && storyPlanDigest(await readActiveStoryPublication(activeStory.projectRoot)) !== storyPlanDigest(plan)) {
        throw new Error('Operation does not match the current reviewed Story plan.');
      }
    }
  };
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;

  server.registerTool('xray_search_tests', {
    title: 'Search Xray Tests',
    description: 'Search Xray Tests in a required Jira project, optionally filtering by summary text.',
    inputSchema: searchTestsInputSchema,
    annotations: readOnlyAnnotations,
  }, (input) => toolResult(() => searchTests(client, input)));

  server.registerTool('xray_get_test', {
    title: 'Get Xray Test',
    description: 'Retrieve a Test by its positive numeric Jira issue ID, including Manual steps.',
    inputSchema: getTestInputSchema,
    annotations: readOnlyAnnotations,
  }, (input) => toolResult(() => getTest(client, input)));

  server.registerTool('xray_get_test_coverage', {
    title: 'Get Xray Test Coverage',
    description: 'Retrieve coverable Jira issues associated with an Xray Test, with bounded pagination.',
    inputSchema: getTestCoverageInputSchema,
    annotations: readOnlyAnnotations,
  }, (input) => toolResult(() => getTestCoverage(client, input)));

  if (localDemoApprovals || storyPublicationHost || personalBatch?.confirmationProbe) {
    if (signedScope && activeStory) {
      server.registerTool('xray_get_local_demo_challenge', {
        title: 'Read Local Demo Scope Challenge',
        description: 'Read the exact reviewed batch and session binding for a separate grant issuer. Operator identity is unverified.',
        inputSchema: z.object({}).strict(), annotations: readOnlyAnnotations,
      }, () => toolResult(async () => signedScope.challenge(await readActiveStoryPublication(activeStory.projectRoot))));
    }
    server.registerTool('xray_inspect_story_duplicates', {
      title: 'Inspect Story Test Duplicate Evidence',
      description: 'Read complete candidate content and anticipated plan cases for human duplicate review. Creates no approval and performs no remote writes.',
      inputSchema: z.object({ plan: storyPlanSchema }).strict(), annotations: readOnlyAnnotations,
    }, (input, extra) => toolResult(async () => {
      const plan = parseStoryPlan(input.plan);
      await checkPersonalScope(plan);
      if (personalBatch?.confirmationProbe) throw new Error('Remote inspection is disabled for the synthetic probe.');
      if (storyPublicationHost) {
        if (!storyPublicationHost.inspectDuplicates) throw new Error('Trusted duplicate inspection is unavailable.');
        return storyPublicationHost.inspectDuplicates(plan, extra.authInfo);
      }
      const adapter = createStoryAdapter(client as XrayClient, jiraIssueLinkClient ?? JiraIssueLinkClient.fromEnvironment());
      await adapter.preflight(plan);
      for (const c of plan.cases) if (c.kind === 'existing') await adapter.validateExisting(plan, c);
      return { packets: await Promise.all(plan.cases.filter(c => c.kind !== 'existing')
        .map(c => adapter.inspectDuplicates(plan, c.testCaseId))) };
    }));
    let storyPublisher: StoryPublisher | undefined;
    const getStoryPublisher = (identity?: unknown) => {
      if (storyPublicationHost) return storyPublicationHost.publisher(identity);
      if (!localDemoApprovals) throw new Error('No approval route configured.');
      if (!storyPublisher) {
        const directory = personalBatch?.directory ?? (process.env.XRAY_DEMO_APPROVAL_DIR || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'AgenticQAFramework', 'xray-demo-approvals') : ''));
        storyPublisher = new StoryPublisher(personalStore ?? new StoryExecutionStore(join(directory, 'story-executions')), new DemoStoryApprovalGate(localDemoApprovals), personalBatch?.adapter ?? createStoryAdapter(client as XrayClient, jiraIssueLinkClient ?? JiraIssueLinkClient.fromEnvironment()),
          personalStore ? async plan => {
            await checkPersonalScope(plan);
            await personalStore.assertNoPriorBatch(plan);
          } : undefined, personalStore ? checkPersonalScope : undefined,
          signedScope ? plan => signedScope.audit(plan) : undefined);
      }
      return storyPublisher;
    };
    server.registerTool('xray_prepare_story_publication', {
      title: 'Prepare Complete Story Publication', description: 'Inspect source/existing Tests without approval storage, or prepare one immutable reviewed Story plan. Local demo safeguard only. No remote writes.',
      inputSchema: z.object({ plan: storyPlanSchema.optional(), activeStory: z.literal(true).optional(),
        scopeGrant: localDemoScopeGrantSchema.optional(), inspect: z.object({
        storyKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/),
        existingTestKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/)).max(100)
          .refine(keys => new Set(keys).size === keys.length),
      }).strict().optional() }).strict().refine(input =>
        [input.plan, input.inspect, input.activeStory].filter(Boolean).length === 1,
      'Supply exactly one of plan, inspect, or activeStory.'),
    }, (input, extra) => toolResult(async () => {
      if (Boolean(signedScope) !== Boolean(input.scopeGrant)) {
        throw new Error('Use the scope grant input supported by the configured publication route.');
      }
      if (input.inspect) {
        if (signedScope) throw new Error('Use the active Story route for signed local demo preparation.');
        if (personalBatch && (!personalBatch.projects.has(input.inspect.storyKey.split('-')[0]!) ||
            input.inspect.storyKey === 'KAN-29' || input.inspect.existingTestKeys.includes('KAN-30'))) {
          throw new Error('Personal batch inspection target is paused or unauthorized.');
        }
        if (storyPublicationHost) {
          if (!storyPublicationHost.inspect) throw new Error('Trusted host inspection is unavailable.');
          return storyPublicationHost.inspect(input.inspect, extra.authInfo);
        }
        if (!localDemoApprovals) throw new Error('No approval route configured.');
        const jira = jiraIssueLinkClient ?? JiraIssueLinkClient.fromEnvironment();
        return createStoryAdapter(client as XrayClient, jira).inspect(input.inspect.storyKey, input.inspect.existingTestKeys);
      }
      if (Boolean(activeStory) !== Boolean(input.activeStory)) {
        throw new Error('Use the preparation input supported by the configured publication route.');
      }
      const plan = activeStory ? await readActiveStoryPublication(activeStory.projectRoot) : parseStoryPlan(input.plan);
      signedScope?.accept(input.scopeGrant, plan);
      await checkPersonalScope(plan);
      if (storyPublicationHost) return storyPublicationHost.prepare(plan, extra.authInfo);
      if (!localDemoApprovals && !personalBatch?.confirmationProbe) throw new Error('No approval route configured.');
      const preflight = async () => {
        if (personalBatch?.confirmationProbe) return;
        await checkPersonalScope(plan);
        await personalStore?.assertNoPriorBatch(plan, true);
        const adapter = personalBatch?.adapter ?? createStoryAdapter(client as XrayClient, jiraIssueLinkClient ?? JiraIssueLinkClient.fromEnvironment());
        await adapter.preflight(plan);
        for (const c of plan.cases) {
          if (c.kind === 'existing') await adapter.validateExisting(plan, c);
          else await adapter.assertNoDuplicate(plan, c.testCaseId);
        }
      };
      await preflight();
      const gate = localDemoApprovals ? new DemoStoryApprovalGate(localDemoApprovals) : undefined;
      if (personalBatch) {
        const capability = server.server.getClientCapabilities()?.elicitation;
        if (!capability || (!('form' in capability) && 'url' in capability))
          throw new Error('Native MCP form confirmation is unavailable.');
        const payload = gate?.request(plan);
        const message = (personalBatch.confirmationProbe ? 'NO-WRITE synthetic confirmation probe' :
          'Personal Xray demo — create and link this exact Manual Test batch?') + '\n' +
          JSON.stringify({ tenant: personalBatch.tenant, plan, operation: payload?.operationPayload,
            ...(signedScope ? { operatorIdentity: 'unverified' } : {}) }, null, 2);
        if (message.length > 100_000) throw new Error('Batch is too large for complete native review.');
        if (personalStore) {
          if (nativePromptShown) throw new Error('This session already requested its batch confirmation.');
          nativePromptShown = true;
        }
        try {
          const request = payload && await localDemoApprovals?.createRequest(payload, signedScope?.assertAuthorized(plan));
          const response = await server.server.elicitInput({
            mode: 'form',
            message,
            requestedSchema: { type: 'object', properties: {} },
          }, { relatedRequestId: extra.requestId, signal: extra.signal, timeout: 120_000 });
          if (personalBatch.confirmationProbe)
            return { status: 'NO_WRITE_PROBE', decision: extra.signal.aborted ? 'cancel' : response.action };
          if (response.action !== 'accept' || extra.signal.aborted) return { status: 'NOT_APPROVED' };
          await preflight();
          if (extra.signal.aborted) return { status: 'NOT_APPROVED' };
          if (!request || !localDemoApprovals) throw new Error('No approval route configured.');
          const approved = await localDemoApprovals.approve(request.approvalId, request.digest);
          sessionApprovals.add(approved.approvalId);
          return { status: 'APPROVED', approvalId: approved.approvalId, expiresAt: approved.expiresAt,
            ...(activeStory ? { plan } : {}), ...(signedScope ? { operatorIdentity: 'unverified' } : {}) };
        } finally {
          if (activeStory && !signedScope) nativePromptShown = false;
        }
      }
      if (!gate || !localDemoApprovals) throw new Error('No approval route configured.');
      const request = await localDemoApprovals.createRequest(gate.request(plan));
      return { mode: 'LOCAL DEMO ? workflow safeguard only', approvalId: request.approvalId, expiresAt: request.expiresAt,
        planDigest: storyPlanDigest(plan), approvalDigest: request.digest, exactPlan: plan, exactPublishingPayload: request.operationPayload,
        intendedLinks: plan.cases.map(c => ({ testCaseId: c.testCaseId,
          operation: c.kind === 'existing' ? (c.expectedAlreadyLinked ? 'verify-existing-link' : 'link-existing-test') : 'create-and-link',
          inwardIssue: c.kind === 'existing' ? c.existingTest.key : 'verified returned Test key', outwardIssue: plan.storyKey, type: plan.linkType })),
        approvalCommand: 'npm run xray:demo-approve -- ' + request.approvalId };
    }));
    if (!personalBatch?.confirmationProbe) {
    server.registerTool('xray_publish_story', {
      title: 'Publish Approved Story Plan', description: 'Consume one approval and create, link and verify the entire Story plan.',
      inputSchema: z.object({ approvalId: z.string().uuid(), plan: storyPlanSchema }).strict(),
    }, (input, extra) => toolResult(async () => {
      if (personalBatch && !sessionApprovals.delete(input.approvalId))
        throw new Error('Native approval is absent or already used in this session.');
      await checkPersonalScope(input.plan);
      signedScope?.reserveDispatch(input.plan);
      const result = await getStoryPublisher(extra.authInfo).start(input.approvalId, input.plan);
      return signedScope ? { ...result, operatorIdentity: 'unverified' } : result;
    }));
    if (!personalStore) server.registerTool('xray_resume_story_publication', {
      title: 'Resume Story Publication', description: 'Continue the existing execution. Never repeats uncertain writes.',
      inputSchema: z.object({ executionId: z.string().uuid() }).strict(),
    }, (input, extra) => toolResult(async () => {
      const publisher = getStoryPublisher(extra.authInfo);
      if (personalBatch) {
        const execution = await publisher.status(input.executionId);
        if (!execution) throw new Error('Execution not found.');
        await checkPersonalScope(execution.plan);
      }
      return publisher.resume(input.executionId);
    }));
    server.registerTool('xray_get_story_publication', {
      title: 'Story Publication Status', description: 'Read durable per-case creation and linking state.',
      inputSchema: z.object({ executionId: z.string().uuid() }).strict(), annotations: readOnlyAnnotations,
    }, (input, extra) => toolResult(async () => {
      signedScope?.assertGrantInstalled();
      const execution = await getStoryPublisher(extra.authInfo).status(input.executionId);
      if (execution && personalStore) await checkPersonalScope(execution.plan, false);
      if (execution && signedScope && execution.localDemoScope?.grantId !== signedScope.audit(execution.plan).grantId) {
        throw new Error('Execution is outside this local demo grant.');
      }
      return execution && signedScope ? { ...execution, operatorIdentity: 'unverified' } : execution;
    }));
    }

  }

  if (localDemoApprovals && !personalBatch) {
    server.registerTool('xray_prepare_manual_test_preview', {
      title: 'Prepare Local Demo Manual Test Preview',
      description: 'Searches for possible duplicates and stores a ten-minute exact-payload approval request. This local demo safeguard is not production authorization.',
      inputSchema: prepareManualTestPreviewInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, (input) => toolResult(async () => {
      const parsed = prepareManualTestPreviewInputSchema.parse(input) as Omit<ManualTestPublicationInput, 'approvalId'>;
      const candidates = await searchTests(client, {
        projectKey: parsed.projectKey, summaryQuery: parsed.summary, limit: 100, start: 0,
      }) as { total: number | null; results: Array<{ issueId: string | null; jira: { key: string | null; summary: string | null } }> };
      if (candidates.total !== null && candidates.total > candidates.results.length) {
        return { status: 'duplicate-search-incomplete', total: candidates.total, returned: candidates.results.length };
      }
      if (candidates.results.length > 0) {
        return { status: 'possible-duplicate', possibleDuplicates: candidates.results };
      }
      const operationPayload = buildManualTestOperationPayload(parsed);
      const request = await localDemoApprovals.createRequest({
        action: 'xray.test.create', projectKey: parsed.projectKey,
        workflowId: parsed.workflowId, correlationId: parsed.workflowCorrelationId,
        operationPayload,
      });
      return {
        mode: 'LOCAL DEMO — workflow safeguard only; same-user local processes are not isolated',
        approvalId: request.approvalId, expiresAt: request.expiresAt, payloadDigest: request.digest,
        projectKey: parsed.projectKey, action: request.action, workflowId: request.workflowId,
        correlationId: request.correlationId, exactPayload: operationPayload,
        approvalCommand: `npm run xray:demo-approve -- ${request.approvalId}`,
      };
    }));

    server.registerTool('xray_prepare_test_link_preview', {
      title: 'Prepare Local Demo Story Test Link Preview',
      description: 'Verifies Story, Manual Test and runtime Jira link metadata, then prepares a separate one-time demo approval. Local demo approval is not production authorization.',
      inputSchema: prepareTestLinkPreviewInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, (input) => toolResult(async () => {
      const parsed = prepareTestLinkPreviewInputSchema.parse(input);
      const jira = jiraIssueLinkClient ?? JiraIssueLinkClient.fromEnvironment();
      const preview = await jira.prepare(parsed.storyKey, parsed.testKey, client);
      if (preview.alreadyLinked) return { status: 'already-linked', ...preview };
      const request = await localDemoApprovals.createRequest({
        action: 'jira.issue.link', projectKey: preview.projectKey, workflowId: parsed.workflowId,
        correlationId: parsed.workflowCorrelationId,
        operationPayload: preview.payload as LocalDemoApprovalRequest['operationPayload'],
      });
      return {
        mode: 'LOCAL DEMO — workflow safeguard only; same-user local processes are not isolated',
        status: 'approval-required', approvalId: request.approvalId, expiresAt: request.expiresAt,
        payloadDigest: request.digest, workflowId: request.workflowId, correlationId: request.correlationId,
        exactLinkPayload: preview.payload, relationship: `${parsed.testKey} tests ${parsed.storyKey}; ${parsed.storyKey} is tested by ${parsed.testKey}`,
        approvalCommand: `npm run xray:demo-approve -- ${request.approvalId}`,
      };
    }));

    server.registerTool('xray_create_test_link', {
      title: 'Create Separately Approved Jira Test Link',
      description: 'Creates one Jira issue link only after a separate local demo approval; rechecks duplicate state and reads the link back. Demo mode is not production authorization.',
      inputSchema: createTestLinkInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, (input) => toolResult(async () => {
      const parsed = createTestLinkInputSchema.parse(input);
      const jira = jiraIssueLinkClient ?? JiraIssueLinkClient.fromEnvironment();
      const preview = await jira.prepare(parsed.storyKey, parsed.testKey, client);
      const result = await jira.createApproved(preview, parsed.approvalId, parsed.workflowId,
        parsed.workflowCorrelationId, localDemoApprovals);
      return { mode: 'LOCAL DEMO — workflow safeguard only', ...result };
    }));
  }

  if (manualTestPublisher) server.registerTool('xray_create_manual_test', {
    title: 'Create Approved Xray Manual Test',
    description: 'Create one Manual Test from an exact separately approved payload. Production requires the trusted approval host; local demo publishing is available only when explicitly enabled and is not trusted authorization.',
    inputSchema: createManualTestInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, extra) => toolResult(async () => {
    const parsed = createManualTestInputSchema.parse(input);
    return manualTestPublisher.publish(parsed, extra.authInfo);
  }));

  return server;
}

/** The caller owns chat approval. Use only in an authorized local session. */
export function createChatWriteXrayMcpServer(
  client: GraphqlClient & Pick<XrayClient, 'createManualTest' | 'createTestPlan'>,
  getJiraClient = () => JiraIssueLinkClient.fromEnvironment(),
): McpServer {
  const server = createXrayMcpServer(client);
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  server.registerTool('xray_create_manual_test', {
    description: 'Create one Manual Test after explicit approval of the exact chat preview.',
    inputSchema: z.object({
      projectKey: projectKeySchema,
      summary: z.string().min(1).max(255).refine(value => value.trim().length > 0),
      steps: z.array(z.object({
        action: z.string().refine(value => value.trim().length > 0),
        data: z.string(),
        result: z.string().refine(value => value.trim().length > 0),
      }).strict()).min(1).max(200),
      folderPath: z.string().refine(value => value.trim().length > 0).optional(),
    }).strict(),
    annotations: writeAnnotations,
  }, input => toolResult(() => client.createManualTest(input)));

  const planKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/);
  server.registerTool('xray_create_test_plan', {
    description: 'Create one Xray Test Plan after explicit approval of the exact chat preview, then resolve its Jira key by read.',
    inputSchema: z.object({ projectKey: projectKeySchema, summary: z.string().trim().min(1).max(255) }).strict(),
    annotations: writeAnnotations,
  }, ({ projectKey, summary }) => toolResult(async () => {
    const issueId = await client.createTestPlan(projectKey, summary);
    try {
      const result = record(await client.graphqlRequest<unknown>(`query VerifyTestPlan($issueId: String) {
        getTestPlan(issueId: $issueId) { issueId jira(fields: ["key", "summary"]) }
      }`, { issueId }));
      const plan = record(result?.getTestPlan);
      const jira = record(plan?.jira);
      const key = planKeySchema.safeParse(jira?.key);
      if (plan?.issueId === issueId && key.success && key.data.startsWith(projectKey + "-") && jira?.summary === summary) {
        return { issueId, key: key.data };
      }
    } catch { /* Preserve the known issue ID for read-only reconciliation. */ }
    throw new XrayClientError(`Xray Test Plan issue ID ${issueId} could not be verified. Reconcile by read before retrying.`);
  }));

  server.registerTool('jira_link_issues', {
    description: 'Create and verify one Jira Relates link after explicit approval of the exact chat preview.',
    inputSchema: z.object({ inwardKey: planKeySchema, outwardKey: planKeySchema }).strict(),
    annotations: { ...writeAnnotations, idempotentHint: true },
  }, ({ inwardKey, outwardKey }) => toolResult(() => getJiraClient().linkRelatedIssues(inwardKey, outwardKey)));

  const linkSchema = prepareTestLinkPreviewInputSchema.pick({ storyKey: true, testKey: true });
  server.registerTool('xray_resolve_test_keys', {
    description: 'Resolve Xray Test issue IDs to Jira keys. A null key indicates an unresolved ID.',
    inputSchema: z.object({ issueIds: z.array(positiveIssueIdSchema).min(1).max(100) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ issueIds }) => toolResult(async () => {
    const response = record(await client.graphqlRequest<unknown>(
      `query ResolveTestKeys($issueIds: [String], $limit: Int!) {
        getTests(issueIds: $issueIds, limit: $limit) { results { issueId jira(fields: ["key"]) } }
      }`,
      { issueIds: [...new Set(issueIds)], limit: issueIds.length },
    ));
    const results = record(response?.getTests)?.results;
    if (!Array.isArray(results)) throw new XrayClientError('Xray did not return Test identities.');
    const keys = new Map<string, string>();
    for (const result of results) {
      const test = record(result);
      const issueId = text(test?.issueId);
      const key = text(record(test?.jira)?.key);
      if (!issueId || !key || !linkSchema.shape.testKey.safeParse(key).success) continue;
      if (keys.has(issueId) && keys.get(issueId) !== key) {
        throw new XrayClientError(`Xray returned conflicting keys for Test issue ID ${issueId}.`);
      }
      keys.set(issueId, key);
    }
    return issueIds.map(issueId => ({ issueId, key: keys.get(issueId) ?? null }));
  }));

  server.registerTool('xray_link_test_to_story', {
    description: 'Link one verified Manual Test to the approved Jira Story and read back the Test link.',
    inputSchema: linkSchema,
    annotations: writeAnnotations,
  }, ({ storyKey, testKey }) => toolResult(async () => {
    const jira = getJiraClient();
    const preview = await jira.prepare(storyKey, testKey, client);
    return jira.linkTestToStory(preview);
  }));
  return server;
}

export async function pinPersonalBatchPlan(projectRoot: string, planPath: string, authorizedDigest: string) {
  const root = await realpath(projectRoot);
  const path = await realpath(resolve(root, planPath));
  const withinRoot = relative(root, path);
  if (!withinRoot || withinRoot === '..' || withinRoot.startsWith('..\\') ||
      withinRoot.startsWith('../') || isAbsolute(withinRoot))
    throw new Error('Reviewed batch plan must be inside the active project.');
  const readPlan = async () => parseStoryPlan(JSON.parse(await readFile(path, 'utf8')));
  const pinnedDigest = storyPlanDigest(await readPlan());
  if (pinnedDigest !== authorizedDigest) throw new Error('Reviewed plan does not match the authorized batch digest.');
  return async (plan: ReturnType<typeof parseStoryPlan>) => {
    if (storyPlanDigest(plan) !== pinnedDigest || storyPlanDigest(await readPlan()) !== pinnedDigest)
      throw new Error('Operation does not match the unchanged authorized session plan.');
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--personal-batch-probe')) {
    const probeClient = { async graphqlRequest<T>(): Promise<T> {
      throw new Error('Remote reads and writes are disabled for the synthetic probe.');
    } };
    const server = createXrayMcpServer(probeClient, undefined, undefined, undefined, undefined, {
      directory: '', tenant: 'https://fixture.invalid', projects: new Set(['QA']), confirmationProbe: true,
    });
    await server.connect(new StdioServerTransport());
    return;
  }
  const personalBatchDemo = process.argv.includes('--personal-batch-demo');
  const batchRoute = personalBatchDemo
    ? JSON.parse(await readFile(resolve(process.cwd(), 'qa/pipeline.json'), 'utf8'))
      .commands?.['qa xray']?.manualTestBatch
    : undefined;
  if (personalBatchDemo && batchRoute?.liveDispatchEnabled !== true) {
    process.stderr.write('XRAY_BATCH_DISABLED: Live batch publishing is disabled by repository policy.\n');
    process.exitCode = 1;
    return;
  }

  config({ quiet: true });
  const client = createXrayClientFromEnvironment();
  let server: McpServer;
  if (personalBatchDemo) {
    if (!isLocalDemoModeEnabled({ ...process.env, XRAY_LOCAL_DEMO_MODE: 'true' }) || !process.env.LOCALAPPDATA)
      throw new Error('Personal batch demo requires a local Windows user session outside CI.');
    const projects = new Set((process.env.XRAY_PERSONAL_BATCH_PROJECTS ?? '').split(',').map(v => v.trim()).filter(Boolean));
    if (!projects.size || [...projects].some(v => !projectKeySchema.safeParse(v).success))
      throw new Error('An explicit personal batch project allowlist is required.');
    const [mode, planPath, ...extra] = process.argv.slice(2);
    if (mode !== '--personal-batch-demo' || !planPath || extra.length)
      throw new Error('Personal batch demo requires exactly one reviewed batch plan file.');
    const authorizedBatch = batchRoute?.reviewedLiveBatchCandidate;
    const requestedDigest = process.env.XRAY_PERSONAL_BATCH_DIGEST;
    if (!requestedDigest ||
        planPath !== authorizedBatch?.planPath || requestedDigest !== authorizedBatch?.digest)
      throw new Error('Personal batch demo is disabled for this plan or digest.');
    const assertPinnedPlan = await pinPersonalBatchPlan(process.cwd(), planPath, requestedDigest);
    const jira = JiraIssueLinkClient.fromEnvironment();
    const tenant = new URL(process.env.JIRA_BASE_URL ?? '').origin;
    if (tenant !== process.env.XRAY_PERSONAL_BATCH_TENANT)
      throw new Error('Jira origin does not match the authorized batch tenant.');
    const xrayOrigin = new URL(process.env.XRAY_BASE_URL?.trim() || 'https://xray.cloud.getxray.app').origin;
    if (xrayOrigin !== process.env.XRAY_PERSONAL_BATCH_XRAY_ORIGIN)
      throw new Error('Xray origin does not match the authorized batch endpoint.');
    const namespace = createHash('sha256').update(JSON.stringify([
      tenant, xrayOrigin,
    ])).digest('hex');
    const directory = join(process.env.LOCALAPPDATA, 'AgenticDemoWebsite', 'xray-personal-batch', namespace);
    const approvals = new LocalDemoApprovalService(directory, undefined, undefined, 120_000);
    process.stderr.write('Xray MCP: LOCAL DEMO approval mode is active; it is not production authorization.\n');
    server = createXrayMcpServer(client, undefined, approvals, jira, undefined, { directory, tenant, projects, assertPinnedPlan });
  } else if (process.argv.slice(2).includes('--signed-local-demo')) {
    if (process.argv[2] !== '--signed-local-demo' || process.argv.length !== 3) {
      throw new Error('Signed local demo must be started with --signed-local-demo alone.');
    }
    try {
      if (!isLocalDemoModeEnabled({ ...process.env, XRAY_LOCAL_DEMO_MODE: 'true' }) || !process.env.LOCALAPPDATA)
        throw new Error('Local demo requires Windows outside production and CI.');
      const jiraUrl = new URL(process.env.JIRA_BASE_URL ?? '');
      const tenant = jiraUrl.origin;
      const xrayOrigin = new URL(process.env.XRAY_BASE_URL?.trim() || 'https://xray.cloud.getxray.app').origin;
      if (jiraUrl.href !== tenant + '/' || !tenant.startsWith('https://') || !xrayOrigin.startsWith('https://') ||
          (process.env.XRAY_GRAPHQL_URL && new URL(process.env.XRAY_GRAPHQL_URL).origin !== xrayOrigin)) {
        throw new Error('Local demo requires HTTPS and matching Xray origins.');
      }
      const publicKeyFile = process.env.XRAY_LOCAL_DEMO_PUBLIC_KEY_FILE;
      if (!publicKeyFile || !isAbsolute(publicKeyFile)) throw new Error('A provisioned verification key is required.');
      const keyPath = await realpath(publicKeyFile);
      const keyLocation = relative(await realpath(process.cwd()), keyPath);
      if (!(keyLocation === '..' || keyLocation.startsWith('../') || keyLocation.startsWith('..\\') || isAbsolute(keyLocation))) {
        throw new Error('The scope verification key must be provisioned outside the workspace.');
      }
      const publicKey = (await readFile(keyPath, 'utf8')).trim();
      if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(publicKey)) {
        throw new Error('Expected an Ed25519 public PEM.');
      }
      const issuerKey = new Ed25519ApprovalRecordSigner(publicKey);
      const jira = JiraIssueLinkClient.fromEnvironment();
      const namespace = createHash('sha256').update(JSON.stringify([tenant, xrayOrigin])).digest('hex');
      const directory = join(process.env.LOCALAPPDATA, 'AgenticDemoWebsite', 'xray-personal-batch', namespace);
      const approvals = new LocalDemoApprovalService(directory, undefined, undefined, 120_000);
      server = createXrayMcpServer(client, undefined, approvals, jira, undefined, {
        directory, tenant, projects: new Set(),
        activeStory: { projectRoot: process.cwd(), signedScope: new LocalDemoGrantSession({ tenant, xrayOrigin }, issuerKey) },
      });
    } catch (error) {
      process.stderr.write(`Xray MCP: signed local demo configuration unavailable. Read-only tools only. ${safeErrorMessage(error)}\n`);
      server = createXrayMcpServer(client);
    }
  } else if (process.argv.slice(2).includes('--enable-writes') || process.env.XRAY_ENABLE_WRITES === 'true') {
    process.stderr.write('Xray MCP: opt-in writes enabled for Manual Test creation and Story linking.\n');
    server = createChatWriteXrayMcpServer(client);
  } else {
    server = createXrayMcpServer(client);
  }
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`Xray MCP server failed to start: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
