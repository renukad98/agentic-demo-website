# Reusable Story-driven framework — Phase 5D

Phase 5E-B extension: [secure read-only Xray adapter](xray-read-only-adapter.md) implements the transport/authentication previously missing from this Phase 5D baseline. No live credential source is wired; publication and trusted production approval integration remain disabled/unimplemented respectively. Historical implementation notes below describe Phase 5D.

Phase 5D implements a local coordination library, not an autonomous coding service. The same ten skills execute sequentially. The coordinator records role handoffs; it neither invokes Codex sessions nor implements a feature. Same-session review is self-review. No MCP server, production approval host, authentication client, or live writer is registered or enabled.

## Lifecycle and roles

Jira Story Agent retrieves the selected Story. Requirements Analysis derives measurable criteria. Test Design drafts scenarios before development; Test Review accepts the design. Human implementation approval precedes Implementation Agent, which owns feature code and associated unit/API tests. Implementation Agent also maps existing coverage and implements missing approved non-browser cases. Playwright Automation owns persisted browser tests. Test Design checks coverage again; Test Review reviews implementation and automation. Test Execution and Reporting executes isolated checks and analyzes results. QA Orchestrator owns each evidence gate. Xray Test Publisher prepares deduplicated Generic definitions, links, execution and import proposals. GitHub Integration prepares delivery only after local readiness. Every external action remains separately gated.

## Contracts and inputs

`tools/agentic/contracts/index.ts` exports strict Zod schemas, version 1.0.0, for workflow inputs, Jira source, requirements/acceptance criteria, scenarios, identities, mappings, execution, proposals, approvals, states and audit events. Unknown fields and invalid keys are rejected. Errors are validation failures, never implicit success.

Input requires Story key, repository root/namespace, Jira HTTPS site/context, mode, approved scope reference, source-file digest manifest and its canonical digest, isolated environment, required quality gates, Xray destination/grouping and approval references. Optional previousRunId selects resume. Modes are assess, plan, implement, validate, publish and deliver. They describe intent, not authorization; no mode activates writes.

Use canonical `objectDigest(sourceFiles)` for the sourceDigest. Only approved source/test/config paths belong in sourceFiles: exclude secrets and live data. Include all files relevant to the run; the library checks listed files, not unlisted dependencies. The repository package name must be agentic-demo-website. The canonical root must be the named repository or a registered linked worktree inside its .worktrees directory. Synthetic tests use disposable repositories bearing that name.

## Local usage

```ts
import { Workflow } from "../../tools/agentic/workflow.js";

const workflow = await Workflow.start(validatedInput);
await workflow.attach("source", sanitizedStorySnapshot);
await workflow.attach("requirements", requirements);
await workflow.advance(
  "ANALYZED",
  "requirements-analysis-agent",
  currentSourceDigest,
);
const report = workflow.report();
// Persist report through writeExclusive with a unique filename if desired.
```

This is a library API; no CLI or automatic Jira retrieval/coding integration is claimed. Read Jira through the existing authorized MCP, then supply a sanitized snapshot. Full synthetic examples are executable in tests/agentic/framework.test.ts. Default approval denial deliberately prevents a real feature run from crossing IMPLEMENTATION_AUTHORIZED until a trusted provider is implemented and separately approved. Mock providers occur only in tests.

## State and artifacts

States follow DISCOVERED, ANALYZED, DESIGN_REVIEWED, IMPLEMENTATION_AUTHORIZED, IMPLEMENTED, TESTS_IMPLEMENTED, BROWSER_IMPLEMENTED, AUTOMATION_REVIEWED, VALIDATED, LOCAL_READY, XRAY_PROPOSED, TESTS_VERIFIED, LINKS_VERIFIED, EXECUTION_VERIFIED, RESULTS_VERIFIED, DELIVERY_PROPOSED, DELIVERY_VERIFIED. New manifests select the split implementation workflow. Historical manifests without that marker retain their combined IMPLEMENTED gate and transition order. A workflow cannot skip states. BLOCKED, FAILED, AWAITING_APPROVAL and UNCERTAIN suspend a stage without erasing prior results. External verified states cannot be entered in this phase.

Runs live under artifacts/qa/<story-key>/<unique-run-id>/. Exclusive directory creation prevents overwriting prior runs. Subdirectories include source, requirements, design, implementation, automation, executions, xray, approvals, audit, delivery and state. Typed evidence is stored under evidence/ with unique IDs. State snapshots have exclusive monotonically numbered filenames. Concurrent saves cannot overwrite each other; the losing caller must reload and reconcile. The coordinator is intended for a single writer per run.

Source files are rehashed before transitions and resume. Artifacts are fingerprinted and checked for tampering. Evidence freezes after its gate; changing accepted inputs requires a new run. Implementation edits change the baseline: capture the resulting source manifest in a new validation run and repeat/revalidate upstream artifacts and approvals rather than overwriting the planning run. There is no automatic source-rebase operation.

The caller creates a distinct executionId for every rerun and writes raw evidence exclusively. Preserve first failures. Existing template paths remain useful human-readable artifacts; schema evidence supplements them. Fingerprints detect accidental changes, not hostile local tampering. This filesystem library is not a security boundary against another process with workspace write access. Symlinks are rejected when checked; hostile concurrent filesystem replacement is outside its guarantee.

Resume uses Workflow.resume with the same inputs and previousRunId. Changed inputs require a new run. Reactivation rechecks source and artifacts; UNCERTAIN cannot auto-reactivate. Required quality gates must have actual command/evidence references and exit zero. Every mapped automation identity must have passing execution evidence; skipped, unknown, unmapped or failed results block local readiness. Audit-only scenarios require separate audit evidence references. The coordinator validates contracts and coverage, but does not independently prove that supplied review statements or command records are truthful; human/agent review must inspect actual evidence.

## Automation identity and result normalization

Identity is repository namespace + runner + stable automation ID. Source location and optional parameter identity are metadata, not a mutable-title identity. Give parameter variants distinct stable IDs. Story is an association, not part of shared identity. Registry merges associations without duplicates; changed behavior or conflicting Xray IDs require review. Persistence is explicit exclusive snapshots; serialize shared-registry updates outside the library. No automatic multi-process registry lock is claimed.

One Generic Xray Test represents one independently reported automation identity. Business scenarios and acceptance criteria map many-to-many to identities. Audit cases are never fabricated executions. Counts are derived from each Story's inventory. Shared regression Tests can cover multiple Stories after identity and behavior verification.

Node JUnit normalization uses installed JSDOM's XML parser with DTD/entity rejection. It accepts the existing direct-testcase Node format and conventional suites. No timestamps are inferred from report-wide times. Playwright normalization traverses native JSON suites and preserves attempts, failures, optional duration/start time and attachment references. Titles/file names are lookup inputs only: an explicit resolver must map them to stable IDs. A missing mapping blocks normalization. Native report metadata that is absent stays absent. An unexpected outcome remains unknown. Raw errors/evidence require sanitization before persistence; pattern checks are defense in depth, not comprehensive secret detection.

Xray import proposals reference verified explicit Test keys and an execution key. Multiple attempts block proposal generation pending a reviewed retry policy rather than hiding earlier failure. Unknown/skipped outcomes block until tenant-specific status mapping is verified. PASSED/FAILED are proposed Cloud statuses, not tenant-verified configuration. No manually executed results are manufactured.

## Xray architecture and remote boundaries

tools/xray contains identity registry, normalizers, pure planners, injected read-transport interfaces, verification helpers, publisher and operation journal. Generic proposals model createTest with Generic testType and unstructured identity. Execution proposals model createTestExecution. Result proposals model /api/v2/import/execution with explicit testExecutionKey and tests/testKey. Jira linking uses runtime Test link metadata and the Test-to-Story orientation. Jira and Xray coverage must both be read back. Coverage pages and execution result sets must be complete.

API references: [Generic Test creation](https://xray.cloud.getxray.app/doc/graphql/createtest.doc.html), [Test Execution creation](https://xray.cloud.getxray.app/doc/graphql/createtestexecution.doc.html), [Cloud REST imports](https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/44577176), [Cloud JSON](https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/44565311).

No fetch, token acquisition or production credentials are used by this adapter. Read transport is injected; tests use mocks. Publisher and DisabledWriteTransport always reject writes, even when approval exists. Pure payloads are proposals, not evidence of tenant permissions, required fields or valid statuses. Existing MCP remains unchanged and does not expose the full automated lifecycle. Its publication ledger is not a Test Execution. The older server is neither read nor modified.

## Approvals, journal and recovery

Default ApprovalProvider denies all. A future trusted provider must authenticate a human decision independently of editable local JSON. requireApproval validates operation, target, exact canonical payload and evidence digests, scope, expiry and reference. Approval records are audit data, never authority by themselves. No production override flag exists. Replay prevention, durable consumption and authentication must be enforced by that future provider; the local validator alone does not implement them.

Feature implementation, Test creation, Story linking, execution creation, import, commit, push, PR, merge and Jira update are distinct operations. Changed content invalidates approval. Existing human Phase 5D authorization permits framework work only, not future feature/publication operations.

OperationJournal stores exclusive operation snapshots: Planned, Awaiting approval, Approved, Attempted, Confirmed, Failed, Uncertain, Reconciled. It rejects changed operation identity/payload, unsafe transitions, lost confirmed IDs and blind retry. Journal records do not establish trusted approval. On uncertain outcomes stop dependent operations, read back remote state and record confirmed/absent/ambiguous reconciliation. A confirmed match may permit continuation; absent/ambiguous outcomes need a reviewed recovery plan and renewed scoped approval before any new operation. No import idempotency or automatic rollback deletion is assumed. The journal is a planning/recovery component, not a live execution engine.

## Validation and limitations

Run npm run typecheck:tools, npm run test:framework, source/test typechecks, lint, build, existing Node tests and existing isolated Chromium tests. No installation is necessary. Test scripts separate the nested framework tests from the unchanged existing npm test selection. Tools are checked through tsconfig.tools.json and are not emitted into application dist/.

The three pre-existing .playwright-mcp YAML formatting warnings remain a failed repository-wide gate; changed-file formatting is reported separately. Phase 4B evidence is historical and preserved. Phase 5A–5C findings were supplied in conversation, not assumed to exist as local reports.

Phase 5E should review local code/evidence, integrate a trusted approval host, verify read-only tenant schemas/permissions, then separately approve any MCP registration, credential wiring and narrow remote proof. Test Execution availability, required fields, Generic/link compatibility and status configuration remain unverified. GitHub remote identity/base/head and exact staging scope must be verified separately. No dependency changes, new demonstration features, Jira/Xray writes, commits, pushes or PRs are authorized by this document.

## Split implementation evidence

New typed runs attach `featureImplementation` at IMPLEMENTATION_AUTHORIZED, `caseImplementation` at IMPLEMENTED and `browserImplementation` at TESTS_IMPLEMENTED. Each packet binds the Story, source manifest and attached scenario artifact digest. Implementation Agent provides digested application and developer-test paths. Implementation Agent and Playwright Automation provide digested test paths and exact titles, stable automation identity, approved case and level, and existing or added disposition. Each mapping lists its exact requirement and acceptance-criterion pairs in `covers`. Traceability must match those declarations, and the union of the mappings must cover the approved case. Implementation Agent records the exact browser handoff. Playwright Automation maps that handoff. Automated scenarios specify distinct levels. Manual and audit scenarios use the audit evidence route. A blocked case leaves its implementation stage pending.

At DESIGN_REVIEWED, attach `review` with `reviewDigest` equal to the stored scenario digest. At AUTOMATION_REVIEWED, attach `automationReview` with the canonical object digest of the stored case implementation, browser implementation, inventory and traceability digests in that order. Both review records fingerprint their referenced files with `evidenceDigests`. Attach the final inventory and traceability by BROWSER_IMPLEMENTED. This binds the review to the mappings and source revision before execution. The chat workflow uses its separate accepted Markdown design and SHA-256 contract for publication.

### QA next evidence

For the chat workflow, record the Story-relative review proof under `artifacts/qa/<story-key>/<run-id>/` and set `evidence.testImplementation` in the active feature record to its repository-relative path. Record `storyKey`, `kind` (`feature-development` for new work, or `agent-06` and `legacy-equivalent` for historical evidence), and `design`, `designReview` and `coverageReview` objects with repository-relative `path` and prefixed SHA-256 `digest`. `caseMappings` also has a repository-relative `path` and prefixed SHA-256 `digest`. It references the reviewed case-to-test mappings. Design and design review must be the files referenced by the feature record. The coverage review records `- Decision: accepted for case implementation.` and the reviewer's verified case coverage, including reusable legacy coverage where applicable. Include `sourceFiles` as a path-to-SHA-256 map of the exact source and test files used for the review. The coverage reviewer records `- Coverage revision: sha256:<hex>` using `objectDigest` of the routing packet with the `coverageReview` field omitted. The review binds the Story, design and design-review revisions, reviewed mappings, and source and executable test revisions. Refreshing the packet after a change requires a new coverage decision, including for legacy-equivalent evidence. Agent 10 and the Manual Test publication receipt both recheck these references when resolving pending work. Missing or changed proof routes coverage reconciliation to `qa implement`. Reconciliation may reference existing legacy evidence without changing historical runs.

New typed runs require a persisted browser mapping and a passing Playwright result for each browser implementation identity before LOCAL_READY. Historical manifests retain their original gate.
