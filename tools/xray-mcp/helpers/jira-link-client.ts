import type { LocalDemoApprovalRequest, LocalDemoApprovalService } from '../agents/local-demo-approval.js';
import { digestOperationPayload } from '../agents/approval-canonicalization.js';

export interface JiraLinkEnvironment {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
}
export class JiraIssueLinkError extends Error {
  constructor(message: string) { super(message); this.name = 'JiraIssueLinkError'; }
}
export interface JiraLinkPreview {
  readonly storyKey: string;
  readonly testKey: string;
  readonly projectKey: string;
  readonly payload: Record<string, unknown>;
  readonly alreadyLinked: boolean;
}
export type JiraLinkResult =
  | { readonly status: 'linked'; readonly storyKey: string; readonly testKey: string; readonly linkId: string; readonly reconciled: boolean }
  | { readonly status: 'already-linked'; readonly storyKey: string; readonly testKey: string; readonly linkId: string }
  | { readonly status: 'uncertain'; readonly storyKey: string; readonly testKey: string; readonly message: string };

interface JiraIssue { id: string; key: string; fields: Record<string, unknown> }
interface LinkType { id: string; name: string; inward: string; outward: string }
interface LinkDetails { id: string; type: LinkType; inwardIssue: { key: string }; outwardIssue: { key: string } }

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class JiraIssueLinkClient {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(private readonly config: JiraLinkEnvironment, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' || !config.email.trim() || !config.apiToken.trim()) {
      throw new JiraIssueLinkError('Jira issue-link configuration is invalid; HTTPS and configured credentials are required.');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.authorization = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): JiraIssueLinkClient {
    const baseUrl = env.JIRA_BASE_URL?.trim();
    const email = env.JIRA_EMAIL?.trim();
    const apiToken = env.JIRA_API_TOKEN?.trim();
    if (!baseUrl || !email || !apiToken) throw new JiraIssueLinkError('Jira issue-link adapter is unavailable; configure JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN locally.');
    return new JiraIssueLinkClient({ baseUrl, email, apiToken });
  }

  async prepareStory(storyKey: string): Promise<{ projectKey: string; type: LinkType }> {
    const story = await this.getIssue(storyKey);
    if (object(story.fields.issuetype)?.name !== 'Story') throw new JiraIssueLinkError('Target must be a Story.');
    const projectKey = String(object(story.fields.project)?.key ?? '');
    const permissions = object(await (await this.request('/rest/api/3/mypermissions?projectKey=' + encodeURIComponent(projectKey) + '&permissions=LINK_ISSUES')).json());
    if (object(object(permissions?.permissions)?.LINK_ISSUES)?.havePermission !== true) throw new JiraIssueLinkError('Link permission unavailable.');
    const types = (await this.getLinkTypes()).filter(t => t.name === 'Test' && t.inward.toLowerCase() === 'is tested by' && t.outward.toLowerCase() === 'tests');
    if (!projectKey || types.length !== 1) throw new JiraIssueLinkError('Link metadata unavailable or ambiguous.');
    return { projectKey, type: types[0]! };
  }

  /** Relevant source fields only: our own link writes must not invalidate source content. */
  async storyEvidence(storyKey: string): Promise<{ issueId: string; contentDigest: string; text: string }> {
    const issue = await this.getIssue(storyKey);
    const { summary, description, project, issuetype } = issue.fields;
    const flatten = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.map(flatten).join(' ');
      const node = object(value);
      return node ? [typeof node.text === 'string' ? node.text : '', flatten(node.content)].join(' ') : '';
    };
    return { issueId: issue.id, contentDigest: digestOperationPayload({ key: issue.key, summary, description: description ?? null,
      project, issuetype }), text: flatten(description) };
  }

  async verifyTestIssue(key: string, issueId: string): Promise<void> {
    const issue = await this.getIssue(key);
    if (issue.id !== issueId || issue.key !== key || object(issue.fields.issuetype)?.name !== 'Test') {
      throw new JiraIssueLinkError('Existing Test identity or Jira issue type changed.');
    }
  }

  async testIdentity(key: string): Promise<{ issueId: string; projectKey: string }> {
    const issue = await this.getIssue(key);
    if (issue.key !== key || object(issue.fields.issuetype)?.name !== 'Test') throw new JiraIssueLinkError('Target is not the requested Jira Test.');
    return { issueId: issue.id, projectKey: String(object(issue.fields.project)?.key ?? '') };
  }

  async prepare(storyKey: string, testKey: string, xray: { graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> }): Promise<JiraLinkPreview> {
    const [story, test] = await Promise.all([this.getIssue(storyKey), this.getIssue(testKey)]);
    const storyType = object(story.fields.issuetype)?.name;
    if (storyType !== 'Story') throw new JiraIssueLinkError(`${storyKey} is not a Jira Story.`);
    const projectKey = String(object(story.fields.project)?.key ?? '');
    if (!projectKey) throw new JiraIssueLinkError('The Story project could not be determined.');
    if (String(object(test.fields.project)?.key ?? '') !== projectKey) {
      throw new JiraIssueLinkError('Story and Xray Test must be in the same Jira project for this local adapter.');
    }
    const permissions = object(await (await this.request(`/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}&permissions=LINK_ISSUES`)).json());
    const linkPermission = object(object(permissions?.permissions)?.LINK_ISSUES)?.havePermission;
    if (linkPermission !== true) throw new JiraIssueLinkError('The configured Jira account does not have confirmed Link issues permission.');
    const issueId = test.id;
    const xrayResult = object(await xray.graphqlRequest<unknown>(`query VerifyManualTestForLink($issueId: String) {
      getTest(issueId: $issueId) { issueId testType { name } jira(fields: ["key"]) }
    }`, { issueId }));
    const xrayTest = object(xrayResult?.getTest);
    const jira = object(xrayTest?.jira);
    if (xrayTest?.issueId !== issueId || object(xrayTest?.testType)?.name !== 'Manual' || jira?.key !== testKey) {
      throw new JiraIssueLinkError(`${testKey} could not be verified as an Xray Manual Test.`);
    }
    const linkTypes = await this.getLinkTypes();
    const matches = linkTypes.filter((type) => type.name === 'Test');
    if (matches.length !== 1) throw new JiraIssueLinkError('Jira must expose exactly one Test issue-link type.');
    const type = matches[0]!;
    if (type.inward.toLocaleLowerCase() !== 'is tested by' || type.outward.toLocaleLowerCase() !== 'tests') {
      throw new JiraIssueLinkError('Runtime Test link metadata does not match Story link metadata; stopped before writing.');
    }
    const payload = {
      operation: 'jira.issueLink',
      inwardIssue: { key: testKey },
      outwardIssue: { key: storyKey },
      type: { id: type.id, name: type.name },
      discoveredLinkMetadata: {
        id: type.id, name: type.name, inward: type.inward, outward: type.outward,
        inwardIssueKey: testKey, outwardIssueKey: storyKey,
      },
    };
    const alreadyLinked = (await this.linksForIssue(storyKey)).some((link) =>
      link.type.id === type.id && link.inwardIssue.key === testKey && link.outwardIssue.key === storyKey);
    return { storyKey, testKey, projectKey, payload, alreadyLinked };
  }

  async createApproved(preview: JiraLinkPreview, approvalId: string, workflowId: string,
    correlationId: string, approvals: Pick<LocalDemoApprovalService, 'execute'>): Promise<JiraLinkResult> {
    if (preview.alreadyLinked) {
      const existing = (await this.linksForIssue(preview.storyKey)).find((link) =>
        link.type.id === String(object(preview.payload.type)?.id) && link.inwardIssue.key === preview.testKey && link.outwardIssue.key === preview.storyKey);
      return { status: 'already-linked', storyKey: preview.storyKey, testKey: preview.testKey, linkId: existing?.id ?? 'unknown' };
    }
    const request: LocalDemoApprovalRequest = {
      action: 'jira.issue.link', projectKey: preview.projectKey, workflowId, correlationId,
      operationPayload: preview.payload as LocalDemoApprovalRequest['operationPayload'],
    };
    return approvals.execute(approvalId, request, async () => {
      try {
        const response = await this.request('/rest/api/3/issueLink', {
          method: 'POST', body: JSON.stringify({ inwardIssue: { key: preview.testKey }, outwardIssue: { key: preview.storyKey }, type: { id: String(object(preview.payload.type)?.id) } }),
        });
        const body = object(await response.json().catch(() => ({})));
        const id = typeof body?.id === 'string' ? body.id : '';
        if (!id) return this.reconcile(preview);
        const saved = await this.getLink(id);
        if (saved.inwardIssue.key !== preview.testKey || saved.outwardIssue.key !== preview.storyKey || saved.type.id !== String(object(preview.payload.type)?.id)) {
          throw new JiraIssueLinkError('Jira returned a link that did not match the approved direction.');
        }
        return { status: 'linked', storyKey: preview.storyKey, testKey: preview.testKey, linkId: id, reconciled: false };
      } catch {
        return this.reconcile(preview);
      }
    });
  }

  private async reconcile(preview: JiraLinkPreview): Promise<JiraLinkResult> {
    try {
      const links = await this.linksForIssue(preview.storyKey);
      const match = links.find((link) => link.type.id === String(object(preview.payload.type)?.id) &&
        link.inwardIssue.key === preview.testKey && link.outwardIssue.key === preview.storyKey);
      if (match) return { status: 'linked', storyKey: preview.storyKey, testKey: preview.testKey, linkId: match.id, reconciled: true };
    } catch { /* a read failure leaves the mutation outcome uncertain */ }
    return { status: 'uncertain', storyKey: preview.storyKey, testKey: preview.testKey,
      message: 'Link outcome is uncertain; read-only reconciliation could not verify it. Do not retry automatically.' };
  }

  private async getIssue(key: string): Promise<JiraIssue> {
    if (!/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/.test(key)) throw new JiraIssueLinkError('Jira issue key is invalid.');
    const response = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=project,issuetype,issuelinks,summary,description`);
    const issue = object(await response.json());
    const fields = object(issue?.fields);
    if (typeof issue?.id !== 'string' || typeof issue.key !== 'string' || !fields) throw new JiraIssueLinkError(`Jira issue ${key} returned an invalid response.`);
    return { id: issue.id, key: issue.key, fields };
  }

  private async getLinkTypes(): Promise<LinkType[]> {
    const response = await this.request('/rest/api/3/issueLinkType');
    const types = object(await response.json())?.issueLinkTypes;
    if (!Array.isArray(types)) throw new JiraIssueLinkError('Jira did not return issue-link metadata.');
    return types.flatMap((value) => {
      const type = object(value);
      return typeof type?.id === 'string' && typeof type.name === 'string' && typeof type.inward === 'string' && typeof type.outward === 'string'
        ? [{ id: type.id, name: type.name, inward: type.inward, outward: type.outward }] : [];
    });
  }

  private async linksForIssue(key: string): Promise<LinkDetails[]> {
    const response = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=issuelinks`);
    const links = object(object(await response.json())?.fields)?.issuelinks;
    if (!Array.isArray(links)) throw new JiraIssueLinkError('Jira issue links were unavailable.');
    const ids = links.flatMap((item) => typeof object(item)?.id === 'string' ? [String(object(item)?.id)] : []);
    const details = await Promise.all(ids.map((id) => this.getLink(id)));
    return details;
  }

  private async getLink(id: string): Promise<LinkDetails> {
    const link = object(await (await this.request(`/rest/api/3/issueLink/${encodeURIComponent(id)}`)).json());
    const type = object(link?.type); const inward = object(link?.inwardIssue); const outward = object(link?.outwardIssue);
    if (typeof link?.id !== 'string' || typeof type?.id !== 'string' || typeof type.name !== 'string' ||
        typeof type.inward !== 'string' || typeof type.outward !== 'string' || typeof inward?.key !== 'string' || typeof outward?.key !== 'string') {
      throw new JiraIssueLinkError('Jira issue-link read-back was incomplete.');
    }
    return { id: link.id, type: { id: type.id, name: type.name, inward: type.inward, outward: type.outward },
      inwardIssue: { key: inward.key }, outwardIssue: { key: outward.key } };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        headers: { authorization: this.authorization, accept: 'application/json', 'content-type': 'application/json', ...init.headers },
      });
    } catch { throw new JiraIssueLinkError('Jira request failed before a response was received.'); }
    if (!response.ok) throw new JiraIssueLinkError(`Jira request failed (HTTP ${response.status}).`);
    return response;
  }
}
