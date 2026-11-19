# Personal Xray Manual Test batches

## Phase 5E Windows signed-scope demo

The normal `xray_website` registration stays read-only. The following procedure is for a separately approved future trial. It uses the same persistent stdio registration for the duration of that trial. Operator identity is unverified throughout.

1. On an independently controlled issuer machine, generate an Ed25519 key pair in a protected directory outside the repository. For example, run `openssl genpkey -algorithm ED25519 -out <private.pem>` and `openssl pkey -in <private.pem> -pubout -out <public.pem>`. Restrict private key access to the issuer. Provision only the public PEM to the demo workstation through a trusted, access-controlled location and verify the key by an independent channel. The demo connector must never receive the private key.
2. Obtain applicable managed approval for the exact Story, tenant and Xray origin, eligible create/link operations, issuer, trial workstation and time window. Confirm current QA evidence and an eligible active feature with `evidence.reviewedBatchPlan`. Validate native forms using the credential-free probe below.
3. After approval, keep the same `xray_website` registration and append `--signed-local-demo` to its server arguments. Provision `XRAY_LOCAL_DEMO_PUBLIC_KEY_FILE` as the absolute path of the issuer public PEM in the reviewed launch configuration. Keep the three existing read tools and allowlist only `xray_get_local_demo_challenge`, `xray_prepare_story_publication`, `xray_publish_story` and `xray_get_story_publication` for the trial. Preserve private Jira/Xray credential provisioning. Missing or invalid setup falls back to the read-only server. The launcher and key location are part of the local demo trust boundary.
4. In that MCP session, request `xray_get_local_demo_challenge`. Give the issuer the complete challenge JSON. The issuer reviews and separately authorizes the exact payload and signs it from the workspace root with `node --import tsx tools/xray-mcp/agents/sign-local-demo-scope-grant.ts --sign-reviewed-scope <challenge.json> <public.pem> <absolute-private.pem> <ttl-seconds>`. The standalone utility computes and verifies the digests internally. Treat the returned grant as a short-lived authorization artifact and keep it out of chat transcripts, repository history, and shared logs. The challenge and signed grant are distinct from native approval.
5. Pass the signed grant to `xray_prepare_story_publication` as `scopeGrant` with `activeStory: true`. The same session shows one native form for the exact creates and links. Select Allow only after review. Use the returned approval ID and plan once with `xray_publish_story`. Read status and verify the Test keys, ordered steps, Jira link direction and Xray coverage. On an uncertain outcome, stop and reconcile by reads. End the trial session and restore the normal read-only launch configuration.

Grant authenticity is independent of the Windows username or the MCP response. This model assumes a private workstation and trusted launcher. A process with control of that local session could fabricate an Allow. It is unsuitable for managed or shared publishing.

The connector under `tools/xray-mcp` is an extraction of the existing Xray MCP server and its batch publisher, adapters, approval store, and execution journal. The production approval contracts and the original deployment remain separate.

Run the extracted connector without arguments for read-only Xray tools. The personal-demo session is available only on Windows outside production and CI. For a separately authorized session, set the connector arguments to `["--import","tsx","tools/xray-mcp/src/integrations/xray-mcp/server.ts","--personal-batch-demo","<reviewed plan path>"]`. Set `XRAY_PERSONAL_BATCH_PROJECTS`, `XRAY_PERSONAL_BATCH_TENANT`, `XRAY_PERSONAL_BATCH_XRAY_ORIGIN`, and `XRAY_PERSONAL_BATCH_DIGEST` from the separately reviewed authorization. The digest is supplied by the session setup from the reviewed evidence, with no fingerprint to type during confirmation. Keep these overrides out of the default registration. Use the existing private Jira and Xray credential configuration.

Allowlist the read tools and `xray_prepare_story_publication`, `xray_publish_story`, and `xray_get_story_publication` only for that session. The natural-language request must identify the authorized batch. The server checks the pinned plan file and submitted plan before the prompt, after acceptance, before batch start, and before dispatching a child write. An existing execution for the Story and case IDs, unresolved journal lock, or orphan snapshot stops the preflight. The one native form is the approval prompt. After Allow, dispatch once with the unchanged plan and returned connector approval. The scoped session has no resume tool. Use read-only status and Jira/Xray readback for any uncertain result.

The machine-local `.codex/config.toml` registers `xray_website` automatically when opening this trusted project in Codex. Its explicit tool allowlist contains only Xray search, Test details, and coverage. It disables the inherited legacy Xray connector for this project. The registration contains no credentials and is ignored by Git.

To verify native confirmation in a fresh Codex session without credentials or remote access, launch the same connector in synthetic probe mode:

```powershell
Set-Location 'C:\Users\renukadhamankar\agentic-demo-website'
codex -c 'mcp_servers.xray_website.command="node"' `
      -c 'mcp_servers.xray_website.args=["--import","tsx","tools/xray-mcp/src/integrations/xray-mcp/server.ts","--personal-batch-probe"]' `
      -c 'mcp_servers.xray_website.enabled_tools=["xray_prepare_story_publication"]'
```

In that session, ask Codex to read `tools/xray-mcp/confirmation-fixture.json` and call only `xray_website.xray_prepare_story_publication` with the file contents as `plan`. Run the prompt three times and choose Accept, Decline, then Cancel. Each completed call returns `NO_WRITE_PROBE` and the corresponding decision. If cancelling ends the turn before a result arrives, record that UI behavior. The probe neither loads the credential file nor registers publish or resume tools, and it cannot issue an approval ID. It takes precedence over the live opt-in flag.

The opt-in mode trusts the private local stdio connection and the user's Codex session. It provides no independent human identity proof and is unsuitable for shared or production environments. Its approval and execution records live under the local user's application-data directory in a namespace derived from the configured Jira and Xray origins. Declined or cancelled requests leave no usable approval. A valid Accept authorizes the exact reviewed plan for up to two minutes and only within the same connector session.

The existing batch publisher independently validates and atomically consumes the approval. It checks project and Story metadata, duplicates and coverage, and records individual attempts with readback. If an operation is uncertain, inspect the execution and remote state. The existing recovery path blocks automatic retries of uncertain writes. A completed batch can be read back by execution ID. KAN-29 and KAN-30 are blocked while paused.

Live enabling and an actual reviewed batch confirmation remain separate decisions. Offline tests use synthetic data and intercepted adapter calls.

Agent 08 routes through `xray_website` in `read-only-integration` mode. Real stories use read tools and local planning only. The synthetic fixture is the only batch submitted to the confirmation probe. Agent 08 keeps publication pending in this phase and cannot use a probe decision to dispatch or resume a write.
