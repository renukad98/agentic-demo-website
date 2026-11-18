# C6 Increment A: disabled Xray/Jira executor preparation

This phase adds inert production-shaped request adapters. It does not implement
or register an HTTP mutation transport, authenticate, read credentials or enable
publication. GenericTestCreationAdapter and JiraStoryLinkAdapter execute methods
delegate to the existing unconditional production denial factory. They accept no
transport, environment switch or CLI enablement. Import/initialization sends no
request. The old Publisher and normal QA coordinator are unchanged.

## Reuse

The adapters reuse canonical proposal/digest contracts, genericProposal,
genericVariablesSchema, duplicateDecision, linkProposal, IdentityRegistry,
verifyBinding, writeOperationId, approvedApiBase, TrustedHumanApprovalBoundary and
the existing JSON OperationJournal. No parallel journal, approval system,
publisher, AI agent or database is introduced. A fresh boundary defaults to deny.

The existing GenericMutationTransport/JiraLinkTransport interfaces and C3 mock
executor remain separate test infrastructure. No transport is constructed by the
new adapters. The read-only HTTP transport/query allowlist is unchanged; its
retry/401-refresh loop must never be reused to send mutations.

## Creation preparation

Inputs are configured tenant/project IDs, approved origins, one canonical
proposal, registered durable identity, exact approval request/reference and a
complete preflight snapshot. There is no KAN-25, feature-name, scenario-count or
payload-hash constant in shared code. Project/Test IDs and Reporter are explicit.

Preparation rehashes actual source/history, checks registry/Story membership,
reconstructs the exact Generic planner payload and compares approved digests. It
rejects cross-tenant/project/Story substitution, an existing registry remote
mapping, an existing journal creation or matching/ambiguous Test candidates.

Preflight binds identity/source/evidence/payload, tenant/project/Story, origins,
start/end times and paginated Test inventory. Pagination must start at zero,
maintain a stable total, cover all IDs with no repetitions and match the candidate
set. Freshness is at most five minutes from the snapshot start, with no future
timestamps. The exact snapshot digest must match the approval request. Ambiguous
or incomplete evidence blocks before authority consumption.

These snapshot checks validate local structure and binding, not live provenance.
No editable JSON boolean can establish human consent. A real trusted reader and
authority, actual tenant permissions and protected configuration remain missing.

The existing authority boundary supplies verified-source decisions in tests and
durably reserves pending/consumed local intent. An unavailable, expired, revoked
or malformed provider blocks preparation. The result is PREPARED_DISABLED with
the exact POST origin/path/query/variables; it is not execution permission.
Existing authority-backed Attempted transitions remain forbidden.

## Link preparation

A separate canonical link proposal and approval are required. The adapter checks
the stored Confirmed Test ID/key, registry membership, current Generic identity
observation, explicit Story metadata, expected link type/direction, complete
inventory visibility and snapshot digest. It never treats creation consent as
link consent. Valid equivalent links return NO_WRITE_ALREADY_LINKED without a
write or consumption; conflicting directions/types block.

Other Story links are not deleted or silently rewritten. The shared identity can
span registered Stories with separately approved membership and link payloads.
Failure or uncertain link authorization retains the existing confirmed creation
and blocks replay. No deletion rollback or second Test creation exists.

## Response classification and mock execution

inspectGenericCreationResponse is pure: it retains well-formed observed IDs/keys
even with partial/malformed responses. Complete Generic identity results still
return REQUIRES_READ_BACK, warnings require review and ambiguous results return
UNCERTAIN_RECONCILE. It never returns a confirmed Test or an executed Test Run.

Successful/uncertain mock writes are exercised using the existing isolated C3
MockWriteExecutors/MockWriteTransport, which persist Attempted before mock calls
and verify mock read-back. That harness is not imported into normal production
modules. Preparation fixtures use a separate synthetic authority and journal
context. No production mutation transport is reused for tests or wired to a mock
authority fallback.

## Future production prerequisites

Before any future send, separately approved executor wiring must revalidate fresh
preflight/metadata, hashes, authority expiry/revocation, confirmed read-back and
exclusive ownership, then persist a single Attempted intent. Current execute
methods cannot send at all. Prepared descriptors can become stale and must never
be replayed as durable authorization. No mutation retries or redirect/401 resends
are permitted after an ambiguous outcome; reconcile through authorized reads.

The C5 authority source/JSON update is not an atomic distributed transaction. A
lost response can leave pending/uncertain state requiring source audit; source
consumption, local reservations and confirmed Test IDs cannot be discarded to
retry. Real full-field read-back and Jira/Xray coverage verification are future
integration work; the adapters do not assume the server echoes a payload digest
or that description text creates a coverage link.

No real permission or physical data residency is inferred from the configured
Global Xray hostname. Jira origins are restricted to configured HTTPS Atlassian
Cloud sites, with no embedded userinfo, alternate port/path/query/fragment.
Protected host/credential policy, authentic preflight provenance, full read-back,
remote reconciliation and exact human write approvals remain NOT VERIFIED or
BLOCKED. Production publication remains disabled.
