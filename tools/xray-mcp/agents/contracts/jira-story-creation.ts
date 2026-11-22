import { z } from 'zod';
import { canonicalizeJson } from '../approval-canonicalization.js';
import type { ApprovalScope } from './approval.js';

const text = z.string().min(1).max(20_000).refine(v => v.trim() === v);
// Deliberately narrow: unsupported field shapes fail closed instead of resolving names
// or silently changing a reviewed value in the remote MCP server.
export const jiraFieldValueSchema = z.union([
  text, z.number().finite(), z.boolean(), z.object({ id: text }).strict(), z.object({ accountId: text }).strict(),
  z.array(text), z.array(z.object({ id: text }).strict()),
]);
export const jiraStoryPayloadSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  operation: z.literal('jira.createStory'),
  site: z.object({
    cloudId: z.uuid(),
    url: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    }, 'Use an exact HTTPS site origin without a trailing slash.'),
  }).strict(),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/),
  issueType: z.object({ id: z.string().regex(/^[1-9]\d*$/), name: z.literal('Story') }).strict(),
  summary: text.refine(v => v.length <= 255 && !/[\r\n]/.test(v)),
  description: text,
  acceptanceCriteria: z.array(text.refine(v => !/[\r\n]/.test(v))).min(1).max(100),
  contentFormat: z.literal('markdown'),
  labels: z.array(z.string().regex(/^[\p{L}\p{N}_-]+$/u)).max(100),
  additionalFields: z.record(z.string().regex(/^(customfield_[1-9]\d*|reporter)$/), jiraFieldValueSchema),
}).strict().superRefine((payload, context) => {
  const suffix = '\n\nAcceptance criteria\n' + payload.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n');
  if (!/^As a .+, I want .+, so that .+\./.test(payload.description) || !payload.description.endsWith(suffix)) {
    context.addIssue({ code: 'custom', message: 'Description must contain the user story and exact numbered acceptance criteria suffix.' });
  }
  if (new Set(payload.acceptanceCriteria).size !== payload.acceptanceCriteria.length) {
    context.addIssue({ code: 'custom', message: 'Acceptance criteria must be distinct.' });
  }
});
export type JiraStoryPayload = z.infer<typeof jiraStoryPayloadSchema>;

export function parseJiraStoryPayload(value: unknown): JiraStoryPayload {
  // Reject accessors, undefined and non-JSON inputs before schema parsing.
  canonicalizeJson(value);
  return jiraStoryPayloadSchema.parse(value);
}

export function jiraStoryScope(payload: JiraStoryPayload): ApprovalScope {
  return {
    projectKey: payload.projectKey, environmentId: payload.site.url,
    jiraIssueKeys: [], testCaseIds: [],
    targetResourceIds: [
      `atlassian-site:${payload.site.cloudId}`, `jira-project:${payload.projectKey}`,
      `jira-issue-type:${payload.issueType.id}`,
    ],
  };
}

/** These exact arguments are displayed at review and sent by the trusted adapter. */
export function jiraStoryCreateArguments(payload: JiraStoryPayload) {
  return {
    cloudId: payload.site.cloudId, projectKey: payload.projectKey, issueType: payload.issueType.name,
    summary: payload.summary, description: payload.description, contentFormat: payload.contentFormat,
    labels: payload.labels, additional_fields: payload.additionalFields,
  };
}
