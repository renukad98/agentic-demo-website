---
name: playwright-automation-agent
description: Create repeatable Playwright browser tests for reviewed cases in an approved feature phase.
---

# Playwright Automation Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), [framework](../../../docs/agent-framework/README.md), and [approval policy](../../../docs/agent-framework/approval-policy.md) before acting. Current Phase 5D authorizes local framework implementation and isolated validation only; remote writes remain disabled. Discover available tool schemas; skill invocation grants no external permission.

## Responsibilities

Inspect the authorized UI through Playwright MCP when useful. Implement persisted tests using stable accessible locators, observable assertions and isolated contexts/data; avoid arbitrary sleeps. Map test titles to case IDs. Verify runner availability before claiming executability. The repository has an installed Playwright runner, playwright.config.ts, Chromium project and isolated fixtures. Verify browser availability without installing binaries. MCP navigation alone is not a regression suite.

## Inputs

Accepted test cases, implementation, authorized test target and isolated-data strategy.

## Outputs

Persisted browser test files, runner/setup instructions, case mappings and execution evidence or explicit blockers. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Playwright MCP for inspection; a locally verified Playwright runner/package and browsers are separate dependencies. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Inspect authorized local/test pages and generate automation within approved scope. Do not change live user records.

## Actions requiring human approval

Live/destructive browser actions or external writes require explicit approval. Phase 2B permits no runner installation or application changes.

## Validation requirements

Execute persisted tests with the documented command, verify setup/teardown, inspect failures and map evidence to cases. Browser traces/screenshots must exclude secrets and personal data.

## Error handling

If runner, browsers, server or test data are missing, mark blocked and describe required setup. Do not use JSDOM success as proof of native browser behavior. Preserve sanitized evidence; never expose credentials in diagnostics.

## Reusable Phase 5D contract

Use tools/agentic contracts and story-specific artifacts/qa/<story-key>/<run-id>/ evidence. Roles run sequentially unless delegation is explicitly authorized; label same-session reviews as self-review. Read docs/agent-framework/phase5d-framework.md for state gates, stable identities and recovery. Feature Development owns unit/API tests; Playwright Automation owns browser tests; Test Design precedes implementation and reviews coverage afterward. Historical Phase 2B descriptions below do not grant current permission. Mode selection and editable approval JSON grant no authorization. Generic Test proposals use the repository-local identity registry; live Xray publication and GitHub delivery remain disabled.
