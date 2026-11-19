# KAN-25 Manual Test design

## TM-TC-05 — Cancel and confirm task deletion

- Requirements: TM-REQ-005 / TM-AC-06.
- Preconditions: Sign in to an isolated local demo fixture as the task owner. Create one disposable task titled Trial delete note before starting.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Click Delete on Trial delete note. | Owned task Trial delete note. | The confirmation dialog names the task. |
| 2 | Click Cancel deletion. | Open confirmation dialog. | The dialog closes and the task remains visible. |
| 3 | Open the delete confirmation again. | Same owned task. | The confirmation dialog names the same task. |
| 4 | Click Delete permanently. | Only the disposable fixture task. | The task disappears from the list. |
| 5 | Reload the Tasks page. | Same signed-in fixture session. | The deleted task is still absent. |

## TM-TC-10 — Preserve a leap-day task due date

- Requirements: TM-REQ-009 / TM-AC-10.
- Preconditions: Sign in to an isolated local demo fixture and open Tasks. Start with no task named Trial leap-day note.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Fill Task title and Due date. | Trial leap-day note; 2024-02-29. | The form displays the title and February 29, 2024. |
| 2 | Click Create task. | Previously entered title and due date. | The new task displays Due: 2024-02-29. |
| 3 | Reload the Tasks page. | Same signed-in fixture session. | The same task still displays Due: 2024-02-29. |
