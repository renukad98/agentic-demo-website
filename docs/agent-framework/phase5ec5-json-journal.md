# Phase 5E-C5: JSON-only journal and local approval safety

The approved NO DATABASE correction supersedes the SQLite recommendation in the
historical C4 design and the previous C5 implementation. SQLite source, helpers,
tests and implementation guide were removed. Their reports remain historical and
must not be presented as validation of this JSON revision. Dependencies and the
website's JSON persistence were not changed. No agent was added.

## Existing journal, extended

OperationJournal remains the journal API. Its entry schema, state machine,
identity/payload duplicate guards, read helpers and recovery contracts are reused.
One file, <configured-root>/journal/operations.json, now contains the complete
versioned entry history and local consumption/reservation records. It is separate
from data/users.json and must stay outside public/. No live operation journal was
created by this phase; offline tests target owned temporary directories.

Each mutation reloads and validates the entire schema, transition history,
consumption uniqueness and request/payload bindings before changing operation
data. Same-process instances share a serialized queue keyed by canonical root.
Failed queue items do not discard subsequent queued work; ambiguous persistence
or ownership failures block further writes instead.

The new content is written with exclusive creation to a uniquely named temporary
file in the same directory, flushed with FileHandle.sync and closed before
fs.rename replaces the journal. Directory synchronization is attempted afterward.
Unsupported/denied directory-sync errors are explicitly reported; other errors
after rename begins mark the outcome uncertain and block writes. There is no
unlink-then-rename replacement or rollback to an older journal. Confirmed IDs and
Test keys are preserved by transition validation before replacement.

This sequence is an implementation, not proof of universal atomicity or crash
durability. Rename, file/directory synchronization, antivirus/sharing behavior,
network filesystems, storage firmware and power failure depend on the actual
platform. Runtime validation of this revision must be completed before claiming
any test pass. Publication remains blocked regardless.

## Single-process ownership

The first mutation exclusively creates writer-lock and writes/flushed owner
metadata containing PID and a session token. It remains held while any registered
same-process journal instance is open, including idle periods. close releases only
the current process's matching ownership metadata after its queued work. The
metadata is a cooperative guard, not a human approval or security credential.

Independent processes cannot rely on the in-memory queue. An existing, unreadable
or mismatching guard is denied; PID liveness or reuse is never enough to steal it.
No timeout automatically deletes a guard. This protects cooperating processes on
filesystems with reliable exclusive mkdir semantics; it is not distributed
fencing, a malicious-user boundary or verified network-filesystem safety.

A killed process may leave its guard and temporary file. Read-only inspection of
an intact journal is possible, but another writer is blocked. An operator must
quiesce all possible owners, inspect durable state and temporary files and approve
recovery separately. No stale-lock-removal or temporary-file-promotion utility is
implemented. If exclusive ownership cannot be established, publication stays
blocked. Keep all instances closed explicitly during normal shutdown.

Known orphan temporary files are never promoted or deleted automatically. A valid
main journal remains authoritative; absent main data with orphan/legacy evidence
fails closed. Only the current operation's uniquely created temporary file is
cleaned up after a pre-replacement failure. Old numbered snapshot layouts require
explicit reviewed migration; they are never silently replaced or merged.

## Approval contracts

journal-reservation.ts is a strict additive profile of the existing approval
request schema, not another approval system or journal. It binds tenant, project,
operation/scope, Story, automation identity, source/evidence/preflight/payload
digests, principal, epoch and operation ID. Existing writeOperationId remains the
deterministic proposal helper; no Story, project, count or payload hash is baked
into shared code. Creation and linking have separate requests/grants; linking
requires a locally confirmed ID/key binding.

The existing approvals module retains its original validators and default-deny
authority. Its additive evidence gate defaults to deny and accepts a future
trusted verifier only through dependency injection. Synthetic verifiers exist
only in test support. An opaque one-attempt verification handle cannot be created
by deserializing repository JSON. Arbitrary local code replacing a verifier is
outside this trusted-host interface boundary; no protected host was installed.

consumeAndReserve verifies exact bindings and expiry, then writes the local
consumption record plus Planned/Awaiting approval/Approved reservation history in
ONE JSON replacement. Errors cannot leave an independently committed consumed
record and missing reservation within that file. A rename error may still be
ambiguous: do not assume it means no replacement occurred or retry automatically.

External authenticated human consumption is NOT connected here. Verification is
not a separately consumed remote grant. If a future authority consumes externally,
this file cannot form a transaction with it: fail closed and require authenticated
reconciliation rather than claiming atomic distributed consumption. Production
authority and publication remain unconfigured/disabled.

JSON consumption rows and legacy record entries are audit data, not independent
human consent. The record API preserves compatibility for existing mock workflows;
approvalReference/audit IDs supplied to it cannot authorize a future live write.
Environment variables and editable records never activate the publisher.

## Recovery and limitations

Attempt intent is persisted before any hypothetical mutation. Recovered Attempted
or Uncertain entries block dependent work until read-only reconciliation. A
timeout is not absence proof. Consumed reservations cannot be attempted after
expiry or from a different ownership session. Approved reservations left by a
crash can be marked Uncertain for review without claiming a network call occurred.
No automatic creation/link retry or deletion rollback exists.

Existing absent-reconciliation retryOf support prepares only a new unapproved
local plan; it never executes a mutation or authenticates absence evidence. The
new consumption path does not automatically reuse an old operation/approval.
Reconciliation digests and remoteVerified=false local reservation results remain
separate from authenticated remote observations. Conflicting IDs/keys fail closed.

Restored or maliciously edited JSON cannot be trusted as authorization. This phase
does not provide protected OS storage, authenticated human UI, restore/epoch
fencing, cryptographic tamper resistance or remote reconciliation. No database is
proposed to resolve these limitations. The next gates are focused offline
validation, then separately approved protected human/ownership integration and
live read-only preflight; writes require later exact scoped approvals.
