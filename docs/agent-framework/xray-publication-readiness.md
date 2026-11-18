# Local Generic Test readiness — Phase 5E-C1

This phase extends existing modules, not the ten agent definitions. Local proposals and mock-tested enforcement are implemented. Publication, linking, result imports and external verified workflow states remain disabled. No production human authority, credential source or mutation transport is installed. The read-only transport still rejects mutations. Prior user instructions authorizing a phase are not approval for a later remote operation.

## Durable identity

The authoritative initial registry snapshot is `artifacts/qa/automation-identities/registry-v1.json`, written exclusively through IdentityRegistry.save. The first repository-owned identity is:

```text
agentic-demo-website:playwright:task-create-inflight-single-submit-v1
```

`task-create-inflight-single-submit-v1` names the behavior, not the Story, title hash, run or native runner ID. It is a deliberately assigned v1 contract for the already implemented in-flight submission test. Keep it stable across runs; changes to its binding require explicit reviewed migration. No test annotation, rename, source edit or runtime behavior change was necessary.

The binding records source path/title, Chromium project, original runner ID and three historical report references. Historical reports do not contain the new framework ID; the sidecar registry supplies that relationship now. Source digest is the canonical digest of the source-file hash map. Behavior digest is a conservative hash of source location, framework/project, title and that map, not a claim of semantic equivalence. Evidence digest independently hashes historical report references/digests. `verifyBinding` rehashes source and reports, verifies the recorded Playwright ID/title/file/project and requires actual passing attempts. Unknown/missing/failed records block verification. This does not execute tests or make historical passes new executions.

IdentityRegistry merges many-to-many Story associations without changing the composite identity. It rejects alias/native-ID collisions, changed source/binding/behavior, conflicting Xray IDs and reuse of one remote Test for another identity. `resolveRunner` checks Story membership. Snapshots are immutable; do not overwrite old versions or silently refresh fingerprints. Serializing registry revisions remains the host's responsibility. A reviewed binding change must produce an explicitly reviewed new snapshot; no automatic migration/rebase service is implemented.

Source paths are confined to approved source/artifact locations; .env, data stores and path traversal are excluded. Current historical-proof verification supports bound Playwright JSON. Existing Node normalizers remain available, but durable Node historical proof with explicit runner identity is not implemented in this phase and fails closed. Different Playwright tests/Stories/runs use the same generic APIs; no shared module hardcodes KAN-25, TM-TC IDs, counts or personal accounts.

## Generic proposals and Reporter

`genericProposal(story, project, identity, summary, creation)` retains its earlier positional arguments and adds explicit required creation input. Existing four-argument calls now fail closed. `genericCreationSchema` validates project ID, Test issue type ID and `reporter.accountId`. A Reporter is never inferred from the Story or current session. Local accountId syntax validation does not establish account existence, permission, Reporter eligibility or default handling.

`genericVariablesSchema` validates the documented Generic testType, unstructured identity and required Jira fields. Description includes repository, framework, source, Story/requirement/acceptance/scenario associations, original runner evidence and source/evidence/behavior fingerprints. No unverified custom Jira fields or future remote IDs are invented. The payload contains the operation name, inert GraphQL document and variables. `payloadDigest` binds that exact payload; `evidenceDigest` remains separate.

`genericProposalPreview` first verifies actual source/history. Complete input yields READY_LOCALLY with a schema-valid proposal, not live permission. Missing Reporter yields BLOCKED with Reporter null, an informational previewDigest and payloadDigest null. That draft is not approvable. The selected real candidate remains blocked because no Reporter has been confirmed. No personal account ID was reused or persisted. Complete proposals and deterministic approval digests are tested with synthetic Reporter values only.

The report's `.graphql` file is a readable inert view. The exact query string in the JSON payload is authoritative for future payload approval. Never send a preview through the read-only transport or bypass the disabled publisher.

`pendingLinkProposal` preserves runtime-provided Test link metadata, existing Story target and null future Test key. It has no executable payload digest. Once a real created Test is read back, use existing `linkProposal` with the confirmed key and separately approve its exact payload. Jira links and Xray coverage both need future read-back. Creation approval cannot authorize linking.

## Trusted approval boundary

The legacy `requireApproval` remains available for approved local feature implementation; it rejects external operations. External readiness uses `TrustedApprovalGate` and `TrustedApprovalAuthority.consume`. Default authority denies. No repository file, environment flag, submitted receipt or local journal status can substitute for the trusted authority callback.

Request schema binds operation, target, scope, payload/evidence/source digests, tenant identifier, project and operation ID. Tenant must identify the actual tenant (for example its approved Jira Cloud identifier); the Global Xray hostname alone is not a tenant identity or physical residency proof.

The future authority must authenticate the human decision and atomically consume an approval across clients/processes. Receipt schema binds the complete request/digest, approval ID, unique consumption audit ID, authority/human references and issue/expiry/consumption times. Gate checks all bindings and freshness, reserves references/operation IDs before asynchronous consumption and rejects replayed consumption IDs. An uncertain/invalid authority response cannot automatically retry. Distributed replay protection, authenticated authority transport, durable authority storage and consumption reconciliation remain future production integration, not a local JSON service.

`consumeGenericProposalApproval` rehashes real source/history, validates/reconstructs the complete Generic payload and compares source/evidence/target/project/payload bindings before asking the gate to consume. It returns audit data only; it never invokes a remote writer. A future live engine must additionally verify tenant configuration/permissions, confirm QA gates and execute only within approval lifetime. No such engine is enabled here. Dependency injection is a trusted-host boundary, not protection against malicious local code replacing the authority implementation.

## Journal and recovery

New journal records require tenant/project/source/evidence context; creation also requires automation identity. Older optional-field schemas remain readable, but new writes must satisfy the stricter checks. Approved/attempted/confirmed entries require both approval reference and consumption audit ID. Those fields are records, not permission.

A fail-closed exclusive writer directory serializes journal mutations. A competing writer must reload/reconcile; no spinning or automatic stale-lock deletion is implemented. A process crash may leave the lock requiring verified manual recovery. Snapshot files remain exclusive, and confirmed remote IDs cannot be dropped or replaced.

New duplicate operation payloads and duplicate creation identities are rejected, including across Stories. A confirmed existing Test must be reused through a separately approved Story link. A timeout moves to Uncertain, stops dependent actions and requires read-only reconciliation with a recorded evidence digest. Confirmed creation may identify exactly one numeric Test issue ID. Conflicting IDs remain blocked. Test creation success followed by link failure preserves the Test; it never triggers another creation or rollback deletion.

Only Reconciled/absent with no confirmed IDs and explicit reconciliation evidence permits planning a new retry operation using `retryOf`. This is a new unapproved plan, not an automatic retry or authority grant. A fresh separate consumed approval is still required. Unknown, confirmed or ambiguous outcomes cannot retry. Recovery evidence in editable files is not independently trusted; the future host must verify live read-back before using it.

## Focused validation and next phase

Run only the authorized readiness/registry/contract/recovery mock suites plus framework TypeScript, changed-file lint and formatting checks. No application/Node regression or browser suite is required/authorized in C1. Phase 5E-B's 128-test baseline is historical, not rerun here. Its initial intermittent API HTTP 500 and three pre-existing YAML formatting warnings remain disclosed; this phase neither fixes nor relabels them as passed.

Phase 5E-C2 should separately authorize read-only Reporter eligibility/required-field/permission and duplicate review for the intended publishing principal, then regenerate the exact proposal. Confirming Reporter is not approval to publish. Trusted production authority integration, a constrained mutation engine, Test creation, Story linking, executions/imports and MCP/GitHub changes all require separately scoped approvals. Keep the publisher unchanged and disabled.

API field structure references (documented, not tenant write verification): [Xray createTest](https://xray.cloud.getxray.app/doc/graphql/createtest.doc.html), [Jira creation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Jira links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/).
