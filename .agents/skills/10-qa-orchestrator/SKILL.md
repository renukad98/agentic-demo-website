---
name: qa-orchestrator
description: Coordinate approved feature delivery through requirements, implementation, QA evidence and separate publication gates.
---

# QA Orchestrator

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), [framework](../../../docs/agent-framework/README.md), and [approval policy](../../../docs/agent-framework/approval-policy.md) before acting. Current Phase 5D authorizes local framework implementation and isolated validation only; remote writes remain disabled. Discover available tool schemas; skill invocation grants no external permission.

## Responsibilities

Read AGENTS.md and shared framework documents. Follow Jira Story → Requirements Analysis → Test Design → reviewed design and implementation approval → Feature Development with unit/API tests → Playwright Automation → Test Review → Test Execution. At each handoff record input/output paths, revisions, owner, status and blockers in the run report. Ensure development delivers both code and associated automated tests. Send review findings to the responsible role and rerun affected checks after changes. Before proposing Xray or GitHub writes, verify every local completion gate, including persisted Playwright tests and actual execution. Then gate Xray Publication → GitHub Pull Request → Jira Status Update separately. If spawning is unavailable or not authorized, enact roles sequentially without claiming independent review.

## Inputs

Approved scope, source story, prior run state and capability inventory.

## Outputs

Stage ledger, owner handoffs, complete traceability, local readiness decision and reviewable external proposals. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

All relevant read-only MCP connectors and local quality commands; no required multi-agent runtime. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Analyze and coordinate local artifacts within approved scope; Phase 5D permits approved local framework work only.

## Actions requiring human approval

Every external stage and destructive operation follows the shared approval policy. Do not treat orchestration as delegated write authorization.

## Validation requirements

Require resolved acceptance criteria, implemented tests, accepted review, current execution evidence, full traceability and regression results. Do not mark the workflow complete if external stages remain pending.

## Error handling

Stop dependent stages when requirements, capabilities, approval or tests are blocked. Keep completed local evidence and identify the next owner; never skip a gate silently. Preserve sanitized evidence; never expose credentials in diagnostics.

## Reusable Phase 5D contract

Use tools/agentic contracts and story-specific artifacts/qa/<story-key>/<run-id>/ evidence. Roles run sequentially unless delegation is explicitly authorized; label same-session reviews as self-review. Read docs/agent-framework/phase5d-framework.md for state gates, stable identities and recovery. Feature Development owns unit/API tests; Playwright Automation owns browser tests; Test Design precedes implementation and reviews coverage afterward. Historical Phase 2B descriptions below do not grant current permission. Mode selection and editable approval JSON grant no authorization. Generic Test proposals use the repository-local identity registry; live Xray publication and GitHub delivery remain disabled.
