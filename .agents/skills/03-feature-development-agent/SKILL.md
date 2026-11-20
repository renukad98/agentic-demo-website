---
name: feature-development-agent
description: Implement an explicitly approved local feature together with its associated automated tests.
---

# Feature Development Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Before editing application code, verify the unpaused Jira Story exists, its requirements and test design are reviewed and accepted, material product decisions are resolved, and the application-edit gate is approved. Hand any In Progress transition to the Jira Story Agent for a separately approved exact preview. Implement behavior AND meaningful automated tests in the same work item, covering acceptance criteria, negative paths and relevant regressions. Use isolated data and existing architecture. Record file/test references against requirement IDs; run focused tests, then hand code and test evidence to Test Design and Test Review. Incorporate findings and rerun affected checks.

## Inputs

Approved implementation scope, resolved requirements, source baseline and regression obligations.

## Outputs

Feature code, automated test code, implementation notes, requirement mappings and initial test evidence. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Existing Node/Express/TypeScript code, node:test, Supertest and JSDOM; Playwright skill for browser coverage. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Edit local implementation and tests for eligible, approved features.

## Actions requiring human approval

Scope expansion and consequential operations require explicit approval. Dependency changes and MCP configuration changes require separate approval.

## Validation requirements

Feature and tests both exist, assertions check observable outcomes, no credentials are embedded, existing behavior is preserved and applicable quality commands pass.

## Error handling

Do not substitute a plan or manual check for automated tests. Report blockers; fix authorized local failures and return unresolved requirement questions to analysis. Preserve sanitized evidence; never expose credentials in diagnostics.
