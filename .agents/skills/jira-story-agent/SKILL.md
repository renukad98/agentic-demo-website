---
name: jira-story-agent
description: Retrieve Jira stories and acceptance criteria read-only, and prepare eventual status update proposals.
---

# Jira Story Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), [framework](../../../docs/agent-framework/README.md), and [approval policy](../../../docs/agent-framework/approval-policy.md) before acting. Current Phase 5D authorizes local framework implementation and isolated validation only; remote writes remain disabled. Discover available tool schemas; skill invocation grants no external permission.

## Responsibilities

Read the requested story and relevant linked requirements with bounded pagination. Separate source facts from inferred requirements. Preserve acceptance criterion identifiers; include source revision or a sanitized content fingerprint. At the final workflow stage, prepare a status change only after the orchestrator's QA and preceding external-stage evidence exists. Inspect valid transitions instead of inventing IDs.

## Inputs

Explicit story/project key and authorized Jira connector context.

## Outputs

Sanitized source snapshot with retrieval time, source revision, acceptance criteria, links and missing-field notes; later, exact proposed status payload. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Atlassian Jira MCP atlassian-2 read tools; discover available get/search and workflow metadata schemas. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Read authorized stories and create local snapshots or proposals.

## Actions requiring human approval

Any Jira creation, update, comment, link or transition requires explicit scoped approval and is forbidden in Phase 2B.

## Validation requirements

Check project/key, snapshot freshness and acceptance-field completeness. Re-fetch or disclose stale source before later implementation/publication.

## Error handling

On missing fields or access failure, report exact missing scope without inventing requirements. Stop mutation on ambiguous responses and read back state before any retry. Preserve sanitized evidence; never expose credentials in diagnostics.

## Reusable Phase 5D contract

Use tools/agentic contracts and story-specific artifacts/qa/<story-key>/<run-id>/ evidence. Roles run sequentially unless delegation is explicitly authorized; label same-session reviews as self-review. Read docs/agent-framework/phase5d-framework.md for state gates, stable identities and recovery. Feature Development owns unit/API tests; Playwright Automation owns browser tests; Test Design precedes implementation and reviews coverage afterward. Historical Phase 2B descriptions below do not grant current permission. Mode selection and editable approval JSON grant no authorization. Generic Test proposals use the repository-local identity registry; live Xray publication and GitHub delivery remain disabled.
