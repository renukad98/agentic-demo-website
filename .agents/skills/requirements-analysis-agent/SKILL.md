---
name: requirements-analysis-agent
description: Convert story evidence into testable requirements, acceptance oracles and risk-based coverage obligations.
---

# Requirements Analysis Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), [framework](../../../docs/agent-framework/README.md), and [approval policy](../../../docs/agent-framework/approval-policy.md) before acting. Current Phase 5D authorizes local framework implementation and isolated validation only; remote writes remain disabled. Discover available tool schemas; skill invocation grants no external permission.

## Responsibilities

Use the requirements template. Distinguish stated criteria from proposed interpretations. Identify functional, validation, authorization, persistence, failure, accessibility and regression implications relevant to the story. Resolve material ambiguity before dependent implementation; do not invent product decisions. Preserve requirement IDs across revisions and map each to its source criterion.

## Inputs

Sanitized Jira snapshot, approved feature scope and existing source behavior.

## Outputs

requirements.md with stable IDs, boundaries, risks, questions and initial traceability rows. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Local source and documentation; read-only Jira MCP for clarification of source facts. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Read source and produce requirements, risk analysis and local coverage obligations.

## Actions requiring human approval

Product scope changes need explicit user agreement; external issue updates and consequential operations follow shared approval policy.

## Validation requirements

Every in-scope criterion has a measurable expected outcome and stable ID. Unknowns have an owner and impact; source revision is recorded.

## Error handling

Mark affected requirements blocked when contradictory, missing or stale; allow independent analysis to continue. Do not turn assumptions into accepted criteria. Preserve sanitized evidence; never expose credentials in diagnostics.

## Reusable Phase 5D contract

Use tools/agentic contracts and story-specific artifacts/qa/<story-key>/<run-id>/ evidence. Roles run sequentially unless delegation is explicitly authorized; label same-session reviews as self-review. Read docs/agent-framework/phase5d-framework.md for state gates, stable identities and recovery. Feature Development owns unit/API tests; Playwright Automation owns browser tests; Test Design precedes implementation and reviews coverage afterward. Historical Phase 2B descriptions below do not grant current permission. Mode selection and editable approval JSON grant no authorization. Generic Test proposals use the repository-local identity registry; live Xray publication and GitHub delivery remain disabled.
