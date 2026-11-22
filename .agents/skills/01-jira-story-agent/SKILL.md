---
name: jira-story-agent
description: Read Jira Stories and handle separately approved Story creation and status transitions.
---

# Jira Story Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

For Test or Test Plan status handoffs from Agent 09, use `tools/agentic/chat-xray-lifecycle.ts`. Present one exact issue transition preview at a time. After the owner's `OK`, refresh all reads, recheck the same preview, dispatch only its arguments through Jira MCP, and record an issue identity and status readback. Stop on uncertain dispatch and reconcile by read before proposing another write. Story creation and transitions continue to use `chat-jira.ts`.

Read the requested story and relevant linked requirements with bounded pagination. Separate source facts from inferred requirements. Preserve acceptance criterion identifiers; include source revision or a sanitized content fingerprint. For `qa story`, use an existing key for read-only intake or prepare the exact Story creation preview under the approval policy. After the owner's `OK`, create once, read back the assigned key and fields, and initialize `qa/<STORY-KEY>/feature.json` and the active pointer for the verified Story. Preview In Progress when approved implementation is ready to begin and Done when the orchestrator verifies completion. Read current status and valid transitions before each preview, dispatch only after a fresh `OK`, and verify the resulting status.

## Chat command helper

Run `node --import tsx tools/agentic/chat-jira.ts preview "<exact command>"` with a JSON packet on stdin containing `context`. Use the verified Jira tenant HTTPS origin as `context.cloudId`. For creation, pass `context.draft` with `summary`, `description`, and an array of `acceptanceCriteria`. Intake uses the returned key only for Jira reads and leaves the QA files untouched.

For transitions, normalize the Jira issue to `context.story` with `key`, `id`, `projectKey`, `issueType`, `summary`, and `status`. Supply available transitions as `context.transitions` entries with `id`, `name`, and destination status name `to`. The orchestrator applies the implementation or closeout evidence gates before requesting approval.

Show the exact tool arguments and proposed local changes. Wait for the owner's actual chat `OK`. Then refresh the Jira reads and run the helper's `check` action with the same command and packet fields `context`, `preview` (the full original helper result), and `reply` (the owner's actual reply). Dispatch exactly the checked tool arguments via Atlassian MCP. A null transition ID means Jira already has the target status. In that case skip the transition call and disclose any proposed local recording in the preview.

After dispatch, read the issue by its key, verify the response, and call `record` with the checked pre-dispatch packet plus `readback` in the same normalized issue shape. For creation include the verified Markdown `description` and pass `createdIdentity` with the exact `id` and `key` returned by the create call. If anything fails after a possible write, stop and report the known key or ID. Reconcile via Jira reads and use the original approved packet to recover local recording when it still matches. Avoid resubmitting the create operation.

## Inputs

Explicit story/project key and authorized Jira connector context.

## Outputs

Sanitized source snapshot with retrieval time, source revision, acceptance criteria, links and missing-field notes; later, exact proposed status payload. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Use Atlassian Jira MCP `getJiraIssue` and configured read tools for intake and verification. Discover the transition metadata read operation and verify `createJiraIssue` or `transitionJiraIssue` is available before offering approval. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Read authorized stories and create local snapshots or proposals.

## Actions requiring human approval

Story creation and each In Progress or Done transition require the owner's explicit `OK` on the latest exact preview. Keep paused Stories out of delivery.

## Validation requirements

Check project/key, snapshot freshness and acceptance-field completeness. Re-fetch or disclose stale source before later implementation/publication.

## Error handling

On missing fields or access failure, report exact missing scope without inventing requirements. Stop mutation on ambiguous responses and read back state before any retry. Preserve sanitized evidence; never expose credentials in diagnostics.
