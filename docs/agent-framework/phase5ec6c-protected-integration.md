# Phase 5E-C6 Increment C — protected integration contracts

Local implementation only. No real credential source, authenticated authority, network connection or writer is registered. Production writes remain BLOCKED. Existing ten skills run sequentially; these classes are contracts, not new agents.

## Credential references and read composition

`tools/xray/protected-integration.ts` adds `ProtectedCredentialReference`, reusing `ReferencedCredentialProvider`. It accepts an opaque safe identifier and pins resolution to one configured, allowlisted HTTPS Xray origin. Other regional origins are rejected even if globally allowlisted. Missing/invalid references and unavailable sources fail closed. No environment, file or MCP-secret resolver exists here.

`protectedReadSession` composes the existing token provider, HTTP read transport and read client. Offline is the default; no source is called. Protected-host composition requires an explicitly supplied source and fetch implementation. Missing fetch keeps resolution offline. It returns a read client and token invalidation function, never a token or writer. No startup request occurs. The host must separately authorize any real read/authentication setup.

Existing HTTP protections remain: redirect:error, HTTPS allowlist, response-origin checks, no-store, omitted cookies, fixed read queries, bounded bodies/timeouts and sanitized errors. Read retries are set to zero, but the existing read-only transport may still refresh once after a 401. This is not a one-shot live verification launcher and must never be reused for mutations. Mutation queries are rejected before token acquisition; the production write factory always denies. No mutation retry mechanism or transport was added.

`close` invalidates the in-memory token; the session can be reused to authenticate again. JavaScript cannot guarantee memory zeroization. The host owns source lifetime and must not retain/log secrets. Providers serialize only safe type metadata; tokens and source dependencies use private fields. The existing journal receives no provider, token or secret material.

## Authenticated approval source

`ProtectedAuthorityAdapter` implements the existing authority interface and supplies the existing `TrustedHumanApprovalBoundary`. A future protected host can inject its authority and a separately trusted `AuthenticatedApproverVerifier`. The latter must independently verify the real authenticated subject/session and bind it to authority, decision and exact request digest; copying input JSON is not verification. No real implementation is supplied. Test-only identity observations are synthetic and are not production authorization.

Context pins authority ID, tenant, project, executor principal and authority epoch. Existing request contracts bind operation/scope, Story, automation identity, payload/source/evidence/preflight digests and link Test identifiers. The adapter validates decision binding, authentication time, expiration, active identity and verifier consistency, and re-reads approval/revocation immediately before one source consumption. Identity-verifier inputs are frozen copies. All source errors become fixed local codes.

The adapter does not issue or revoke production approvals. Administrative revocation and remote audit retrieval remain unavailable until a protected provider is separately designed; revocation observations still flow through the existing boundary. Durable local audit events reuse the JSON journal and never prove human consent independently. Durable authenticated source audit and atomic single-use consumption are provider prerequisites, not claims established by the local adapter.

## Journal coordination and recovery

No journal schema or recovery algorithm changed. The existing boundary verifies the source, persists a pending reservation/operation and only then calls source consumption with the stable reservation ID. It validates the receipt and durably records consumed state. The adapter also poisons each attempted approval reference before awaiting consumption; it cannot automatically reconsume that reference in the same instance.

Lost/invalid consumption responses become Uncertain. A post-consumption journal write failure leaves pending/ambiguous state and demands authoritative reconciliation; it never implies unused approval. Reopening the journal cannot create another reservation for that operation. A new adapter instance cannot bypass durable journal replay checks when used through the boundary. Never expose the low-level authority interface as a standalone execution capability: journal coordination belongs to the boundary. No reconciliation method to clear ambiguity or resume writes is introduced.

External authority consumption and JSON replacement are not atomic. Real source durability, authenticated read-only reconciliation, restore/epoch fencing, host integrity and single-process ownership remain prerequisites. The in-process attempted-reference set is defense in depth, not distributed persistence. Production authority-backed Attempted transitions and both production-shaped execute methods remain disabled.

## Offline validation

Synthetic sources/verifiers are confined to tests. Global fetch and socket APIs are denied in the new suite; only explicitly injected synthetic fetch callbacks return in-memory responses. Real credential references remain unresolved. Temporary synthetic journals cover reservation ordering, uncertainty, failures before/after consumption, concurrency and close/reopen recovery. Existing HTTP/approval/journal/executor suites cover retained boundaries. Interruption simulations and close/reopen are not hardware power-loss or deployed authority durability proof.

Future protected composition may inject `adapter.boundary()` into the existing Generic creation/Jira link preparation constructors. No parallel publisher, dependency, database, credential configuration, workflow registration or live dispatch is introduced. Separate exact creation and linking approvals remain mandatory after all production prerequisites are met.
