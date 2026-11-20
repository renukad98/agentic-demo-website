# KAN-39 requirements

- Story source: https://renudhamankar98.atlassian.net/browse/KAN-39
- Jira issue ID: 10079. Status at retrieval: To Do. Source revision: 2026-11-20T15:12:50.392+0530.
- Retrieved at approximately 2026-11-20T15:18:00+05:30. Jira returned no issue links.
- Run: requirements-01. Artifact revision: 1. Role: Requirements Analysis Agent.
- Local source baseline: 77b4f70767f999fd983bcddbebe4b37aa927f5a6.
- Scope: confirmed bulk deletion on the authenticated task list. Implementation is subject to the repository's application-edit gate.

## Source acceptance criteria

The source has six bullets without IDs. The IDs below follow the Jira bullet order.

- **KAN-39-AC-001** — The task list offers a “Clear completed tasks” button when the signed-in user has completed tasks.
- **KAN-39-AC-002** — Selecting the button shows a confirmation that all of the user’s completed tasks will be deleted.
- **KAN-39-AC-003** — Confirming deletes all completed tasks owned by the signed-in user, including completed tasks outside the current filtered view. Incomplete tasks and other users’ tasks are preserved.
- **KAN-39-AC-004** — Canceling or dismissing the confirmation leaves all tasks intact.
- **KAN-39-AC-005** — After successful deletion, the task list updates and the deleted tasks remain absent after reload.
- **KAN-39-AC-006** — When there are no completed tasks, the button is unavailable.

| Requirement ID | Source criterion | Behavior and measurable oracle | Risk | Status |
| --- | --- | --- | --- | --- |
| KAN-39-REQ-001 | KAN-39-AC-001 | With a signed-in owner who has at least one Completed task, the task list exposes an enabled button named **Clear completed tasks**. A filtered view hiding the completed task still allows the action. | High | Resolved from Jira |
| KAN-39-REQ-002 | KAN-39-AC-002 | Activating the button displays a confirmation that explicitly says all of the signed-in user's completed tasks will be deleted. Task IDs remain present until confirmation. | High | Resolved from Jira |
| KAN-39-REQ-003 | KAN-39-AC-003 | With two completed tasks owned by A (one excluded by the current view), a pending task owned by A, and tasks owned by B, A confirms. Both completed A IDs are removed from persisted data. A's pending task and all B records remain intact. | Critical | Resolved from Jira |
| KAN-39-REQ-004 | KAN-39-AC-004 | For both explicit cancellation and dialog dismissal, all pre-action task IDs and records remain present after refresh. The confirmation closes. | High | Resolved from Jira |
| KAN-39-REQ-005 | KAN-39-AC-005 | After a successful confirmed delete, the task list updates without requiring a manual reload. After reload the deleted IDs are still absent and surviving tasks are available. | High | Resolved from Jira |
| KAN-39-REQ-006 | KAN-39-AC-006 | For an empty or pending-only owner list and after removal of the last completed task, the bulk button cannot be activated. A separate user's completed tasks do not affect availability. | Medium | Resolved from Jira |

## Relevant constraints and coverage obligations

- **Authorization and validation.** The current API derives ownership from the session and applies CSRF checks to writes. Cover unauthenticated and invalid-CSRF bulk attempts with no task changes. Scope the delete by session owner and Completed status on the server. A view, client-supplied owner, or list of visible IDs cannot define deletion scope.
- **Persistence and failure.** The task store already serializes writes. Verify durable deletion and preservation of unrelated records. Cover a persistence failure with no false success or partially applied bulk deletion. Cover an already-empty scope or a repeated request with no additional data changes.
- **Accessibility.** Verify keyboard activation, an accessible confirmation with distinct confirm and cancel controls, keyboard dismissal, and sensible focus after closing, including when deletion removes the button from the tab order.
- **Regression.** Cover the existing single-task delete, complete and reopen behavior. Use synthetic owners and data. Verify that deleting from a filtered view leaves surviving tasks consistent with the active view. Use that condition when a filtered view is available in the implementation baseline. Coverage of server-side ownership and status applies in every baseline.

## Questions and decisions

| Question | Impact | Owner | Decision evidence | Status |
| --- | --- | --- | --- | --- |
| Does all include tasks excluded by the current view? | REQ-001, REQ-003 | Story owner | AC-003 includes completed tasks outside the view. Availability follows the owner's completed tasks. | Resolved |
| Must the unavailable action be hidden or disabled? | REQ-006 | Feature Development | AC-006 requires unavailability. Either presentation satisfies the oracle. | Implementation detail |
| How should the confirmation or failure message be worded? | REQ-002 and failure coverage | Feature Development | AC-002 requires explicit deletion scope. Exact wording may follow existing task UI conventions. | Implementation detail |

## Handoff

- Requirements and initial traceability are under `artifacts/qa/KAN-39/requirements-01/`.
- Analysis gate ready for Test Design. Six source criteria have observable oracles. No blocking product decisions identified. Requirements and design acceptance remain subject to the delivery policy.
