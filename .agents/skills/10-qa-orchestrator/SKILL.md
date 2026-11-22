---
name: qa-orchestrator
description: Coordinate approved feature delivery through requirements, implementation, QA evidence and separate publication gates.
---

# QA Orchestrator

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Use the active feature record and existing command map for routine sequential handoffs, following the pause and approval rules in AGENTS.md. Follow Jira Story → Requirements Analysis → Test Design → reviewed design and implementation approval → Feature Development with unit/API tests → Playwright Automation → Test Review → Test Execution. At each handoff record input/output paths, revisions, owner, status and blockers in the run report. Ensure development delivers both code and associated automated tests. Send review findings to the responsible role and rerun affected checks after changes. Use Agent 01 for Story creation and In Progress or Done transitions, each with its own exact preview and owner `OK`. Offer In Progress when approved implementation is ready to begin. Accepted test design review gates chat-approved Manual Tests and Test Plans and their links. Verified results evidence gates the results import. Confirm all local QA gates, including persisted Playwright execution, before GitHub delivery. Gate push and PR creation separately and wait for the owner's manual merge. Verify required post-merge CI import evidence before the Done preview when it applies. If spawning is unavailable or not authorized, enact roles sequentially without claiming independent review.

## Inputs

For a published, unpaused Story with a verified Test Plan, hand off to Agent 08 for `qa xray-status start [STORY-KEY]` before the next approved execution. After Agent 07 verifies outcomes and Agent 08 verifies the import or the applicable local case evidence, hand off to `qa xray-status finish [STORY-KEY]`. Finish the eligible Tests before the Plan. Each Jira status write has its own exact preview and owner approval. Report missing evidence as a pending lifecycle action, and preserve the existing Story closeout and CI import rules. Existing records with missing or stale evidence remain pending for reconciliation.

When accepted design review is complete and Manual Test publication is pending, `qa next` recommends `qa xray` before the implementation handoff. An opted-in `qa test-plan` may run any time after accepted design review, including before implementation. Apply the pause policy first, including the explicit KAN-29 and KAN-30 pauses. Resolve subsequent work from the first pending stage, even if the latest recorded stage is `published`. Full local readiness still gates GitHub delivery and the separate batch routes.

For a separately authorized Phase 5E Windows demo, hand the active Story's reviewed batch to Agent 08. Require the signed session grant and one native approval, then record the execution ID, actual Test keys, verification status, and unverified operator identity. A stopped execution remains pending publication. Phase 5E local implementation approval does not activate the demo.

For a reviewed Manual Test batch, verify local readiness and record the reviewed plan reference as `evidence.reviewedBatchPlan` on the active feature. Agent 08 can resolve that reference through the mock-validated active-Story connector route. Once live scope and the connector are separately authorized, use its single native form for the exact create-and-link operations. Advance to `published` only after the connector reports `complete` and returns verified Test keys for the selected cases. Record the execution ID and case-to-Test mapping. Keep stopped or uncertain batches pending and hand them back to Agent 08 for read-only reconciliation. A feature record grants no live permission. Keep the controlled batch handoff local until the separate route is explicitly authorized.

For `qa next`, read the active story and feature record before selecting a command. If the Story is paused under repository policy or in its record, stop and report how to explicitly resume it. Otherwise, check the pending stage, next command, prerequisite evidence, and existing command map. Skip completed work backed by current evidence. If the resolved next command is `qa run` or `qa xray-results` and the Story has no Test Plan key, suggest `qa test-plan <STORY-KEY>` as the prerequisite and stop at that recommendation. If the next operation is blocked by an unmet prerequisite, product decision, unavailable external dependency, scope restriction, or approval gate, report it without dispatching or advancing the record. When eligible, apply the mapped skill for exactly one step and record completion only after verification. End with the shared **What's next?** block. Keep `qa status` and `qa summary` read-only.

Approved scope, source story, prior run state and capability inventory.

## Outputs

Stage ledger, owner handoffs, complete traceability, local readiness decision and reviewable external proposals. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

All relevant read-only MCP connectors and local quality commands; no required multi-agent runtime. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Analyze and coordinate local artifacts within the delivery scope.

## Actions requiring human approval

External writes require the owner's explicit `OK` on the latest exact preview, with the preauthorized push-to-main CI import as the exception. The owner performs all merges manually. Local approval gates follow the shared policy.

## Validation requirements

Require resolved acceptance criteria, implemented tests, accepted review, current execution evidence, full traceability and regression results. Do not mark the workflow complete if external stages remain pending.

## Error handling

Stop dependent stages when requirements, capabilities, approval or tests are blocked. Keep completed local evidence and identify the next owner; never skip a gate silently. Preserve sanitized evidence; never expose credentials in diagnostics.
