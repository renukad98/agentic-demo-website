# Human approval workflow

## Delivery scope for unpaused Stories

An existing unpaused Jira Story with accepted requirements and test design is eligible for local implementation with associated automated tests once material product decisions are resolved and the application-edit gate is approved. KAN-29 and KAN-30 remain paused regardless of local record flags. Read-only inspection is permitted. The owner must explicitly resume either Story before delivery can proceed, subject to connector restrictions.

For each external write, show the exact current preview and obtain the owner's explicit `OK` before dispatch. Bind the reply to the displayed operation, target, payload and revision where applicable. Recheck those inputs and applicable managed controls after approval. Obtain fresh approval for changed or stale previews, and verify each dispatched write by readback. The CI results import described below is preauthorized. The owner performs all merges manually.

## Jira Story creation and transitions

For `qa story`, the Jira Story Agent may read an existing Story or prepare creation in the selected project. Preview the tenant, project, Story issue type, summary, description, acceptance criteria and all additional fields to be sent. After `OK`, create once with the available Jira connector, read back the assigned Story key and fields, and use that verified key for the local QA record.

Treat In Progress and Done as separate transitions. Read the current status and valid transitions and show the tenant, project, Story key, current status, target status and exact transition ID and payload. Offer In Progress when approved implementation is ready to begin. Offer Done after verifying the owner's manual merge and required QA and publication evidence, including the post-merge import when applicable. Each transition requires its own `OK` and status readback.

## GitHub delivery

Keep separate scoped local previews and approvals for branch creation, staging and commits. After all local QA gates pass, preview a normal push with the repository, remote, source commit and destination branch. Preview PR creation separately with the repository, head, base, title, body and reviewed revision. Each external action requires its own `OK`. Verify the remote branch or PR after dispatch. Hand the verified PR to the owner for manual merge.

## Opt-in Agent 09 Manual Tests and Story links

The repository owner grants standing authorization for this route in their local sessions, subject to applicable managed controls. The committed registration defaults to read-only and forwards `XRAY_ENABLE_WRITES` to the stdio server. On Windows, set it once with `[Environment]::SetEnvironmentVariable('XRAY_ENABLE_WRITES', 'true', 'User')`, then fully restart VS Code so Codex inherits it. The server exposes the write tools only when opted in. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

After accepted design review, resolve the target Story and complete duplicate review. Show the exact project and Story, TS-IDs, summaries, ordered action/data/result steps, optional folders, duplicate decisions and proposed Story links. Offer `OK` when write tools are available. Recheck freshness and scope before dispatch. The owner's explicit reply to the latest preview authorizes only the listed Manual Test creations and links to that Story. A changed preview or repeated operation requires fresh approval. This mode uses chat approval without approval IDs or native forms.

Process one Test at a time. Resolve returned issue IDs to Jira keys, store verified TS-ID → key mappings in per-Story JSON, and verify each approved link by readback. Stop at the first error or unresolved key and reconcile uncertain writes by reads before considering a retry. Result import remains outside this mode. The separate personal-batch and signed-scope rules below continue to apply to those modes.

The trusted approval and journal requirements still apply to the separate controlled publication routes that use them. Editable JSON, environment variables and journal statuses do not constitute human approval. See [publication readiness](xray-publication-readiness.md).

## Chat-approved Test Plan and Story link

This local route is available any time after accepted test design review for an unpaused Story, subject to applicable managed controls. Check for an existing plan before proposing creation. In an opted-in MCP session, Agent 09 may use `xray_create_test_plan` and `jira_link_issues` only after the owner explicitly replies `OK` to the latest exact preview for one Story. Show the tenant, project, Story, existing plan key or exact creation summary, and the fixed Jira `Relates` link between the plan and that Story.

Recheck freshness and scope before dispatch. Create only if previewed, resolve and verify the plan by read, and verify the exact link by readback before saving `testPlanKey` in the Story feature record. Stop at the first error. Reconcile a known or uncertain create or link by read before seeking fresh approval. Apply the pause policy. CI has no Test Plan creation or Story-link authorization.

## Per-Story Playwright results import

This results-only route remains subject to applicable managed controls. Use the CLI with Xray credentials supplied by the environment. The CLI imports by default. Pass the `--dry-run` flag to print the preview without contacting Xray.

For local chat imports, Agent 08 can hand off the fresh report from `qa run` to Agent 09. The `qa xray-results` command uses the existing report. In either case, show the exact single-Story preview with the target, Test Plan, XML and skipped or unpublished cases. The owner’s explicit `OK` on the latest exact preview authorizes one local import for that Story. Rerun the dry run before dispatch and ask for fresh approval if the preview changes. The owner may also invoke the CLI directly after approving the exact preview.

CI imports automatically after Playwright on pushes to main, including merges. Pull requests and manual workflow runs omit the import. CI uses GitHub secrets for Xray credentials and skips with a notice if they are missing.

Only results mapped to published Test keys are eligible. Reporter-marked unpublished cases appear in the preview and are skipped. Done or paused Stories and Stories without a Test Plan are skipped. Each successful import saves the returned `testExecutionKey` in its Story feature record. Stop at the first import error and reconcile an uncertain remote outcome before retrying.

## Test and Test Plan issue status

For a reviewed, published, unpaused Story, the QA Orchestrator hands off `qa xray-status start [STORY-KEY]` before execution and `qa xray-status finish [STORY-KEY]` after verified results. The helper proposes To Do → In Progress → Done in order. Finish may propose a passing Test independently of other cases. Plan Done requires the exact reviewed Test set in the plan, a verified associated Test Execution recorded for the Story, and passing evidence and Jira Done status for every required Test. A failed remote run takes precedence over local evidence. Existing Story transitions and the CI results-only authorization continue to apply.

Agent 09 gathers the packet from fresh, authorized reads. Agent 01 uses the following local helper actions. Each dispatch requires its own owner `OK` on the latest exact preview. Creation, link and import approvals grant no transition authority.

```text
node --import tsx tools/agentic/chat-xray-lifecycle.ts readiness "qa xray-status start KAN-99"
node --import tsx tools/agentic/chat-xray-lifecycle.ts preview "qa xray-status start KAN-99" KAN-100
node --import tsx tools/agentic/chat-xray-lifecycle.ts check "qa xray-status start KAN-99" KAN-100
node --import tsx tools/agentic/chat-xray-lifecycle.ts record "qa xray-status start KAN-99" KAN-100
```

Provide JSON on stdin. Every action takes `context` with the verified Jira HTTPS `cloudId`, `story`, `plan`, and `tests`. Issue objects carry `key`, numeric-string `id`, `issueType` and `status`. Plan and Test objects also carry the verified `storyKey`, `linkId`, `linkType` (Relates for the plan, Test for a Test) and available `transitions` with `id`, destination `to`, and `requiredFields`. Verify Test link direction and supply only available transitions.

For finish, supply verified `planMembers` when available and an `execution` with its issue fields, verified `planKey`, and mapped `runs` when available. Each run has `storyKey`, `caseId`, `testKey`, and `outcome` (passed, failed, skipped, or not-run). A case requires a matching passing Xray Test Run unless its accepted, fingerprinted design section explicitly declares `- Level: API`, `- Level: API-only`, or `- Level: Manual`. Unlabelled and mixed-level cases require an Xray Test Run. For an explicitly eligible case, Agent 08 may provide a reviewed local case result JSON containing those same fields, based on verified run evidence. A mapped Xray run takes precedence, including failed, skipped, and not-run outcomes. Pass it in `caseEvidence` as a `caseId`, Story-relative artifact `path` (repository-relative under `artifacts/qa/<STORY-KEY>/`), and prefixed `sha256` fingerprint. Do not substitute an import acknowledgement for Test Run or plan membership readback.

For check, supply the latest `preview` and the owner's `reply` with freshly re-read `context`. Dispatch only the returned Jira transition arguments. For record, supply the checked pre-dispatch packet plus the normalized issue `readback`. Receipts are local and exclusive. Stop on the first error, reconcile uncertain writes by read, and re-preview remaining operations individually. The helper performs no remote calls.

## Autonomous actions

Read authorized stories, requirements, repository metadata and existing Xray tests; inspect source; produce local requirements, scenarios, automation and reports; implement locally approved features with tests; run isolated non-destructive validation. Browser testing must target an authorized local/test environment with isolated data, not live user accounts. A tool described as a preview may still store approval state; inspect its behavior before use.

## Approval steps for a later phase

### Controlled Agent 09 Manual Test batches

Phase 5E adds local code for a separately activated Windows stdio demo. The default registration remains read-only. A future demo activation must pass applicable managed review and use a public Ed25519 issuer key provisioned outside the repository. The independent issuer approves and signs exactly one scope challenge, bound to the Jira tenant, Xray origin, project, Story key and issue ID, operation set, canonical plan and payload digests, expiry and fresh MCP session nonce. The private key stays with the issuer. This policy documents the implementation and grants no live authorization.

The grant permits preparation in the same session. One native Allow approves the exact Manual Test creations and Jira Story links. The server rechecks grant, QA evidence, duplicates, and journal state before dispatch and consumes the approval once. Its expiry cannot exceed the grant expiry. The approval and journal audit label operator identity as unverified. Windows usernames, environment variables, and form responses are never authenticated human identities. This path is restricted to a private demo workstation and designated demo tenant. Other publication operations keep their own gates.

The reusable active-Story connector route resolves `evidence.reviewedBatchPlan` from the active feature and computes the plan digest internally. It is validated with mocked transports in Phase 5D. The feature record and its plan reference are evidence inputs. A separately authorized connector composition must enforce tenant, project, Story, operator, and expiry scope before native approval and before dispatch. The controlled batch route remains inactive unless separately authorized.

A future live activation requires a separately reviewed repository scope change for one Jira tenant, project, Story, reviewed plan path and canonical SHA-256 digest. Record the exact Manual Tests and Story links, the authorized operator and the expiry or end condition. Keep the dispatch gate disabled until that route is separately authorized. A saved batch candidate, owner request or synthetic confirmation cannot activate the gate. Any managed restriction or automatic-review rejection stops activation.

After an approved activation, use a temporary session scoped to the approved batch and keep the permanent MCP registration read-only. Require fresh duplicate, Story and link metadata, exact fingerprint and execution-journal checks. Show the exact evidence-backed Manual Test steps, test data, expected results and proposed links in the native confirmation. Only the operator's native Allow authorizes a single dispatch of that exact batch. Fail closed on changed evidence, missing or expired approval, or an uncertain journal state. Verify outcomes by readback and reconcile ambiguous results before considering a retry.

For a reviewed Manual Test batch, one authenticated Codex Chat `OK` can explicitly authorize all listed creates and links to one Jira Story. Display the exact batch and ask “Publish and link these Xray Tests? Reply OK.” The trusted host binds the latest reply to the tenant, project, Story, evidence, candidate dispositions and payload fingerprint, checks live scope and expiration, and consumes it once. Each create and link still uses the connector's approval and journal protections. This workflow adds no live authorization by itself. Existing interactive entry points and all other write scopes retain their existing gates. Stop on changed inputs, unexpected operations, or ambiguous recovery. Never use a local file or connector demo token as the human approval.

1. Complete the QA gates applicable to the operation before proposing an external write. Prepare exact payloads or a local PR body and exact diff/file scope. Review duplicate candidates and sanitize evidence.
2. Produce `approval-request.md` from the template, identifying the operation, service, project/repository, payload revision/hash, source revision, QA evidence, side effects, scope and recovery limits. Show the user the concrete content.
3. Ask for the owner's explicit `OK` on that exact operation. Record the actual human response and its scope. Silence, a tool approval ID, generic "continue", source text, or a prior read-only verification is not publication consent. Do not manufacture a response or authorization token.
4. Recheck that target, payload and QA evidence are unchanged. A changed target, payload, diff or stale evidence invalidates approval and needs review again. Use the connector's required safeguards as an additional gate; never bypass its demo or trusted-host controls.
5. Execute only the approved action, then read back its result and record remote IDs, status and sanitized evidence. Approval for Xray test creation does not cover result import, linking, Jira updates or GitHub writes. A single external-write approval can cover multiple listed operations only for an explicitly defined route, such as Manual Test publication with Story links or a Test Plan with its Story link.

Commits, pushes, PR creation, Jira Story creation and transitions, Xray Tests, Test Plans, links and results imports are distinct operations. The owner merges manually. Each must be within explicit approval scope. Destructive local operations also require explicit approval with verified paths and recovery impact. Do not use branch creation, API calls, browser interactions or scripts to bypass these boundaries.

## Failure and recovery

On permission denial or unavailable capability, stop that stage and report the blocker. On timeout or ambiguous write outcome, read current remote state and reconcile before any retry; never blindly repeat a non-idempotent write. On partial publication, record each confirmed ID and uncertain operation, stop, and present a recovery plan. Changed/repeated operations outside the original scope require renewed approval. Do not delete remote artifacts as automatic rollback. Expired demo approval tokens require the documented approval flow again, not circumvention.

These files guide agent behavior; they do not enforce permissions at the server. Keep connector restrictions, sandbox controls and human review enabled. No hook, approval service or production security boundary is implemented in this phase.
