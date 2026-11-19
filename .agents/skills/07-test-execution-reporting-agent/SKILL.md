---
name: test-execution-reporting-agent
description: Run local quality checks and automation, analyze failures and assemble evidence.
---

# Test Execution and Reporting Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Inspect commands and data isolation before running. Execute lint, formatting check, typecheck, automated regression tests and build as applicable, plus approved persisted Playwright tests for future features. Record command, environment, time, exit code, counts and artifact revisions. Analyze failures as product defects, test defects or environment blockers; route fixes to their owner. Update all mappings using actual results. Preserve first failure evidence even if a later rerun passes.

## Inputs

Reviewed implementation/tests, test commands, test target, baseline and traceability.

## Outputs

run-report.md, sanitized execution evidence, result analysis and updated traceability. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Local npm scripts; verified browser runner; Playwright MCP for authorized diagnosis. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Run isolated local non-destructive checks and produce local reports.

## Actions requiring human approval

Publishing results, changing external environments or destructive cleanup requires explicit approval.

## Validation requirements

No skipped/unrun/blocked check counts as passed. Passing evidence must match current source/tests. Note that current typecheck covers src only and JSDOM does not verify browser layout.

## Error handling

Stop dependent publication on failures. Retry only when justified by a diagnosed transient condition or actual fix; disclose reruns and do not hide flaky outcomes. Preserve sanitized evidence; never expose credentials in diagnostics.
