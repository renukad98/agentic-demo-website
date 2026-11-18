# Xray Cloud read-only adapter — Phase 5E-B

The repository-local adapter now has a concrete HTTPS transport and in-memory authentication provider. It is not registered as an MCP server and is not connected to production credentials. This extends the Phase 5D injected interfaces; it does not replace the ten skills, the sequential workflow, the approval provider or the disabled publisher. Phase 5E-A findings were supplied in conversation; no local report is assumed.

## Credential and authentication boundary

`ReferencedCredentialProvider` accepts an external reference and an `ApprovedCredentialSource`. The embedding trusted host must resolve that reference only when its use by this adapter, tenant and region is explicitly authorized. A user-editable configuration flag or JSON file is not authorization. No concrete environment/file/MCP secret-store resolver is included. The default provider fails with CREDENTIALS_UNAVAILABLE. Do not paste secrets into chat, source code, command lines or reports. Do not extract credentials from global Codex/MCP configuration, load an arbitrary .env file or assume existing MCP/Jira authentication can be reused.

`XrayTokenProvider` sends Client ID and Client Secret only to `/api/v2/authenticate` at the approved base URL. Authentication responses must be JSON strings containing JWT-shaped tokens with a valid future numeric exp. exp is used only as a cache bound, never proof of authorization. Cache lifetime is capped at the documented 24 hours, with a 60-second expiry margin. Concurrent callers share an authentication request. Tokens remain in private in-memory fields and are excluded from object serialization. Authentication errors never echo remote bodies. Token acquisition and credential resolution have bounded timeouts. No token or credential is written to disk; memory cannot be guaranteed to be zeroized in JavaScript.

Regions are fixed to the documented global, US, EU and AU Xray HTTPS origins. The selected endpoint must be confirmed for the tenant before a live request. URL userinfo, alternate ports, paths, query strings, fragments and other hosts are rejected. Credentials and tokens are bound to the selected origin; redirects are not followed. The fetch implementation is injected for tests; trusted production composition may use built-in Node fetch without new packages. Do not inject an untrusted transport or logger: these are application-level controls, not a sandbox against hostile local code.

## Read operations

| Client method                        | Allowlisted GraphQL operation                                |
| ------------------------------------ | ------------------------------------------------------------ |
| getTest(numericId)                   | getTest: type, Generic definition, Manual steps, key/summary |
| getTestByKey(key)                    | getTests with an exact validated key selector                |
| searchTests(projectKey, bounds)      | getTests with an exact validated project selector            |
| getCoverage(testId, bounds)          | getTest.coverableIssues                                      |
| getTestExecution(numericId)          | getTestExecution                                             |
| searchExecutions(projectKey, bounds) | getTestExecutions with an exact project selector             |
| getRuns(executionId, start, limit)   | One getTestRuns page                                         |
| getAllRuns(executionId, bounds)      | Complete bounded getTestRuns traversal                       |

Queries are immutable fixed strings with strictly validated variables. There is no agent-facing arbitrary JQL or generic GraphQL executor. Mutations, aliases, batches, introspection, changed selection sets, unknown queries and extra variables are rejected before token acquisition or HTTP. The lower-level HTTP helper independently restricts paths to authenticate/graphql and enforces the same query allowlist. Unsupported or unavailable tenant fields fail visibly with sanitized GraphQL errors; they are not silently removed from a request.

Both the transport and client validate GraphQL response shapes. Partial data with GraphQL errors is rejected. Null single-item reads represent not found. Missing or malformed data is not success. Page traversal defaults to 50 items/page, ten pages and 1,000 items; maximums are 100/page, 100 pages and 10,000 items. Changed totals, repeated IDs, incorrect offsets/limits, empty progress or exhausted bounds fail with PAGINATION rather than returning an incomplete search as complete. Cloud JQL searches may impose stricter server limits; these remain visible GraphQL errors rather than evidence of complete retrieval. A read is not a transactionally consistent snapshot if remote content changes without changing totals.

## HTTP behavior and diagnostics

Timeout defaults to 10 seconds and is configurable from 1 ms to 60 seconds. Credential/token lookup and each HTTP attempt are separately bounded, so the full operation can take longer than a single configured timeout. Response processing is bounded to 1 MiB. Non-JSON content, malformed UTF-8/JSON, invalid models and HTTP failures produce fixed error codes without request/response bodies. Request IDs are generated locally and retained across retries. Diagnostic sinks receive only request ID, allowlisted operation name, attempt, outcome, fixed error code and HTTP status. No variables, identifiers, body, authorization header, token, credential reference or server error message is logged. Returned Test content/evidence references remain tenant data: sanitize and review before persisting them in workflow artifacts. Attachments are listed, not downloaded.

Only safe allowlisted reads retry: default one transient retry, maximum two, with bounded backoff for network/timeouts and HTTP 502/503/504. HTTP 401 permits one token invalidation/re-authentication cycle. HTTP 403/429 and GraphQL errors surface directly. Authentication is not automatically retried as a standalone operation. The read transport never invokes a mutation/import endpoint. Publisher and DisabledWriteTransport remain unchanged and reject all writes regardless of authentication, local approvals, environment variables or workflow mode.

## Trusted composition example

This demonstrates the API only. The names `approvedSource`, `approvedReference`, `confirmedApiBase`, `selectedProject` and `selectedTestId` must be supplied by a separately authorized host; they are not defined by local approval JSON.

```ts
import {
  ReferencedCredentialProvider,
  XrayTokenProvider,
} from "../../tools/xray/clients/authentication.js";
import { XrayHttpReadTransport } from "../../tools/xray/clients/transport.js";
import { XrayReadClient } from "../../tools/xray/clients/index.js";

const credentials = new ReferencedCredentialProvider(
  approvedReference,
  approvedSource,
);
const tokens = new XrayTokenProvider({
  apiBase: confirmedApiBase,
  credentials,
});
const transport = new XrayHttpReadTransport({
  apiBase: confirmedApiBase,
  tokens,
});
const client = new XrayReadClient(transport);
const tests = await client.searchTests(selectedProject);
const coverage = await client.getCoverage(selectedTestId);
// Review/sanitize tenant data; never log tokens, credentials or full HTTP bodies.
```

No Story key or test count is embedded in these modules. A client keeps no Story coverage/search cache; different Story contexts can share the same token provider without sharing mutable Story state. Create separate token providers for separate tenants/credential references. `getTest` now returns a validated Test or null; `getRuns` returns a validated page. The prior Phase 5D methods returned raw unknown envelopes and had no consumers outside tests; the interface change is covered by updated mock assertions.

## Verification and remaining prerequisites

Run `npm run typecheck:tools` and `npm run test:framework`, plus the existing quality/regression checks. All HTTP in automated tests is mocked, including synthetic credentials/tokens. No dependency installation, MCP change or production credential access is needed.

Live adapter verification in Phase 5E-B is BLOCKED: no credential source/reference has been explicitly authorized for adapter use, and the tenant endpoint has not been confirmed for this new connection. Existing MCP success is not adapter authentication. No live adapter request was attempted. This is a blocked integration prerequisite, not a failed mock implementation.

Phase 5E-C preparation: approve a specific existing external credential reference/provider and confirm the tenant region; wire that trusted composition separately, then perform a narrowly scoped read-only smoke check and verify real schema/permission behavior. Do not create or rotate credentials as an incidental step. No approval here covers Test creation, linking, executions, import, trusted publication authorization, MCP registration or GitHub delivery. KAN's unavailable Test Execution creation type and required Reporter handling remain tenant prerequisites from Phase 5E-A.

Official sources checked 2026-11-16: [Cloud authentication v2](https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/44577089), [Cloud v2 authentication example](https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/44579651), [regions and token lifetime](https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/44565892), [Test search](https://xray.cloud.getxray.app/doc/graphql/gettests.doc.html), [execution reads](https://xray.cloud.getxray.app/doc/graphql/gettestexecution.doc.html), [Test Run reads](https://xray.cloud.getxray.app/doc/graphql/gettestruns.doc.html).
