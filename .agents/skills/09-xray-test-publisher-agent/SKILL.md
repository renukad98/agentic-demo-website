---
name: xray-test-publisher-agent
description: Prepare deduplicated Xray test publication plans and perform only separately approved supported writes.
---

# Xray Test Publisher Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

### Test and Test Plan issue lifecycle

Use `qa xray-status start [STORY-KEY]` after reviewed Tests and the Plan are published and linked, before execution. Use `qa xray-status finish [STORY-KEY]` after verified execution. Build the normalized read-only packet described in the [approval policy](../../../docs/agent-framework/approval-policy.md#test-and-test-plan-issue-status). Run the helper's `readiness` action to select the next eligible issue and hand off to Agent 01. Re-read Jira and Xray after each write so the next preview reflects current statuses. Verify plan membership and its association with the recorded Test Execution before proposing Plan Done. If the connector cannot verify those facts, report the blocked Plan instead of inferring them from Jira links. Keep Xray Test Run outcomes separate from Jira issue status.

### Chat-approved opt-in session

This is the default for `qa xray` and `qa xray <STORY-KEY>`. Use `node --import tsx tools/agentic/chat-xray.ts load "<exact qa command>"` from the repository root. The helper selects the feature record, checks the accepted review against the test-design SHA-256, converts every reviewed case and reads the optional pipeline folder. A missing explicit Story record blocks that request. Stop on a pause or mismatched evidence. Verify the Jira Story identity, tenant, project, and intended link type with authorized reads.

Read all inventory pages from `xray_search_tests` for the Story project, using the count of retrieved results as the next start. Inspect candidates matching a whole case-ID token, its exact title, or a saved Test key with `xray_get_test` and paginated `xray_get_test_coverage`. Save a sanitized packet in the Story run with `pages` (each with `total` and `results` containing `issueId`, `key`, `summary`) and `details` (same identity fields plus `manual`, `steps`, and `linked` to this Story). Run the helper with `duplicates "<exact qa command>" <packet-path>` to resolve all rows. Stop if equivalence or identity is ambiguous, if one key matches multiple cases, or if a candidate has incomplete readback.

Show the helper's exact preview verbatim using `preview "<exact qa command>" <packet-path> <tenant-url> <read-only|write-enabled>`. Choose read-only if any create, resolve, or link schema is unavailable. In that mode the preview ends with the one-time Windows setting, restart, and rerun instructions. With those tools available in the owner's opted-in local session, the preview ends with “Reply OK to approve these exact Manual Test creations and Story links.” The owner's explicit `OK` to that preview authorizes only the listed operations. Recheck the same command, feature and design digest, Story, mapping, tools, and duplicate resolutions before dispatch. Obtain fresh approval if a decision or payload changes.

Process one Test at a time. Call `xray_create_manual_test` only for an approved create. Call `xray_resolve_test_keys` with the issue ID returned by creation or verified by duplicate review, and verify the Manual type and exact steps. Save the mapping with `record <STORY-KEY> <case-id> <test-key>` before the approved link call. For skip, verify the existing link by readback. Verify each link against the same Story with coverage readback. On the first error or uncertain result, stop and report completed and pending rows. Reconcile by reads before a fresh preview. After all rows are verified, run `complete "<exact qa command>" <evidence-digest> <verified-links-JSON>`, passing the verified case-to-key map. Report one summary table with case, decision, Test key, and link outcome. Result import is outside this route.

### Chat-approved Test Plan and Story link

For `qa test-plan [STORY-KEY]`, run `node --import tsx tools/agentic/chat-test-plan.ts preview "<exact qa command>"`. Apply the pause policy. Verify the Jira Story key, type, and project by authorized read. For link-only, also verify the saved issue key, ID, project and Test Plan type by Jira read. Show the preview with the verified tenant and exact operations. A null inward key means the same plan returned by the listed creation. Offer `OK` only when the required write tools and reads are available.

After the owner replies explicitly with `OK` to the latest exact preview, rerun the preview and recheck the tenant and verified targets. Ask for fresh approval if anything changes. Call `xray_create_test_plan` only for a listed creation and retain its read-verified issue ID and key. Then call `jira_link_issues` with the verified plan key as `inwardKey` and the Story key as `outwardKey`. Accept only a matching `linked` or `already-linked` response with a link ID. The tool verifies the fixed Jira `Relates` relationship by readback.

Pass a JSON object with `preview` (the approved helper JSON), `plan` (verified `key` and `issueId`), and `link` (the verified tool response) on stdin to `node --import tsx tools/agentic/chat-test-plan.ts record "<exact qa command>"`. Read back the feature record and report the key and link status. Stop at the first error. If creation succeeded or may have succeeded, report the known issue ID or key and reconcile by read before seeking a fresh approval. Never retry a create automatically. This route is local chat only.

### Per-Story Playwright results import

For `qa xray-results [STORY-KEY]` or the Agent 08 handoff from `qa run [STORY-KEY]`, resolve the explicit Story or use `qa/current.json`. Read its feature record and apply the pause policy. Use the existing report for `qa xray-results`. Run `npm run xray:import-by-story -- --dry-run --story STORY-KEY` from the repository root and show the exact preview JSON, including the target, XML, and skipped or unpublished cases.

If there is an eligible import, offer the owner the exact scoped action with “Reply OK to import these Playwright results for STORY-KEY.” After explicit `OK`, rerun the dry run and compare the preview JSON to the approved preview. Ask for fresh approval if it changed. Run `npm run xray:import-by-story -- --story STORY-KEY` once and read back `testExecutionKey` from the feature record. Stop on an import error and reconcile any uncertain outcome before retrying. For an Agent 08 handoff from `qa run`, add `--qa-run` to both commands and show that the preview includes the local executed-stage update.

CI imports automatically after Playwright on pushes to main under the [results import policy](../../../docs/agent-framework/approval-policy.md#per-story-playwright-results-import).

### Reviewed Manual Test batches

For a separately authorized Phase 5E Windows demo, use the existing connector in signed-scope mode. Read `xray_get_local_demo_challenge` from the active reviewed Story and hand the complete challenge to the separate issuer. After scope approval and signature, pass the grant with `{ "activeStory": true }` to `xray_prepare_story_publication`. The connector calculates the SHA-256 digests. The operator's one native Allow covers the exact Manual Tests and links. Use the returned approval once and obtain status in the same session. Record operator identity as unverified and reconcile ambiguous results by reads. This phase authorizes local implementation only. See the [signed demo runbook](../../../docs/agent-framework/xray-personal-batch.md).

The reusable active-Story route is implemented for isolated connector validation. Once Test Execution has passed and the exact Manual definitions and duplicate decisions are reviewed, the feature record can reference the schema 1.1.0 plan in `evidence.reviewedBatchPlan`. Store the plan under `artifacts/qa/<story-key>/`. The reference selects evidence and carries no publish authority. Leave existing feature records and completed artifacts intact.

In a connector instance composed with an authorized active-Story route, use `xray_prepare_story_publication` with `{ "activeStory": true }`. The server reads the active record and calculates digests internally. Its one native form covers the exact Manual Test definitions, structured steps, and Story links. On Allow, the prepared result supplies the plan and the single-use approval ID. The same connector uses those values in `xray_publish_story` and the returned execution ID in `xray_get_story_publication`. Stop on declined approval, stale evidence, a pause, or any incomplete outcome. Report journaled Test identities and whether creation, linking, and end-to-end verification completed. An uncertain outcome requires separate read-only reconciliation.

Phase 5D continues to disable live execution of this route. The persistent registration exposes the existing read tools. This local implementation requires a separately authorized connector composition before use against Jira or Xray. The opt-in pinned personal batch below remains a distinct path.

Resolve the active Story via `qa/current.json` and its feature record. Stop on a user pause or an incomplete QA gate. Use the authorized tenant and environment, the current Jira Story identity and content digest, and the reviewed test design and traceability. Build a single Story publication plan with stable case IDs, preconditions, ordered action/data/result steps, and requirement references. Discover required project fields and the Test link type from the authorized connector. Never assume project, type, or reporter IDs from a prior story.

For a request such as “Publish the approved Manual Tests for ABC-123,” resolve the requested Story and its reviewed cases using the existing QA evidence. Read the `manualTestBatch` settings in [qa/pipeline.json](../../../qa/pipeline.json). Use only the extracted `xray_website` connector registered in the trusted project's `.codex/config.toml`. Use authorized Jira reads for Story metadata. Read all candidate pages and relevant coverage. Reuse only verified equivalent Manual Tests, verify their IDs and expected links, and stop on ambiguity. Prepare the proposed plan locally and keep its fingerprint internal.

For personal-batch validation, call `xray_website.xray_prepare_story_publication` in the credential-free `--personal-batch-probe` session with the synthetic fixture in the [runbook](../../../docs/agent-framework/xray-personal-batch.md). Treat Accept, Decline, and Cancel as validation results only. With `liveDispatchEnabled: false`, that batch route stops after read-only planning or probe validation. Keep the batch pending publication. If the configured connector or probe is unavailable, report the blocker.

A future personal-demo trial requires a separately reviewed scope activation under the approval policy, an enabled QA route and a verified opt-in `xray_website` session scoped to the authorized batch. Recheck the plan, duplicates, Jira link metadata and journal before calling the connector's batch preparation once. Wait for the native form. Decline, cancel, missing approval, changed evidence, or expiry stops the batch. On Allow, use the connector-issued approval ID and the unchanged plan with the guarded publisher once. Verify each Test and link by readback, report created, reused, linked, skipped, or unresolved cases, and reconcile uncertainty without resending the batch. The trusted publisher retains its separate policy.

Read MCP integration documentation. During Phase 2B document only; do not call preparation tools that persist demo approval state. In a later authorized phase inspect existing tests and complete paginated duplicate review, prepare local payloads and a human approval request. Do not propose publication until all local QA gates pass. Distinguish test creation, story linking and execution-result import as separately authorized capabilities. Never assume import is supported; no import tool is exposed now.

## Inputs

Orchestrator local-ready decision, accepted cases, traceability, project target and scoped human approval for any later write.

## Outputs

Local publication plan and exact candidate payloads; after approved publication, verified remote IDs and per-operation outcomes. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

Use Xray MCP read tools for evidence and the selected route's publication tools after verifying schemas, capabilities, and explicit approval. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Read authorized tests/coverage and generate local publication proposals after prerequisites are met.

## Actions requiring human approval

All Xray publication, issue linking and result import require explicit scope and the safeguards for the selected route. Use the exact chat preview for the opt-in route described above. Demo approval IDs are not human authorization.

## Validation requirements

Revalidate payload and evidence revisions before approved calls. Read back IDs, content and coverage after writes. Store actual remote IDs, not guessed keys.

## Error handling

On partial/uncertain writes stop and reconcile remote state before retry/resume. Do not bypass approval safeguards or modify/relocate the older server. Unsupported result import remains blocked. Preserve sanitized evidence; never expose credentials in diagnostics.

## Reusable Phase 5D contract

Phase 7C adds `KAN-28` as an explicit target for `preview-link-rest`, `execute-link`, and `reconcile-link`. Compile with `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit false --outDir .test-results/phase7c` and run `node .test-results/phase7c/tools/xray/local-demo.js preview-link-rest KAN-28` for the live read-only checks. Use `execute-link KAN-28` only during a separately authorized live step, confirming the full displayed fingerprint. Use `reconcile-link KAN-28` for an uncertain link. The existing default link target is KAN-26.

Phase 7 adds structured Manual Test creation from the existing KAN-25 `test-cases.md` artifact. Compile with `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit false --outDir .test-results/phase7` and use `node .test-results/phase7/tools/xray/local-demo.js preview-manual TM-TC-22` to review one case. The operator may use `execute-manual` with the same case ID only during a separately authorized live step, using the exact displayed fingerprint. Use `reconcile-manual` for an uncertain attempt. Creation adds no Jira link. Any later link requires its own approval and authorization to change the existing Story.

Phase 6Q adds the KAN-25 Checkpoint D personal-demo mode. Compile with `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit false --outDir .test-results/phase6q`. From the repository root, run `node .test-results/phase6q/tools/xray/local-demo.js preview-import` for the exact existing-execution import. After separate live authorization, the operator uses `execute-import` in place of `preview-import` and confirms the displayed SHA-256 fingerprint. Use `reconcile-import` for uncertain outcomes. Reconciliation performs remote reads only and uses the original journal reservation to verify the exact Test Run, status, timestamps and comment.

Phase 6N adds the KAN-25 Checkpoint C personal-demo mode. Compile with `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit false --outDir .test-results/phase6n`. Use `node .test-results/phase6n/tools/xray/local-demo.js preview-execution` to refresh the read-only preflight. After separate live authorization, the operator uses `execute-execution` in place of `preview-execution` and confirms the displayed fingerprint. Use `reconcile-execution` for an uncertain attempt. Reconciliation makes only remote reads and never clears the reservation for an automatic retry. Checkpoint D remains disabled.

Phase 6L adds the separate KAN-25 Checkpoint B personal-demo mode. Compile with `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit false --outDir .test-results/phase6l`. Use `node .test-results/phase6l/tools/xray/local-demo.js preview-link-rest` for the exact Jira REST request. After separate live authorization, the operator uses `execute-link` in place of `preview-link-rest` and confirms the displayed REST fingerprint. The CLI uses `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` from the existing gitignored .env. Use `reconcile-link` for an uncertain attempt. Confirmation requires both Jira link direction and Xray coverage. Checkpoints C and D are still disabled.

Phase 6I adds a KAN-25 Checkpoint A personal-demo entry point. From the repository root, compile with `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit false --outDir .test-results/phase6i`, then use `node .test-results/phase6i/tools/xray/local-demo.js preview`. The operator runs `node .test-results/phase6i/tools/xray/local-demo.js execute` in their own interactive terminal only during a separately authorized live step and enters the exact displayed confirmation. This mode trusts the local Windows session and process. Its journal is under `artifacts/qa/automation-identities/journal`. After an ambiguous outcome, use the same command with `reconcile` in place of `execute`. Preserve the journal and review ambiguous or missing results before considering any retry. The general production executor and Checkpoints B, C and D remain disabled.
