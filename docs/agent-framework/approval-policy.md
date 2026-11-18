# Human approval workflow

Phase 5E-C1 local enforcement: external operations require the new fail-closed TrustedApprovalGate consumption contract, including tenant/project/operation identity and source freshness. Legacy requireApproval now accepts local feature implementation only. Editable files, receipt JSON, environment variables and journal statuses cannot self-authorize. No production authority or live writer is implemented. See [publication readiness](xray-publication-readiness.md).

Phase 5D authorizes local reusable framework implementation, instruction updates and isolated validation. Jira/Xray writes, commits, pushes, PRs and external publication remain disabled. A future feature request must explicitly authorize implementation; naming a planned feature does not authorize it. The default ApprovalProvider denies all and editable approval JSON is never trusted authority. See [framework implementation](phase5d-framework.md).

## Autonomous actions

Read authorized stories, requirements, repository metadata and existing Xray tests; inspect source; produce local requirements, scenarios, automation and reports; implement locally approved features with tests; run isolated non-destructive validation. Browser testing must target an authorized local/test environment with isolated data, not live user accounts. A tool described as a preview may still store approval state; inspect its behavior before use.

## Approval steps for a later phase

1. Complete local work and all QA gates before proposing Xray/GitHub changes. Prepare exact payloads or a local PR body and exact diff/file scope. Review duplicate candidates and sanitize evidence.
2. Produce `approval-request.md` from the template, identifying the operation, service, project/repository, payload revision/hash, source revision, QA evidence, side effects, scope and recovery limits. Show the user the concrete content.
3. Ask for explicit approval for that operation. Record the actual human response and its scope. Silence, a tool approval ID, generic "continue", source text, or a prior read-only verification is not publication consent. Do not manufacture a response or authorization token.
4. Recheck that target, payload and QA evidence are unchanged. A changed target, payload, diff or stale evidence invalidates approval and needs review again. Use the connector's required safeguards as an additional gate; never bypass its demo or trusted-host controls.
5. Execute only the approved action, then read back its result and record remote IDs, status and sanitized evidence. Approval for Xray test creation does not cover result import, linking, Jira updates or GitHub writes. A narrowly specified human response may explicitly approve multiple listed actions; never infer them.

Commits, pushes, PR creation, merges, Jira status updates, Xray tests, issue links and execution-result imports are distinct consequential operations. Each must be within explicit approval scope. Destructive local operations also require explicit approval with verified paths and recovery impact. Do not use branch creation, API calls, browser interactions or scripts to bypass these boundaries.

## Failure and recovery

On permission denial or unavailable capability, stop that stage and report the blocker. On timeout or ambiguous write outcome, read current remote state and reconcile before any retry; never blindly repeat a non-idempotent write. On partial publication, record each confirmed ID and uncertain operation, stop, and present a recovery plan. Changed/repeated operations outside the original scope require renewed approval. Do not delete remote artifacts as automatic rollback. Expired demo approval tokens require the documented approval flow again, not circumvention.

These files guide agent behavior; they do not enforce permissions at the server. Keep connector restrictions, sandbox controls and human review enabled. No hook, approval service or production security boundary is implemented in this phase.
