# Agent framework — Phase 5D

Phase 5E-C1 adds [local Generic publication readiness](xray-publication-readiness.md): durable identity binding, explicit Reporter fields, exact inert proposals, trusted approval-consumption interfaces and journal duplicate/recovery guards. The selected real proposal is blocked pending Reporter confirmation; publication stays disabled.

Phase 5E-B adds the [secure read-only Xray transport](xray-read-only-adapter.md): approved external credential references, in-memory authentication, fixed read operations and bounded pagination. Live adapter access remains blocked until a credential source and tenant endpoint are explicitly authorized/confirmed. Publication is still disabled; Phase 5D notes below describe the original framework delivery.

Current Phase 5D implementation and operating instructions: [Reusable framework](phase5d-framework.md). Local coordinator/contracts, identity mapping, normalizers and mock-tested Xray planning are implemented; remote writes remain disabled. The historical setup notes below must be read with the current scope.

This repository uses root `AGENTS.md` for durable Codex instructions and ten reusable role skills under `.agents/skills/`. This is an instruction framework, with manual/sequential orchestration, not a new application feature or autonomous service. Phase 5D preserves website behavior and dependencies; framework tests and instructions are added.

## Codex compatibility and use

The official [AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md/) documents repository instruction discovery. The official [skills guide](https://developers.openai.com/codex/skills/) documents repository `.agents/skills/<name>/SKILL.md` discovery and required `name`/`description` frontmatter. Checked on 2026-11-15. GitHub Copilot `.agent.md` files are not used or assumed to be Codex role definitions.

Open this repository as the workspace in Codex for VS Code. Select a skill with `$` or `/skills`, for example:

```text
Use $qa-orchestrator to inspect the readiness of this repository for Phase 3.
Produce a local readiness report only; do not implement Task Management or publish anything.
```

For a bounded task: `Use $test-review-agent to review <local test-design path> against <requirements path>. Produce a local review only.` If discovery has not refreshed, restart Codex and verify the skills list. You can explicitly ask Codex to read a role's `SKILL.md` by repository path as a fallback. This delivery validates files, not the installed VS Code extension's discovery UI. No global configuration is changed.

## Roles

| Skill                                                                                             | Responsibility                                                         |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [jira-story-agent](../../.agents/skills/01-jira-story-agent/SKILL.md)                             | Retrieve source stories; prepare eventual status-change proposals      |
| [requirements-analysis-agent](../../.agents/skills/02-requirements-analysis-agent/SKILL.md)       | Derive testable requirements and resolve ambiguities                   |
| [test-design-agent](../../.agents/skills/04-test-design-agent/SKILL.md)                           | Design cases and coverage                                              |
| [test-review-agent](../../.agents/skills/05-test-review-agent/SKILL.md)                           | Review coverage, oracles and test quality                              |
| [feature-development-agent](../../.agents/skills/03-feature-development-agent/SKILL.md)           | Implement approved behavior and associated automated tests             |
| [playwright-automation-agent](../../.agents/skills/06-playwright-automation-agent/SKILL.md)       | Implement repeatable browser automation                                |
| [test-execution-reporting-agent](../../.agents/skills/07-test-execution-reporting-agent/SKILL.md) | Execute checks and analyze evidence                                    |
| [xray-test-publisher-agent](../../.agents/skills/08-xray-test-publisher-agent/SKILL.md)           | Prepare reviewed payloads; publish only when separately approved       |
| [github-integration-agent](../../.agents/skills/09-github-integration-agent/SKILL.md)             | Read repository metadata; prepare reviewed GitHub changes              |
| [qa-orchestrator](../../.agents/skills/10-qa-orchestrator/SKILL.md)                               | Own handoffs, evidence, approval gates and final readiness             |

Each skill defines responsibilities, inputs, outputs, dependencies, autonomous scope, approval requirements, validation, and error handling. All roles inherit the [approval policy](approval-policy.md); credentials and external write permissions are never supplied by skill invocation.

## Workflow and artifact contract

Jira Story → Requirements Analysis → Test Design → Design Review and implementation approval → Feature Development with unit/API tests → Playwright Automation → Coverage/Test Review → Test Execution → separately approved Xray stages → separately approved GitHub delivery.

Test Design precedes development. Development includes associated unit/API tests immediately. Feature Development maps those tests to approved cases and fills non-browser gaps. Playwright Automation owns browser tests and receives the approved browser case list from Feature Development. Test Design subsequently checks and extends coverage; review and execution can send work back to development or design. Browser automation implements reviewed cases. This sequence does not postpone developers' tests until the QA stage.

For future approved work, keep a run under `artifacts/qa/<story-key>/<run-id>/` inside this repository, outside served assets. Run IDs must be unique. Do not create feature artifacts during Phase 2B just to suggest work has begun. Use these templates:

- [Requirements](templates/requirements.md): source snapshot, stable requirement IDs, acceptance oracles and questions.
- [Test design](templates/test-cases.md): preconditions, data, actions, expected results and review.
- [Traceability](templates/traceability.csv): one row per requirement/test relation and execution result.
- [Run report](templates/run-report.md): handoff status, commands, result analysis and gate decision.
- [Approval request](templates/approval-request.md): exact operation, payload, scope and human response.
- [Publication plan](templates/publication-plan.md): deduplication, candidate payloads and verified remote outcomes.

Use stable IDs such as `<story>-REQ-001` and `<story>-TC-001`, preserving them through revisions. Record source revision or sanitized content fingerprint, and implementation/test file hashes when there is no commit. A traceability row relates a requirement to a case, automation file/test title, run, evidence and eventual Xray ID. Do not invent remote IDs. Multiple rows are expected for many-to-many coverage. `not-run`, `blocked`, `failed`, `passed` and `skipped` are distinct results. Uncovered requirements remain visible with empty test references and a blocking explanation.

## Local completion gate

Before proposing GitHub delivery or using the separate Xray batch routes, require resolved requirements, implementation and automated tests, accepted review, persisted and executed Playwright tests, passing regression checks, completed mappings, and failure analysis. The default `qa xray [STORY-KEY]` chat-approved route may publish Manual Test definitions and same-Story links after accepted design review. The feature record's `published` stage records completion of that publication while its pending stages continue to track development and execution.

External stages are separate optional approval gates. They cannot run in Phase 2B. If any stage is declined, unsupported or blocked, retain a local-ready report and mark downstream stages pending; do not claim the full workflow completed. See [MCP integrations](mcp-integrations.md), [approval workflow](approval-policy.md), and [Phase 2B validation](validation.md).

## Historical Phase 2B next-phase notes

Obtain explicit Phase 3 scope for Task Management creation, viewing, editing, completion and deletion. First clarify ownership/access, persistence, field validation, completion semantics, deletion behavior and acceptance criteria using read-only source retrieval and local requirements analysis. No CRUD implementation is included here.
