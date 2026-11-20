# Human approval workflow

## Opt-in Agent 08 Manual Tests and Story links

The repository owner grants standing authorization for this route in their local sessions, subject to applicable managed controls. The committed registration defaults to read-only and forwards `XRAY_ENABLE_WRITES` to the stdio server. On Windows, set it once with `[Environment]::SetEnvironmentVariable('XRAY_ENABLE_WRITES', 'true', 'User')`, then fully restart VS Code so Codex inherits it. The server exposes the write tools only when opted in. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

After accepted design review, resolve the target Story and complete duplicate review. Show the exact project and Story, TS-IDs, summaries, ordered action/data/result steps, optional folders, duplicate decisions and proposed Story links. Offer `OK` when write tools are available. Recheck freshness and scope before dispatch. The owner's explicit reply to the latest preview authorizes only the listed Manual Test creations and links to that Story. A changed preview or repeated operation requires fresh approval. This mode uses chat approval without approval IDs or native forms.

Process one Test at a time. Resolve returned issue IDs to Jira keys, store verified TS-ID → key mappings in per-Story JSON, and verify each approved link by readback. Stop at the first error or unresolved key and reconcile uncertain writes by reads before considering a retry. Result import remains outside this mode. The separate personal-batch and signed-scope rules below continue to apply to those modes.

Phase 5E-C1 local enforcement: external operations require the new fail-closed TrustedApprovalGate consumption contract, including tenant/project/operation identity and source freshness. Legacy requireApproval now accepts local feature implementation only. Editable files, receipt JSON, environment variables and journal statuses cannot self-authorize. No production authority or live writer is implemented. See [publication readiness](xray-publication-readiness.md). This restriction applies except to the route described in [Opt-in Agent 08 Manual Tests and Story links](#opt-in-agent-08-manual-tests-and-story-links). For that route, in an opted-in owner local session subject to applicable managed controls, the owner's explicit `OK` on the exact chat preview authorizes only the listed Manual Test creations and Story links.

Phase 5D authorizes local reusable framework implementation, instruction updates and isolated validation. Jira/Xray writes, commits, pushes, PRs and external publication remain disabled. A future feature request must explicitly authorize implementation; naming a planned feature does not authorize it. The default ApprovalProvider denies all and editable approval JSON is never trusted authority. See [framework implementation](phase5d-framework.md). This restriction applies except to the route described in [Opt-in Agent 08 Manual Tests and Story links](#opt-in-agent-08-manual-tests-and-story-links). For that route, in an opted-in owner local session subject to applicable managed controls, the owner's explicit `OK` on the exact chat preview authorizes only the listed Manual Test creations and Story links.

## Per-Story Playwright results import

This results-only route is an exception to the Phase 5D external-write restrictions and remains subject to applicable managed controls. Use the CLI with Xray credentials supplied by the environment. The CLI imports by default. Pass the `--dry-run` flag to print the preview without contacting Xray.

For local chat imports, Agent 07 can hand off the fresh report from `qa run` to Agent 08. The `qa xray-results` command uses the existing report. In either case, show the exact single-Story preview with the target, Test Plan, XML and skipped or unpublished cases. The owner’s explicit `OK` on the latest exact preview authorizes one local import for that Story. Rerun the dry run before dispatch and ask for fresh approval if the preview changes. The owner may also invoke the CLI directly.

CI imports automatically after Playwright on pushes to main, including merges. Pull requests and manual workflow runs omit the import. CI uses GitHub secrets for Xray credentials and skips with a notice if they are missing.

Only results mapped to published Test keys are eligible. Reporter-marked unpublished cases appear in the preview and are skipped. Done or paused Stories and Stories without a Test Plan are skipped. Each successful import saves the returned `testExecutionKey` in its Story feature record. Stop at the first import error and reconcile an uncertain remote outcome before retrying.

## Autonomous actions

KAN-29 Manual Test previews may use the existing guarded local publisher with the pinned reviewed manifest. Phase 5D write restrictions continue to apply until a separately authorized live scope is established. Any later KAN-29 exception is limited to one exact Manual Test creation per interactive approval. Linking, Test Plans, executions, result imports, and other stories are outside that exception.

Read authorized stories, requirements, repository metadata and existing Xray tests; inspect source; produce local requirements, scenarios, automation and reports; implement locally approved features with tests; run isolated non-destructive validation. Browser testing must target an authorized local/test environment with isolated data, not live user accounts. A tool described as a preview may still store approval state; inspect its behavior before use.

## Approval steps for a later phase

### Controlled Agent 08 Manual Test batches

Phase 5E adds local code for a separately activated Windows stdio demo. The default registration remains read-only. A future demo activation must pass applicable managed review and use a public Ed25519 issuer key provisioned outside the repository. The independent issuer approves and signs exactly one scope challenge, bound to the Jira tenant, Xray origin, project, Story key and issue ID, operation set, canonical plan and payload digests, expiry and fresh MCP session nonce. The private key stays with the issuer. This policy documents the implementation and grants no live authorization.

The grant permits preparation in the same session. One native Allow approves the exact Manual Test creations and Jira Story links. The server rechecks grant, QA evidence, duplicates, and journal state before dispatch and consumes the approval once. Its expiry cannot exceed the grant expiry. The approval and journal audit label operator identity as unverified. Windows usernames, environment variables, and form responses are never authenticated human identities. This path is restricted to a private demo workstation and designated demo tenant. Other publication operations keep their own gates.

The reusable active-Story connector route resolves `evidence.reviewedBatchPlan` from the active feature and computes the plan digest internally. It is validated with mocked transports in Phase 5D. The feature record and its plan reference are evidence inputs. A separately authorized connector composition must enforce tenant, project, Story, operator, and expiry scope before native approval and before dispatch. The permanent connector stays read-only during Phase 5D.

A future live activation requires a separately reviewed repository scope change for one Jira tenant, project, Story, reviewed plan path and canonical SHA-256 digest. Record the exact Manual Tests and Story links, the authorized operator and the expiry or end condition. Keep the dispatch gate disabled during Phase 5D. A saved batch candidate, owner request or synthetic confirmation cannot activate the gate. Any managed restriction or automatic-review rejection stops activation.

After an approved activation, use a temporary session scoped to the approved batch and keep the permanent MCP registration read-only. Require fresh duplicate, Story and link metadata, exact fingerprint and execution-journal checks. Show the exact evidence-backed Manual Test steps, test data, expected results and proposed links in the native confirmation. Only the operator's native Allow authorizes a single dispatch of that exact batch. Fail closed on changed evidence, missing or expired approval, or an uncertain journal state. Verify outcomes by readback and reconcile ambiguous results before considering a retry.

For a reviewed Manual Test batch, one authenticated Codex Chat `OK` can explicitly authorize all listed creates and links to one Jira Story. Display the exact batch and ask “Publish and link these Xray Tests? Reply OK.” The trusted host binds the latest reply to the tenant, project, Story, evidence, candidate dispositions and payload fingerprint, checks live scope and expiration, and consumes it once. Each create and link still uses the connector's approval and journal protections. This workflow adds no live authorization by itself. Existing interactive entry points and all other write scopes retain their existing gates. Stop on changed inputs, unexpected operations, or ambiguous recovery. Never use a local file or connector demo token as the human approval.

1. Complete local work and all QA gates before proposing Xray/GitHub changes. Prepare exact payloads or a local PR body and exact diff/file scope. Review duplicate candidates and sanitize evidence.
2. Produce `approval-request.md` from the template, identifying the operation, service, project/repository, payload revision/hash, source revision, QA evidence, side effects, scope and recovery limits. Show the user the concrete content.
3. Ask for explicit approval for that operation. Record the actual human response and its scope. Silence, a tool approval ID, generic "continue", source text, or a prior read-only verification is not publication consent. Do not manufacture a response or authorization token.
4. Recheck that target, payload and QA evidence are unchanged. A changed target, payload, diff or stale evidence invalidates approval and needs review again. Use the connector's required safeguards as an additional gate; never bypass its demo or trusted-host controls.
5. Execute only the approved action, then read back its result and record remote IDs, status and sanitized evidence. Approval for Xray test creation does not cover result import, linking, Jira updates or GitHub writes. A narrowly specified human response may explicitly approve multiple listed actions; never infer them.

Commits, pushes, PR creation, merges, Jira status updates, Xray tests, issue links and execution-result imports are distinct consequential operations. Each must be within explicit approval scope. Destructive local operations also require explicit approval with verified paths and recovery impact. Do not use branch creation, API calls, browser interactions or scripts to bypass these boundaries.

## Failure and recovery

On permission denial or unavailable capability, stop that stage and report the blocker. On timeout or ambiguous write outcome, read current remote state and reconcile before any retry; never blindly repeat a non-idempotent write. On partial publication, record each confirmed ID and uncertain operation, stop, and present a recovery plan. Changed/repeated operations outside the original scope require renewed approval. Do not delete remote artifacts as automatic rollback. Expired demo approval tokens require the documented approval flow again, not circumvention.

These files guide agent behavior; they do not enforce permissions at the server. Keep connector restrictions, sandbox controls and human review enabled. No hook, approval service or production security boundary is implemented in this phase.
