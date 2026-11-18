# MCP integration inventory and limits

Phase 5E-B: the repository-local adapter now implements HTTP/authentication and allowlisted reads; see [read-only adapter](xray-read-only-adapter.md). It is not registered as MCP or supplied production credentials. Live adapter connectivity remains BLOCKED; previous MCP read success is separate. Historical phase-specific statements below do not imply the new transport is authenticated. No MCP configuration or older server was changed.

User-provided successful verification is the baseline, not a new verification performed by this framework. No live external reads or writes were needed for this documentation phase. Tool availability was inspected through the current session's exposed tool metadata; discover schemas again before future use.

| Integration                  | Verified baseline                                     | Framework use                                                                 | Remaining limits                                                                                                      |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GitHub MCP                   | Authentication and read-only repository access passed | Read files, issues, PR metadata and diffs in the authorized repository        | No write permission or remote target inferred; commit/push/PR/merge need explicit approval                            |
| Atlassian Jira `atlassian-2` | KAN project and KAN-7 retrieved                       | Read story fields, acceptance criteria, links and available workflow metadata | No issue creation, edit, comment or transition in Phase 2B; never assume transition IDs                               |
| Playwright MCP               | Navigation and page inspection passed                 | Inspect authorized test UI and help develop repeatable browser cases          | No persisted Playwright runner/config/package exists in this project; inspection is not automated regression coverage |
| Xray MCP                     | Live read-only KAN search returned 11 tests           | Read/search existing tests and coverage, assess duplicate candidates          | Count is a historical snapshot; publication and result import are not verified by search                              |

Tools may appear through different connector namespaces. Match the available tool schema and account, not a hardcoded endpoint or guessed argument. Never inspect or export authentication configuration, secret values or session cookies. Record tool names, sanitized query scope, timestamps and pagination completeness in future reports. Do not treat successful authentication as permission to mutate.

## Current Xray setup

The existing MCP server runs from an older repository, per the user's verification context. This phase does not inspect that repository, copy or relocate the server, modify its safeguards, or change its configuration. Its local demo approval safeguards are not production authorization.

Read tools exposed in this session include `xray_search_tests`, `xray_get_test`, `xray_get_test_coverage`, `xray_inspect_story_duplicates` and `xray_get_story_publication`. Inspect schemas, pagination and ID types before use; for example, get-test expects a positive numeric Jira issue ID rather than assuming a KAN key is accepted.

Other exposed tools include `xray_prepare_manual_test_preview`, `xray_prepare_test_link_preview`, `xray_prepare_story_publication`, `xray_create_manual_test`, `xray_create_test_link`, `xray_publish_story` and `xray_resume_story_publication`. They are inventory only, not exercised or authorized here. Preview/preparation calls can persist local approval state. Do not invoke them during this phase. Demo approval IDs never replace explicit human approval, and uncertain writes must be reconciled before resume.

No execution-result import tool is exposed in this session. Do not assume JUnit, Cucumber, Playwright or other result import works. Keep execution results local until a later phase verifies an actual capability, supported format/schema, project permissions, test-ID mapping, duplicate handling and read-back behavior in an authorized test environment. No import adapter is implemented here.

## Proposed later repository-local integration

1. Obtain explicit approval and define a migration boundary; leave the older repositories untouched. Inventory the existing server interface through authorized documentation or access, not by copying credentials or server files.
2. Design a separately approved adapter under this repository (for example `tools/xray-mcp/`), with locked dependencies, a versioned tool contract, read-only defaults and sanitized logs. This path is a proposal; it is not created now.
3. Configure secrets through the approved environment/secret mechanism; document variable names only. Never put values in source, approval artifacts, browser traces or reports. Add repository-local MCP configuration only after schema and trust behavior are checked; do not overwrite user/global settings.
4. Replace demo-only trust with production-grade exact-payload human authorization, expiration, replay prevention, persistent operation state, duplicate checks, pagination and ambiguous-write reconciliation. Test these with mocks before any authorized sandbox writes.
5. Verify test reads first. Verify test publication, linking and execution-result import as separate capabilities, each with scoped approval and read-back evidence. An unavailable import remains unsupported.
6. Propose a reviewed cutover and rollback plan. Change client registration only when explicitly authorized. Do not remove or edit the older server as an incidental cleanup step.

## Phase 5D update

The repository-local adapter in tools/xray implements contracts, pure proposals, result normalization, mocked read transport and recovery validation. It has no live HTTP/authentication implementation; publication always rejects. No MCP registration or configuration changed. The existing Playwright runner is installed/configured; the older no-runner statement above is historical. See [current framework](phase5d-framework.md).
