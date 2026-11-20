---
name: qa-orchestrator
description: Coordinate approved feature delivery through requirements, implementation, QA evidence and separate publication gates.
---

# QA Orchestrator

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Use the active feature record and existing command map for routine sequential handoffs, following the pause and approval rules in AGENTS.md. Follow Jira Story → Requirements Analysis → Test Design → reviewed design and implementation approval → Feature Development with unit/API tests → Playwright Automation → Test Review → Test Execution. At each handoff record input/output paths, revisions, owner, status and blockers in the run report. Ensure development delivers both code and associated automated tests. Send review findings to the responsible role and rerun affected checks after changes. Before proposing Xray or GitHub writes, verify every local completion gate, including persisted Playwright tests and actual execution. Then gate Xray Publication → GitHub Pull Request → Jira Status Update separately. If spawning is unavailable or not authorized, enact roles sequentially without claiming independent review.

## Inputs

When accepted design review is complete and Manual Test publication is pending, `qa next` recommends `qa xray` before the implementation handoff. Apply the pause policy first. Publication can complete independently of branch preparation, implementation, automation, and execution. Resolve subsequent work from the first pending stage, even if the latest recorded stage is `published`. Full local readiness still gates GitHub delivery and the separate batch routes.

For a separately authorized Phase 5E Windows demo, hand the active Story's reviewed batch to Agent 08. Require the signed session grant and one native approval, then record the execution ID, actual Test keys, verification status, and unverified operator identity. A stopped execution remains pending publication. Phase 5E local implementation approval does not activate the demo.

For a reviewed Manual Test batch, verify local readiness and record the reviewed plan reference as `evidence.reviewedBatchPlan` on the active feature. Agent 08 can resolve that reference through the mock-validated active-Story connector route. Once live scope and the connector are separately authorized, use its single native form for the exact create-and-link operations. Advance to `published` only after the connector reports `complete` and returns verified Test keys for the selected cases. Record the execution ID and case-to-Test mapping. Keep stopped or uncertain batches pending and hand them back to Agent 08 for read-only reconciliation. A feature record grants no live permission, and Phase 5D keeps this handoff local.

For `qa next`, read the active story and feature record before selecting a command. If the record is paused, stop and report how to explicitly resume it. Otherwise, check the pending stage, next command, prerequisite evidence, and existing command map. Skip completed work backed by current evidence. If the resolved next command is `qa run` or `qa xray-results` and the Story has no Test Plan key, suggest `qa test-plan <STORY-KEY>` as the prerequisite and stop at that recommendation. If the next operation is blocked by an unmet prerequisite, product decision, unavailable external dependency, phase restriction, or approval gate, report it without dispatching or advancing the record. When eligible, apply the mapped skill for exactly one step and record completion only after verification. End with the shared **What's next?** block. Keep `qa status` and `qa summary` read-only.

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
