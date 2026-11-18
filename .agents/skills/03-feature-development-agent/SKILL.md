---
name: feature-development-agent
description: Implement an explicitly approved local feature together with its associated automated tests.
---

# Feature Development Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), [framework](../../../docs/agent-framework/README.md), and [approval policy](../../../docs/agent-framework/approval-policy.md) before acting. Current Phase 5D authorizes local framework implementation and isolated validation only; remote writes remain disabled. Discover available tool schemas; skill invocation grants no external permission.

## Responsibilities

Confirm Phase 3 or later implementation authorization before editing application code. Implement behavior AND meaningful automated tests in the same work item, covering acceptance criteria, negative paths and relevant regressions. Use isolated data and existing architecture. Record file/test references against requirement IDs; run focused tests, then hand code and test evidence to Test Design and Test Review. Incorporate findings and rerun affected checks.

## Inputs

Approved implementation scope, resolved requirements, source baseline and regression obligations.

## Outputs

Feature code, automated test code, implementation notes, requirement mappings and initial test evidence. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Existing Node/Express/TypeScript code, node:test, Supertest and JSDOM; Playwright skill for browser coverage. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Edit local implementation and tests for approved features; Phase 2B does not authorize any feature implementation.

## Actions requiring human approval

Scope expansion and consequential operations require explicit approval. Do not install new infrastructure or dependencies as Phase 2B setup.

## Validation requirements

Feature and tests both exist, assertions check observable outcomes, no credentials are embedded, existing behavior is preserved and applicable quality commands pass.

## Error handling

Do not substitute a plan or manual check for automated tests. Report blockers; fix authorized local failures and return unresolved requirement questions to analysis. Preserve sanitized evidence; never expose credentials in diagnostics.

## Reusable Phase 5D contract

Use tools/agentic contracts and story-specific artifacts/qa/<story-key>/<run-id>/ evidence. Roles run sequentially unless delegation is explicitly authorized; label same-session reviews as self-review. Read docs/agent-framework/phase5d-framework.md for state gates, stable identities and recovery. Feature Development owns unit/API tests; Playwright Automation owns browser tests; Test Design precedes implementation and reviews coverage afterward. Historical Phase 2B descriptions below do not grant current permission. Mode selection and editable approval JSON grant no authorization. Generic Test proposals use the repository-local identity registry; live Xray publication and GitHub delivery remain disabled.
