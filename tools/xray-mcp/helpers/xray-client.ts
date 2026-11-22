import type { ManualTestPublicationInput } from '../agents/contracts/xray-publication.js';
import { buildManualTestOperationPayload } from '../agents/xray-payload.js';
export type { ManualTestPublicationInput } from '../agents/contracts/xray-publication.js';
export { buildManualTestOperationPayload } from '../agents/xray-payload.js';
import {
  ApprovalService,
  ApprovalServiceError,
  type ApprovalWriteInput,
} from '../agents/approval-service.js';
import { canonicalizeJson } from '../agents/approval-canonicalization.js';
import type { ApprovalId } from '../agents/contracts/workflow.js';
import { assertReadOnlyGraphqlDocument } from './graphql-read-only.js';
import type { LocalDemoApprovalRequest, LocalDemoApprovalService } from '../agents/local-demo-approval.js';

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const FALLBACK_TOKEN_LIFETIME_MS = 23 * 60 * 60 * 1_000;

export type ManualTestPublicationResult =
  | { readonly status: 'created-and-verified'; readonly issueId: string; readonly key: string; readonly reconciled: boolean }
  | { readonly status: 'uncertain'; readonly message: string; readonly matchedCandidates: number };

export interface XrayClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  graphqlUrl: string;
}

export class XrayClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XrayClientError';
  }
}

export class XrayMutationUncertainError extends XrayClientError {}

/** Host composition adapter for the existing MCP tool; it carries no caller-supplied identity. */
export interface ManualTestPublisher {
  publish(input: ManualTestPublicationInput, hostIdentityContext: unknown): Promise<ManualTestPublicationResult>;
}

export class XrayManualTestPublisher implements ManualTestPublisher {
  constructor(private readonly client: XrayClient, private readonly approvals: ApprovalService) {}

  publish(input: ManualTestPublicationInput, hostIdentityContext: unknown): Promise<ManualTestPublicationResult> {
    return this.client.createManualTestApproved(input, hostIdentityContext, this.approvals);
  }
}

/** Explicitly low-trust local demo route; production keeps using XrayManualTestPublisher. */
export class LocalDemoXrayManualTestPublisher implements ManualTestPublisher {
  constructor(private readonly client: XrayClient, private readonly approvals: LocalDemoApprovalService) {}

  publish(input: ManualTestPublicationInput, _hostIdentityContext: unknown): Promise<ManualTestPublicationResult> {
    return this.client.createManualTestWithLocalDemoApproval(input, this.approvals);
  }
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new XrayClientError(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function requireHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XrayClientError(`${name} must be a valid HTTPS URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new XrayClientError(`${name} must use HTTPS.`);
  }

  return url.toString().replace(/\/$/, '');
}

function tokenExpiryMs(token: string): number {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) {
    return Date.now() + FALLBACK_TOKEN_LIFETIME_MS;
  }

  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'exp' in payload &&
      typeof payload.exp === 'number'
    ) {
      const expiry = payload.exp * 1_000;
      if (Number.isFinite(expiry) && expiry > Date.now()) {
        return expiry;
      }
    }
  } catch {
    // Xray Cloud tokens are expected to be JWTs. Fall back to a conservative
    // refresh time if the token format changes or its payload cannot be read.
  }

  return Date.now() + FALLBACK_TOKEN_LIFETIME_MS;
}

function graphQLErrorMessages(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || !('errors' in payload)) {
    return [];
  }

  const errors: unknown = payload.errors;
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.flatMap((error: unknown) => {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      return [];
    }

    return typeof error.message === 'string' ? [error.message] : [];
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapType(value: unknown): Record<string, unknown> | null {
  let current = objectRecord(value);
  while (current && (current.kind === 'NON_NULL' || current.kind === 'LIST')) {
    current = objectRecord(current.ofType);
  }
  return current;
}

function formatType(value: unknown): string {
  const type = objectRecord(value);
  if (!type) throw new XrayClientError('Xray schema returned an invalid type reference.');
  if ((type.kind === 'NON_NULL' || type.kind === 'LIST') && type.ofType) {
    const nested = formatType(type.ofType);
    return type.kind === 'NON_NULL' ? `${nested}!` : `[${nested}]`;
  }
  if (typeof type.name !== 'string') throw new XrayClientError('Xray schema type name is unavailable.');
  return type.name;
}

function schemaField(type: unknown, name: string): Record<string, unknown> | undefined {
  const fields = objectRecord(type)?.fields;
  return Array.isArray(fields)
    ? fields.map(objectRecord).find((field) => field?.name === name) ?? undefined
    : undefined;
}

function inputField(type: unknown, name: string): Record<string, unknown> | undefined {
  const fields = objectRecord(type)?.inputFields;
  return Array.isArray(fields)
    ? fields.map(objectRecord).find((field) => field?.name === name) ?? undefined
    : undefined;
}

function schemaArgs(field: Record<string, unknown> | undefined): Map<string, Record<string, unknown>> {
  const args = field?.args;
  return new Map(Array.isArray(args)
    ? args.map(objectRecord).filter((arg): arg is Record<string, unknown> => arg !== null)
      .map((arg) => [String(arg.name), arg])
    : []);
}

function schemaTypeSelection(depth: number): string {
  if (depth === 0) return 'kind name';
  return `kind name ofType { ${schemaTypeSelection(depth - 1)} }`;
}

function exactStepMatch(expected: ManualTestPublicationInput['steps'], actual: unknown): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((step, index) => {
    const saved = objectRecord(actual[index]);
    return saved?.action === step.action && (saved.data ?? '') === step.data && saved.result === step.result;
  });
}

function matchesSavedTest(
  test: unknown,
  expected: ManualTestPublicationInput,
): { issueId: string; key: string } | null {
  const saved = objectRecord(test);
  const testType = objectRecord(saved?.testType);
  const jira = objectRecord(saved?.jira);
  const project = objectRecord(jira?.project);
  if (
    !saved || typeof saved.issueId !== 'string' ||
    testType?.name !== 'Manual' || jira?.summary !== expected.summary ||
    (project?.key ?? jira?.projectKey) !== expected.projectKey ||
    !exactStepMatch(expected.steps, saved.steps) || typeof jira.key !== 'string'
  ) return null;
  return { issueId: saved.issueId, key: jira.key };
}

export function createXrayClientFromEnvironment(): XrayClient {
  const baseUrl = requireHttpsUrl(
    process.env.XRAY_BASE_URL?.trim() || 'https://xray.cloud.getxray.app',
    'XRAY_BASE_URL',
  );
  const graphqlUrl = requireHttpsUrl(
    process.env.XRAY_GRAPHQL_URL?.trim() || `${baseUrl}/api/v2/graphql`,
    'XRAY_GRAPHQL_URL',
  );

  return new XrayClient({
    clientId: requiredEnvironmentValue('XRAY_CLIENT_ID'),
    clientSecret: requiredEnvironmentValue('XRAY_CLIENT_SECRET'),
    baseUrl,
    graphqlUrl,
  });
}

export class XrayClient {
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;
  private authenticationInProgress: Promise<string> | undefined;

  constructor(private readonly options: XrayClientOptions) {}

  async graphqlRequest<TData>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<TData> {
    // This public helper is read-only. Keep all mutations behind narrow methods that
    // require an approval gate; do not allow callers to smuggle a mutation here.
    try {
      assertReadOnlyGraphqlDocument(query);
    } catch (error: unknown) {
      throw new XrayClientError(error instanceof Error ? error.message : 'GraphQL document is not an allowed read query.');
    }

    const token = await this.getAccessToken();
    return this.postGraphql<TData>(query, variables, token);
  }

  /** Opt-in Test Plan route for the chat-approved session. */
  async createTestPlan(projectKey: string, summary: string): Promise<string> {
    const query = `mutation CreateTestPlan($jira: JSON!) {
      createTestPlan(jira: $jira) { testPlan { issueId } }
    }`;
    const token = await this.getAccessToken();
    try {
      const result = await this.postGraphql<{ createTestPlan?: { testPlan?: { issueId?: string } } }>(
        query, { jira: { fields: { project: { key: projectKey }, summary } } }, token,
      );
      const issueId = result.createTestPlan?.testPlan?.issueId;
      if (typeof issueId !== 'string' || !/^[1-9]\d*$/.test(issueId))
        throw new XrayClientError('Xray did not return a valid Test Plan issue ID.');
      return issueId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new XrayMutationUncertainError(`${message} Check for the Test Plan by read before retrying creation.`);
    }
  }

  /** Opt-in Manual Test route for the chat-approved session. */
  async createManualTest(input: Pick<ManualTestPublicationInput, 'projectKey' | 'summary' | 'steps'> & {
    folderPath?: string;
  }): Promise<{ issueId: string; warnings: string[] }> {
    const query = `mutation CreateManualTest($steps: [CreateStepInput], $jira: JSON!, $folderPath: String) {
      createTest(testType: { name: "Manual" }, steps: $steps, jira: $jira, folderPath: $folderPath) {
        test { issueId }
        warnings
      }
    }`;
    const token = await this.getAccessToken();
    try {
      const result = await this.postGraphql<{
        createTest?: { test?: { issueId?: string }; warnings?: unknown };
      }>(query, {
        steps: input.steps,
        jira: { fields: { project: { key: input.projectKey }, summary: input.summary } },
        ...(input.folderPath === undefined ? {} : { folderPath: input.folderPath }),
      }, token);
      const issueId = result.createTest?.test?.issueId;
      if (typeof issueId !== 'string' || !/^[1-9]\d*$/.test(issueId)) {
        throw new XrayClientError('Xray did not return a valid Test issue ID.');
      }
      const warnings = result.createTest?.warnings;
      return {
        issueId,
        warnings: Array.isArray(warnings)
          ? warnings.filter((warning): warning is string => typeof warning === 'string')
            .map(warning => this.sanitizeRemoteMessage(warning))
          : [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new XrayMutationUncertainError(`${message} Check for the Test before retrying creation.`);
    }
  }

  /** Dedicated mutation route. It consumes a matching signed approval immediately before POST. */
  async createManualTestApproved(
    input: ManualTestPublicationInput,
    identityContext: unknown,
    approvalService: ApprovalService,
  ): Promise<ManualTestPublicationResult> {
    if (!identityContext || typeof identityContext !== 'object') {
      throw new ApprovalServiceError('unauthorized', 'The MCP host did not provide authenticated caller identity.');
    }
    if (
      !/^[A-Z][A-Z0-9_]{0,9}$/.test(input.projectKey) || !input.summary.trim() ||
      input.steps.length === 0 || input.steps.length > 200 ||
      input.steps.some((step) => !step.action.trim() || !step.result.trim() || typeof step.data !== 'string') ||
      !input.testCaseId.trim() || !input.workflowId.trim() || !input.workflowCorrelationId.trim()
    ) throw new XrayClientError('Manual Test payload is invalid.');
    const fields = { ...input.jiraFields };
    if (
      ('project' in fields && objectRecord(fields.project)?.key !== input.projectKey) ||
      ('summary' in fields && fields.summary !== input.summary) ||
      ('description' in fields && input.description !== undefined && fields.description !== input.description)
    ) throw new XrayClientError('Jira field values conflict with the approved Test payload.');
    const jiraFields = {
      ...fields,
      project: { key: input.projectKey },
      summary: input.summary,
      ...(input.description === undefined ? {} : { description: input.description }),
    };
    const payload = buildManualTestOperationPayload(input);

    const approvalId = input.approvalId as ApprovalId;
    const approval = await approvalService.getApproval(approvalId);
    if (
      approval.record.status !== 'approved' || approval.record.actionType !== 'xray.test.create' ||
      approval.record.requestedOperation.operationId !== 'xray.createManualTest' ||
      approval.record.workflowId !== input.workflowId ||
      approval.record.workflowCorrelationId !== input.workflowCorrelationId ||
      approval.record.scope.projectKey !== input.projectKey
    ) throw new ApprovalServiceError('mismatch', 'Approval action, project, or workflow does not match the requested Test.');
    if (approval.consumedAt !== null) throw new ApprovalServiceError('reused', 'Approval has already been consumed.');
    if (canonicalizeJson(approval.operationPayload) !== canonicalizeJson(payload)) {
      throw new ApprovalServiceError('mismatch', 'Payload differs from the approved canonical operation.');
    }

    const token = await this.getAccessToken();
    const schema = await this.verifyManualCreateSchema(token);
    const mutation = this.createMutationDocument(schema);
    const writeInput: ApprovalWriteInput = {
      approvalId,
      actionType: 'xray.test.create',
      scope: approval.record.scope,
      operationId: 'xray.createManualTest',
      description: approval.record.requestedOperation.description,
      operationPayload: payload,
      workflowId: approval.record.workflowId,
      workflowCorrelationId: approval.record.workflowCorrelationId,
      expiresAt: approval.record.expiresAt,
    };

    return approvalService.executeApprovedWrite(writeInput, identityContext, async () => {
      try {
        const result = await this.postGraphql<unknown>(mutation.document, mutation.variables(input, jiraFields), token);
        const mutationData = objectRecord(result);
        const createResult = objectRecord(mutationData?.createTest);
        const createdTest = objectRecord(createResult?.test);
        const issueId = createdTest?.issueId;
        const createdKey = objectRecord(createdTest?.jira)?.key;
        if (typeof issueId !== 'string' || typeof createdKey !== 'string') return this.reconcileManualTest(input, token);
        const saved = await this.readTest(issueId, token);
        const match = matchesSavedTest(saved, input);
        if (!match || match.issueId !== issueId || match.key !== createdKey) {
          throw new XrayClientError('Xray created a Test, but read-back did not match the approved payload.');
        }
        return { status: 'created-and-verified', ...match, reconciled: false };
      } catch (error: unknown) {
        if (error instanceof ApprovalServiceError) throw error;
        try {
          return await this.reconcileManualTest(input, token);
        } catch {
          return { status: 'uncertain', message: 'Xray mutation outcome is uncertain and read-only reconciliation failed; do not retry automatically.', matchedCandidates: 0 };
        }
      }
    });
  }

  /** Local demo only. Approval is a human-operated workflow safeguard, not trusted identity authorization. */
  async createManualTestWithLocalDemoApproval(input: ManualTestPublicationInput, approvals: Pick<LocalDemoApprovalService, 'execute'>): Promise<ManualTestPublicationResult> {
    return this.createManualTestWithExecutionGate(input, approvals);
  }

  /** Narrow execution gate supplied by either demo approval or the approved Story coordinator. */
  async createManualTestWithExecutionGate(
    input: ManualTestPublicationInput,
    approvals: Pick<LocalDemoApprovalService, 'execute'>,
  ): Promise<ManualTestPublicationResult> {
    if (
      !/^[A-Z][A-Z0-9_]{0,9}$/.test(input.projectKey) || !input.summary.trim() ||
      input.steps.length === 0 || input.steps.length > 200 ||
      input.steps.some((step) => !step.action.trim() || !step.result.trim() || typeof step.data !== 'string') ||
      !input.testCaseId.trim() || !input.workflowId.trim() || !input.workflowCorrelationId.trim()
    ) throw new XrayClientError('Manual Test payload is invalid.');
    const fields = { ...input.jiraFields };
    if (
      ('project' in fields && objectRecord(fields.project)?.key !== input.projectKey) ||
      ('summary' in fields && fields.summary !== input.summary) ||
      ('description' in fields && input.description !== undefined && fields.description !== input.description)
    ) throw new XrayClientError('Jira field values conflict with the approved Test payload.');
    const jiraFields = {
      ...fields,
      project: { key: input.projectKey },
      summary: input.summary,
      ...(input.description === undefined ? {} : { description: input.description }),
    };
    const payload = buildManualTestOperationPayload(input);
    const demoRequest: LocalDemoApprovalRequest = {
      action: 'xray.test.create', projectKey: input.projectKey,
      workflowId: input.workflowId, correlationId: input.workflowCorrelationId,
      operationPayload: payload,
    };

    // Schema verification and token acquisition happen before consumption; consumption is
    // atomic immediately before the mutation callback, which performs one mutation only.
    const token = await this.getAccessToken();
    const schema = await this.verifyManualCreateSchema(token);
    const mutation = this.createMutationDocument(schema);
    return approvals.execute(input.approvalId, demoRequest, async () => {
      try {
        const result = await this.postGraphql<unknown>(mutation.document, mutation.variables(input, jiraFields), token);
        const mutationData = objectRecord(result);
        const createResult = objectRecord(mutationData?.createTest);
        const createdTest = objectRecord(createResult?.test);
        const issueId = createdTest?.issueId;
        const createdKey = objectRecord(createdTest?.jira)?.key;
        if (typeof issueId !== 'string' || typeof createdKey !== 'string') return this.reconcileManualTest(input, token);
        const saved = await this.readTest(issueId, token);
        const match = matchesSavedTest(saved, input);
        if (!match || match.issueId !== issueId || match.key !== createdKey) {
          throw new XrayClientError('Xray created a Test, but read-back did not match the approved payload.');
        }
        return { status: 'created-and-verified', ...match, reconciled: false };
      } catch (error: unknown) {
        if (error instanceof ApprovalServiceError) throw error;
        try { return await this.reconcileManualTest(input, token); }
        catch {
          return { status: 'uncertain', message: 'Xray mutation outcome is uncertain and read-only reconciliation failed; do not retry automatically.', matchedCandidates: 0 };
        }
      }
    });
  }

  private async verifyManualCreateSchema(token: string): Promise<{
    testTypeArgument: string;
    stepsArgument: string;
    jiraArgument: string;
    getTestIssueIdArgument: string;
    getTestsArguments: Map<string, Record<string, unknown>>;
  }> {
    const typeRef = schemaTypeSelection(5);
    const query = `query VerifyManualTestCreateSchema {
      mutation: __type(name: "Mutation") { fields { name args { name type { ${typeRef} } } type { ${typeRef} } } }
      query: __type(name: "Query") { fields { name args { name type { ${typeRef} } } type { ${typeRef} } } }
      test: __type(name: "Test") { fields { name args { name type { ${typeRef} } } type { ${typeRef} } } }
      createResult: __type(name: "CreateTestResult") { fields { name type { ${typeRef} } } }
      testTypeInput: __type(name: "UpdateTestTypeInput") { inputFields { name type { ${typeRef} } } }
      stepInput: __type(name: "CreateStepInput") { inputFields { name type { ${typeRef} } } }
    }`;
    const schema = objectRecord(await this.postGraphql<unknown>(query, {}, token));
    const mutation = schemaField(schema?.mutation, 'createTest');
    const mutationArgs = schemaArgs(mutation);
    const testTypeArg = mutationArgs.get('testType');
    const stepsArg = mutationArgs.get('steps');
    const jiraArg = mutationArgs.get('jira');
    const resultType = unwrapType(mutation?.type);
    const resultTest = schemaField(schema?.createResult, 'test');
    const testFields = schema?.test;
    const getTest = schemaField(schema?.query, 'getTest');
    const getTests = schemaField(schema?.query, 'getTests');
    const getTestArgs = schemaArgs(getTest);
    const issueIdArg = getTestArgs.get('issueId');
    const readJira = schemaField(testFields, 'jira');
    const stepsTypeName = unwrapType(schemaField(testFields, 'steps')?.type)?.name;
    const testTypeName = unwrapType(schemaField(testFields, 'testType')?.type)?.name;
    if (
      typeof stepsTypeName !== 'string' || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(stepsTypeName) ||
      typeof testTypeName !== 'string' || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(testTypeName)
    ) throw new XrayClientError('Live Xray Test step or type schema is unavailable.');
    const nestedQuery = `query VerifyManualTestOutputFields {
      steps: __type(name: "${stepsTypeName}") { fields { name type { ${typeRef} } } }
      testType: __type(name: "${testTypeName}") { fields { name type { ${typeRef} } } }
    }`;
    const nested = objectRecord(await this.postGraphql<unknown>(nestedQuery, {}, token));

    const invalid = !mutation || !testTypeArg || !stepsArg || !jiraArg ||
      formatType(testTypeArg.type).replace(/[![\]]/g, '') !== 'UpdateTestTypeInput' ||
      formatType(stepsArg.type).replace(/[![\]]/g, '') !== 'CreateStepInput' ||
      formatType(jiraArg.type).replace(/[![\]]/g, '') !== 'JSON' ||
      resultType?.name !== 'CreateTestResult' || unwrapType(resultTest?.type)?.name !== 'Test' ||
      !schemaField(testFields, 'issueId') || !schemaField(testFields, 'testType') ||
      !schemaField(testFields, 'steps') || !readJira || !schemaArgs(readJira).has('fields') ||
      !['action', 'data', 'result'].every((name) => schemaField(nested?.steps, name)) ||
      !schemaField(nested?.testType, 'name') ||
      !issueIdArg || !getTests || !['action', 'data', 'result'].every((name) => inputField(schema?.stepInput, name)) ||
      !inputField(schema?.testTypeInput, 'name') || !['jql', 'limit'].every((name) => schemaArgs(getTests).has(name));
    if (invalid) throw new XrayClientError('Live Xray schema does not match the verified Manual Test creation contract.');

    return {
      testTypeArgument: formatType(testTypeArg.type),
      stepsArgument: formatType(stepsArg.type),
      jiraArgument: formatType(jiraArg.type),
      getTestIssueIdArgument: formatType(issueIdArg.type),
      getTestsArguments: schemaArgs(getTests),
    };
  }

  private createMutationDocument(schema: {
    testTypeArgument: string; stepsArgument: string; jiraArgument: string;
  }): { document: string; variables(input: ManualTestPublicationInput, fields: Record<string, unknown>): Record<string, unknown> } {
    return {
      document: `mutation CreateApprovedManualTest($testType: ${schema.testTypeArgument}, $steps: ${schema.stepsArgument}, $jira: ${schema.jiraArgument}) {
        createTest(testType: $testType, steps: $steps, jira: $jira) {
          test { issueId testType { name } steps { action data result } jira(fields: ["key", "summary", "project"]) }
        }
      }`,
      variables: (input, fields) => ({ testType: { name: 'Manual' }, steps: input.steps, jira: { fields } }),
    };
  }

  private async readTest(issueId: string, token: string): Promise<unknown> {
    const query = `query ReadCreatedManualTest($issueId: String, $fields: [String]) {
      getTest(issueId: $issueId) {
        issueId testType { name } steps { action data result }
        jira(fields: $fields)
      }
    }`;
    const response = objectRecord(await this.postGraphql<unknown>(query, {
      issueId, fields: ['key', 'summary', 'project'],
    }, token));
    return objectRecord(response?.getTest);
  }

  private async reconcileManualTest(
    input: ManualTestPublicationInput,
    token: string,
  ): Promise<ManualTestPublicationResult> {
    const escaped = input.summary.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const response = objectRecord(await this.postGraphql<unknown>(`query ReconcileManualTest($jql: String!, $limit: Int!, $start: Int) {
      getTests(jql: $jql, limit: $limit, start: $start) {
        results { issueId testType { name } jira(fields: ["key", "summary", "project"]) }
      }
    }`, { jql: `project = ${input.projectKey} AND summary ~ "${escaped}"`, limit: 100, start: 0 }, token));
    const results = objectRecord(response?.getTests)?.results;
    if (!Array.isArray(results)) throw new XrayMutationUncertainError('Creation outcome is uncertain and Xray reconciliation was unavailable.');
    const exact: Array<{ issueId: string; key: string }> = [];
    for (const item of results) {
      const candidateId = objectRecord(item)?.issueId;
      if (typeof candidateId !== 'string') continue;
      const saved = await this.readTest(candidateId, token);
      const match = matchesSavedTest(saved, input);
      if (match) exact.push(match);
    }
    return {
      status: 'uncertain',
      message: exact.length === 0
        ? 'No exact matching Test could be verified; do not retry automatically.'
        : 'Matching Test content was found, but the mutation outcome cannot be attributed safely; do not retry automatically.',
      matchedCandidates: exact.length,
    };
  }

  private async postGraphql<TData>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
  ): Promise<TData> {
    let response: Response;
    try {
      response = await fetch(this.options.graphqlUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new XrayClientError('Unable to reach the Xray Cloud GraphQL endpoint.');
    }

    if (response.status === 401) {
      this.clearAccessToken();
    }
    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      const details = graphQLErrorMessages(parseJson(responseBody))
        .map((message) => this.sanitizeRemoteMessage(message))
        .filter(Boolean);
      const detailText = details.length > 0 ? `: ${details.join('; ')}` : '';
      throw new XrayClientError(
        `Xray Cloud GraphQL request failed (HTTP ${response.status})${detailText}.`,
      );
    }

    let payload: unknown;
    try {
      payload = parseJson(await response.text());
      if (payload === undefined) {
        throw new Error('Invalid JSON response.');
      }
    } catch {
      throw new XrayClientError('Xray Cloud GraphQL returned an invalid JSON response.');
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new XrayClientError('Xray Cloud GraphQL returned an invalid response.');
    }

    const graphQLErrors = graphQLErrorMessages(payload);
    if (graphQLErrors.length > 0) {
      const details = graphQLErrors
        .map((message) => this.sanitizeRemoteMessage(message))
        .filter(Boolean);
      const detailText = details.length > 0 ? `: ${details.join('; ')}` : '';
      throw new XrayClientError(`Xray Cloud GraphQL returned errors${detailText}.`);
    }

    if (!('data' in payload) || payload.data === null || payload.data === undefined) {
      throw new XrayClientError('Xray Cloud GraphQL response did not contain data.');
    }

    return payload.data as TData;
  }

  private sanitizeRemoteMessage(message: string): string {
    const secretValues = [
      this.options.clientId,
      this.options.clientSecret,
      this.accessToken,
    ]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.length - left.length);

    let sanitized = message;
    for (const secret of secretValues) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }

    return sanitized
      .replace(/\bauthorization\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, 'authorization=[REDACTED]')
      .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(client[_-]?(?:id|secret)|access[_-]?token|password|api[_-]?key)\b\s*[:=]\s*["']?[^"'\s,;}&]+["']?/gi, '$1=[REDACTED]')
      .slice(0, 500);
  }

  private async getAccessToken(): Promise<string> {
    if (
      this.accessToken &&
      this.accessTokenExpiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.accessToken;
    }

    if (!this.authenticationInProgress) {
      this.authenticationInProgress = this.authenticate().finally(() => {
        this.authenticationInProgress = undefined;
      });
    }

    return this.authenticationInProgress;
  }

  private async authenticate(): Promise<string> {
    const authenticationUrl = new URL('/api/v2/authenticate', this.options.baseUrl);
    let response: Response;
    try {
      response = await fetch(authenticationUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
      });
    } catch {
      throw new XrayClientError('Unable to reach the Xray Cloud authentication endpoint.');
    }

    if (!response.ok) {
      throw new XrayClientError(`Xray Cloud authentication failed (HTTP ${response.status}).`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new XrayClientError('Xray Cloud authentication returned an invalid response.');
    }

    if (typeof payload !== 'string' || payload.length === 0) {
      throw new XrayClientError('Xray Cloud authentication did not return a bearer token.');
    }

    this.accessToken = payload;
    this.accessTokenExpiresAt = tokenExpiryMs(payload);
    return payload;
  }

  private clearAccessToken(): void {
    this.accessToken = undefined;
    this.accessTokenExpiresAt = 0;
  }
}
