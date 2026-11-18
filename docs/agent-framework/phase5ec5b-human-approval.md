# Increment B: trusted human-approval boundary

This is a local, offline integration boundary. No production authority, approval
issuer, credential source, network client or writer is registered. Existing
Publisher and createProductionWriteExecutor remain unconditionally disabled.

## Additive source contract

TrustedHumanApprovalAuthority extends the existing approval-evidence verifier
interface. It supplies exact decisions, atomic single-use consumeApproval,
externally authenticated revokeApproval and readAudit. There is no production
approve/issue method. The source must authenticate the human/channel and audit
decisions; an identity string or JSON authentication field is not authentication.

TrustedHumanApprovalBoundary defaults to a denying source. Its public approval
input is an approval reference and the existing journal request/payload, never an
approver object, local receipt or path to an approval file. Strict source-response
validation checks the configured authority, approver subject/authentication
reference, decision/audit IDs, issue/authentication/expiry times and the exact
canonical request. The request already binds tenant/project, operation and scope,
Story, automation identity, source/evidence/preflight/payload digests, principal,
epoch, operation ID and link Test ID/key.

An injected source is a trusted embedding-host dependency. These TypeScript
interfaces cannot prove that an arbitrary callback authenticates anyone. A future
protected host and authenticated authority channel remain required. No editable
repository record or environment variable can install that trust automatically.
Only synthetic sources under test support are implemented in this phase; normal
production modules never import them. Even an injected synthetic source cannot
reach a live writer through this integration because no writer is registered and
authority-backed Attempted transitions are explicitly disabled.

## Reused journal, no database

ApprovalEvidenceGate and OperationJournal.consumeAndReserve are reused rather
than replaced. The evidence schema and version-2 JSON consumption records gain
optional authority audit metadata. Old local/mock records remain readable and
existing 147 tests are retained. There is no parallel journal or schema migration.

Authority metadata records source/decision/approver references, exact request
digest and append-only pending/consumed/revoked/uncertain observations. Transition
validation and external consumption-ID replay checks run on full journal load.
Opaque process-local handles prevent JSON from supplying an authority transition.
These handles and recorded audit data are not live execution permissions.

## Coordination and failures

1. Verify an exact, unexpired source decision using the default-deny adapter.
2. Persist a local pending reservation and consumption reference using the existing
   single-process queue, ownership guard and flushed JSON replacement.
3. Ask the source to atomically consume once, bound to that reservation ID.
4. Validate the consumption receipt and persist its audit observation.

If local reservation fails, source consumption is not called. A lost/invalid
consumption response produces an uncertain record and blocks the operation. If
the source consumed but the final JSON write fails, the durable pending record
remains (or the replace outcome itself is uncertain): require read-only source
audit and journal reconciliation. Never automatically consume again, issue a new
grant, retry a mutation or delete a Test. Confirmed Test ID/key history is retained.

The source's transaction and JSON replacement are NOT one atomic distributed
operation. Single-use guarantees at the real source are a future contract, not
proved by process-local synthetic fixtures. No production consumption adapter is
installed, and authoritative reservations cannot advance to Attempted in this
phase, even after a valid receipt. Production remains blocked.

## Revocation and audit

The source revocation method requires an independently authenticated human at the
source; callers cannot declare that identity. refreshRevocation only reads and
validates an externally observed revoked decision. It appends a local revoked
event and marks pending/approved local operation state Uncertain for review. It
does not silently cancel or undo a remote effect. Unavailable/invalid authority
reads do not authorize anything.

Future execution must check expiry and revocation again immediately before its
separately approved dispatch boundary. A revocation after a possible dispatch
cannot prove the action was prevented. This increment performs no dispatch.

## Validation and next gate

Focused synthetic tests cover decision bindings, missing/expired/revoked grants,
default denial, source outages, single-use/replay/concurrency, journal failures on
both sides of consumption, restart, separate creation/link grants, immutable
existing IDs and disabled publication. Network guards deny calls in the new
suite; no live authority or Jira/Xray endpoint is contacted.

The next gate is review of a protected human/authority channel and deployment
ownership model, with no database. It must address durable revocation, external
single-use consumption, interrupted coordination, restore/epoch policy and safe
read-only reconciliation before any live writer is proposed. Production transport
implementation, credentials, live preflight, Test creation and Story linking each
remain separate approval scopes.
