---
name: qa-orchestrator
description: Coordinate approved feature delivery through requirements, implementation, QA evidence and separate publication gates.
---

# QA Orchestrator

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Use the active feature record and existing command map for routine sequential handoffs, following the pause and approval rules in AGENTS.md. Follow Jira Story → Requirements Analysis → Test Design → reviewed design and implementation approval → Feature Development with unit/API tests → Playwright Automation → Test Review → Test Execution. At each handoff record input/output paths, revisions, owner, status and blockers in the run report. Ensure Feature Development delivers code, developer tests, and reviewed non-browser case mappings before handing browser cases to Playwright Automation. Send review findings to the responsible role and rerun affected checks after changes. Use Agent 01 for Story creation and In Progress or Done transitions, each with its own exact preview and owner `OK`. Offer In Progress when approved implementation is ready to begin. Accepted test design review gates chat-approved Manual Tests and Test Plans and their links. Verified results evidence gates the results import. Confirm all local QA gates, including persisted Playwright execution, before GitHub delivery. Gate push and PR creation separately and wait for the owner's manual merge. Verify required post-merge CI import evidence before the Done preview when it applies. If spawning is unavailable or not authorized, enact roles sequentially without claiming independent review.

## Inputs

When accepted design review is complete and Manual Test publication is pending, `qa next` recommends `qa xray` before the implementation handoff. An opted-in `qa test-plan` may run any time after accepted design review, including before implementation. Apply the pause policy first, including the explicit KAN-29 and KAN-30 pauses. Resolve subsequent work from the first pending stage, even if the latest recorded stage is `published`. Full local readiness still gates GitHub delivery and the separate batch routes.

For a separately authorized Phase 5E Windows demo, hand the active Story's reviewed batch to Agent 08. Require the signed session grant and one native approval, then record the execution ID, actual Test keys, verification status, and unverified operator identity. A stopped execution remains pending publication. Phase 5E local implementation approval does not activate the demo.

For a reviewed Manual Test batch, verify local readiness and record the reviewed plan reference as `evidence.reviewedBatchPlan` on the active feature. Agent 08 can resolve that reference through the mock-validated active-Story connector route. Once live scope and the connector are separately authorized, use its single native form for the exact create-and-link operations. Advance to `published` only after the connector reports `complete` and returns verified Test keys for the selected cases. Record the execution ID and case-to-Test mapping. Keep stopped or uncertain batches pending and hand them back to Agent 08 for read-only reconciliation. A feature record grants no live permission. Keep the controlled batch handoff local until the separate route is explicitly authorized.

For `qa next`, read the active story and feature record before selecting a command. If the Story is paused under repository policy or in its record, stop and report how to explicitly resume it. Otherwise, check the pending stage, next command, prerequisite evidence, and existing command map. Run the read-only resolver `npm exec --offline -- tsx tools/agentic/qa-next.ts` from the repository root to resolve the active Story's pending stages and next command. The Manual Test publication receipt uses the same resolver. Apply the existing approval and publication precedence rules before dispatching the resolved action. After feature implementation, require current approved-case mappings or verified equivalent legacy evidence before Playwright, execution or delivery, even when the recorded stage is published or the stage list already says complete. Check the design fingerprint, source/test revision, case coverage, paths, exact titles and review in the Story evidence before treating this obligation as verified. If missing or stale, route to `qa implement` or the upstream owner for reconciliation. Preserve completed Story history. Allow scoped local execution with `qa run` before a Test Plan exists. When preparing `qa xray-results` or an explicitly requested import handoff, require the verified Test Plan and suggest `qa test-plan <STORY-KEY>` if it is missing. Preserve local results while import is pending. If the next operation is blocked by an unmet prerequisite, product decision, unavailable external dependency, scope restriction, or approval gate, report it without dispatching or advancing the record. When eligible, apply the mapped skill for exactly one step and record completion only after verification. End with the shared **What's next?** block. Keep `qa status` and `qa summary` read-only. Route Story completion through `qa close` and use the verified CI import receipt described in the approval policy when applicable.

Approved scope, source story, prior run state and capability inventory.

## Sequential handoff

After every verified stage, update the existing run-report ledger and immediately report the completed agent, generated artifact paths, next recommended agent, purpose, command, reason, and confirmation or approval status. Use the command actually applied to resolve its owner. Report failed, blocked, uncertain or declined outcomes and keep dependent stages pending. Pass the outcome and reason to the handoff resolver, with `blocker.dependency` naming the missing prerequisite or capability. Use `blocker.remaining` for additional blockers. For another actionable read-only review with no registered command, supply `blocker.review` with the existing agent skill name and the specific purpose.

Call the existing qa-next helper with `--handoff [STORY-KEY]` and a JSON packet on stdin. Supply mode (one-step, read-only or end-to-end), current outcome status and reason when relevant, and completed with the command and artifacts as repository-relative path and SHA-256 digest pairs under the Story artifact directory. Default to one-step. Pass end-to-end with runScope containing storyKey and runId only when the owner explicitly authorizes automatic continuation for that Story and run. Keep that scope in the active conversation and discard it when the run ends or the owner withdraws it. Report the exact scoped command and issue target. In **What's next?**, show the returned agent, purpose, reason, command or verbatim confirmation, approval requirement, and remaining blockers. If a useful recovery has no registered route, provide an exact Story-scoped chat instruction for the existing responsible skill. If the reply is unavailable because a dependency needs resolution, report that dependency and wait. A stage confirmation authorizes the named stage only. A protected operation still needs a fresh exact preview and separate approval. Set completed only after verification and use the actual report or review artifacts describing any implementation or external action.

In an authorized end-to-end run, apply the next in-scope safe analysis skill in this session when the recommendation says continue-analysis. Repeat after verified progress. Stop on unchanged progress, a review requiring correction, or any stop recommendation. A bounded request and qa next perform one step and report the next action. Wait for confirmation of the named stage even if it is read-only or only generates local analysis artifacts. Status and summary remain read-only. A named stage command confirms that stage only; it does not approve a protected operation. Existing-Story intake is safe when the exact target is known and authorized. Test execution and application edits are outside automatic analysis.

After Playwright implementation, use the existing `qa test-review` route with an explicit post-implementation review scope when automation review evidence needs reconciliation. Review the exact source, browser tests, and mappings. Include their paths and digests and the line `- Decision: accepted for automation.` in the accepted report, then record it in `evidence.automationReviewProof` as a path and digest. Verify the reviewed source and test revisions again before execution and delivery. Reuse an older accepted automation review when its recorded revisions verify the current source, browser tests and case mappings. Preserve historical reports.

Each protected operation must reach its own exact preview and stop for approval. After approval, recheck only that operation, verify its outcome, and resolve the next handoff again. A previous OK cannot authorize another action. Recommendations grant no authorization and leave all existing evidence, publication, and approval gates in force.

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
