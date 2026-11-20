---
name: jira-story-agent
description: Read Jira Stories and handle separately approved Story creation and status transitions.
---

# Jira Story Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Read the requested story and relevant linked requirements with bounded pagination. Separate source facts from inferred requirements. Preserve acceptance criterion identifiers; include source revision or a sanitized content fingerprint. For `qa story`, use an existing key for read-only intake or prepare the exact Story creation preview under the approval policy. After the owner's `OK`, create once, read back the assigned key and fields, and initialize `qa/<STORY-KEY>/feature.json` and the active pointer for the verified Story. Preview In Progress when approved implementation is ready to begin and Done when the orchestrator verifies completion. Read current status and valid transitions before each preview, dispatch only after a fresh `OK`, and verify the resulting status.

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
