# QA run report

- Story / run ID / timestamp with timezone:
- Approved scope / authorization reference:
- Source revision and local implementation/test hashes (or commit):
- Environment: OS, Node/npm/browser versions, authorized base URL, isolated-data strategy.
- Requirements / test design / review / traceability paths and revisions:

## Stage ledger

| Stage                       | Owner                              | Input revision | Output path / revision | Status            | Blocker / next owner |
| --------------------------- | ---------------------------------- | -------------- | ---------------------- | ----------------- | -------------------- |
| Jira Story                  | Jira Story Agent                   |                |                        | pending           |                      |
| Requirements Analysis       | Requirements Analysis Agent        |                |                        | pending           |                      |
| Feature Development + tests | Feature Development Agent          |                |                        | pending           |                      |
| Test Design                 | Test Design Agent                  |                |                        | pending           |                      |
| Test Review                 | Test Review Agent                  |                |                        | pending           |                      |
| Playwright Automation       | Playwright Automation Agent        |                |                        | pending           |                      |
| Test Execution              | Test Execution and Reporting Agent |                |                        | pending           |                      |
| Xray Publication            | Xray Test Publisher Agent          |                |                        | awaiting approval |                      |
| GitHub Pull Request         | GitHub Integration Agent           |                |                        | awaiting approval |                      |
| Jira Status Update          | Jira Story Agent                   |                |                        | awaiting approval |                      |

Stage statuses: pending / in progress / complete / blocked / awaiting approval / declined. Keep optional external stages pending or declined when not performed.

## Execution evidence

| Command / tool and sanitized scope | Start / duration | Exit code       | Pass / fail / skip counts | Result                                        | Evidence path     |
| ---------------------------------- | ---------------- | --------------- | ------------------------- | --------------------------------------------- | ----------------- |
| `<actual command>`                 | `<time>`         | `<actual code>` | `<actual counts>`         | not-run / blocked / failed / passed / skipped | `<sanitized log>` |

## Result analysis

- Failures: product defect / test defect / environment blocker, impact and owner.
- First failure evidence / correction / rerun evidence:
- Regression comparison / flaky behavior:
- Requirement coverage: total, covered, passed, failed, blocked, uncovered.
- Unrun, skipped and unsupported checks with reasons:
- Sanitization: credentials, cookies, auth headers and private user data excluded.

## Gate decision

- Requirements resolved:
- Feature and associated automated tests implemented:
- Test design and review accepted:
- Playwright automation persisted and executed:
- Applicable regression/lint/format/typecheck/build checks passed:
- Traceability complete and evidence current:
- Remaining blockers / required next action:
- Local decision: ready / blocked. No required blocked, skipped or unrun check can pass.
- External stages: not proposed / awaiting explicit approval / declined / verified (with separate operation evidence).

## Approved-case implementation handoff

- Story, run, source revision or digest, and accepted design SHA-256
- Feature Development test references and fixture evidence
- Case ID, requirement and acceptance IDs, level, disposition, automation identity, exact path and title
- Browser cases and fixture requirements handed to Playwright Automation
- Manual or audit evidence route, coverage gaps, blockers and assigned owner
- Focused check evidence and review handoff
