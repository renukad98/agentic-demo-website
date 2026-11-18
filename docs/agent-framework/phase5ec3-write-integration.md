# Phase 5E-C3 local write integration

Production publication remains disabled. `Publisher` is unchanged. The additional
`createProductionWriteExecutor()` always throws `PRODUCTION_WRITES_DISABLED`; it
accepts no transport, authority, environment flag or CLI option. No coordinator,
application, MCP or HTTP path registers a writer. Importing these modules has no
remote effects. No production approval authority was installed.

The executable integration is deliberately confined to
`tests/xray/support/mock-write-executors.ts`, an isolated test-only entry point.
It composes the existing planners, identity verification, trusted approval gate
and operation journal. Its injected concrete mock transport accepts response
data only, with no endpoint, credentials or callback. It performs no networking.
This is not a live-capable executor or a claim of successful Xray publication.
Normal framework execution never imports the test harness.

## Binding and lifecycle

Trusted request contracts add optional automation identity and Test key for
backward-compatible historical receipts. The write-integration contract requires
automation identity. The harness requires exact tenant/project/Story, source and
evidence digests, payload digest, scope, deterministic operation ID and, for
linking, confirmed Test key. The existing gate verifies the entire request and
its authority receipt, expiration, consumption audit ID and replay reservations.
An authority must authenticate a human and atomically consume across clients.
Repository artifacts and environment variables are never authority.

Operation IDs hash tenant, project, operation and canonical payload digest. The
journal records Planned, Awaiting approval, Approved and Attempted before one
mock transport call. Failed approval or persistence cannot fall through to a
write. Duplicate proposals and creation identities fail closed. Creation uses
the exact existing Generic planner and rehashes current source/history. Complete
mock duplicate-clearance evidence binds tenant/project/Story/identity/source/
evidence, with a maximum age of five minutes and no future timestamp. These
editable test fixtures are not production evidence attestations.

Creation responses require a numeric issue ID, project-specific Test key,
Generic type, exact automation definition and successful mock read-back.
Partial valid IDs/keys are retained as observations in an Uncertain record;
they are not labelled confirmed without successful verification. No automatic
retry or deletion rollback exists. Existing journal reconciliation contracts
remain the only recovery path and require independently verified read-only
evidence. A new approval cannot bypass unresolved state.

Linking requires a Confirmed creation journal entry containing both ID and key,
fresh mock Test read-back, target Story verification and exact link type 10037
(Test tests Story). The unresolved planning preview remains separate. Equivalent
links cause no write; conflicting links fail closed. Linking consumes a separate
approval and requires post-link read-back. Timeouts/read-back failures enter
Uncertain and preserve the created Test ID/key. Creation approval cannot link.

## Limits and future approval

The mock authority reserves synchronously within one JS process. Tests exercise
two gates sharing that authority; they do not prove distributed consumption,
restart safety or production durability. The existing journal uses an exclusive
filesystem writer lock and exclusive numbered snapshots, preventing cooperative
concurrent local attempts. It does not fsync snapshots/directories, transact with
an external authority, or provide a distributed database. A crash can leave a
lock or a Planned/Awaiting approval/Attempted record needing manual reconciliation.
No stale-lock deletion or automatic recovery is implemented. Manual edits and
malicious local code are outside this trusted-host boundary.

Production remains blocked until a separately reviewed durable authority,
crash-safe operation store, authenticated read evidence, tenant permissions and
narrow transport integration are explicitly approved. Any future creation needs
fresh duplicate clearance, current QA review and exact human approval. Linking
requires its own payload and approval after verified creation. Executions and
result import are outside this phase.

The selected KAN-25 proposal is only read and its canonical digest recomputed.
No Story key, scenario count, Reporter or approved payload digest is hardcoded
into shared execution logic. Synthetic tests use unrelated Story/project data.
