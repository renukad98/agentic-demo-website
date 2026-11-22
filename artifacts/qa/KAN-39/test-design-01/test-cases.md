# KAN-39 test design

- Run test-design-01, design revision 1, Test Design Agent. Review pending.
- Inputs: requirements-01 revision 1, Jira revision 2026-11-20T15:12:50.392+0530, baseline 77b4f70767f999fd983bcddbebe4b37aa927f5a6.
- Use an isolated local test app, temporary storage and synthetic owners A and B. C records are Completed, P records are Pending. Give every record a distinct ID and title. Reset sessions and data between cases and variants. Close contexts and dispose of temporary storage after each case.
- Browser cases are proposed for Playwright. HTTP integration cases are proposed for the application suite. Automation is pending for all ten cases.

## KAN-39-TC-001 — Open the bulk confirmation

- Requirements: KAN-39-REQ-001 / KAN-39-AC-001, KAN-39-REQ-002 / KAN-39-AC-002.
- Proposed level: Browser. Risk: High.
- Preconditions: A owns completed C1 and pending P1.
- Planned test title: KAN-39-TC-001 Open the bulk confirmation.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Open Tasks as A | C1 and P1 | Clear completed tasks is enabled. |
| 2 | Tab to the button | Keyboard | The button has visible focus. |
| 3 | Press Enter | Focused button | A named confirmation says all of A's completed tasks will be deleted. Confirm and Cancel are reachable. No delete request is sent. |

## KAN-39-TC-002 — Confirm and reload

- Requirements: KAN-39-REQ-003 / KAN-39-AC-003, KAN-39-REQ-005 / KAN-39-AC-005, KAN-39-REQ-006 / KAN-39-AC-006.
- Proposed level: Browser. Risk: High.
- Preconditions: A owns completed C1 and C2 and pending P1. Start with the bulk confirmation open.
- Planned test title: KAN-39-TC-002 Confirm and reload.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Confirm | A's confirmation | C1 and C2 disappear immediately after success, P1 remains, and the bulk button is unavailable. Focus moves to a usable visible control. |
| 2 | Reload Tasks | Same session | C1 and C2 remain absent and P1 remains visible. |

## KAN-39-TC-003 — Cancel or dismiss

- Requirements: KAN-39-REQ-004 / KAN-39-AC-004.
- Proposed level: Browser. Risk: High.
- Preconditions: A owns C1 and P1. Reset the fixture and open the confirmation for each variant.
- Planned test title: KAN-39-TC-003 Cancel or dismiss.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Close the confirmation | Cancel or Escape, independently | Dialog closes, focus returns to the trigger, and no delete request is sent. |
| 2 | Reload Tasks | Same session | Both C1 and P1 are still present. |

## KAN-39-TC-004 — Check unavailability with no owned completed tasks

- Requirements: KAN-39-REQ-006 / KAN-39-AC-006.
- Proposed level: Browser. Risk: Medium.
- Preconditions: Run independently with A having zero tasks and with only pending P1. B owns completed C3 in both variants.
- Planned test title: KAN-39-TC-004 Check unavailability with no owned completed tasks.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Open Tasks as A | Each fixture variant | The bulk button is hidden or disabled and cannot open a confirmation. |

## KAN-39-TC-005 — Clear only the signed-in user's completed tasks

- Requirements: KAN-39-REQ-001 / KAN-39-AC-001, KAN-39-REQ-003 / KAN-39-AC-003, KAN-39-REQ-005 / KAN-39-AC-005.
- Proposed level: Browser. Risk: Critical.
- Preconditions: A owns completed C1 and C2 and pending P1. B owns completed C3 and pending P2. Use separate sessions.
- Planned test title: KAN-39-TC-005: Clear only the signed-in user's completed tasks.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Open Tasks as A. | A's session | C1, C2, and P1 are visible. Clear completed tasks is enabled. |
| 2 | Select Clear completed tasks. | A's task list | A confirmation opens and states that all of A’s completed tasks will be deleted. |
| 3 | Confirm the deletion | A's confirmation | C1 and C2 disappear. P1 remains, and Clear completed tasks becomes unavailable. |
| 4 | Reload Tasks as A. | A's session | C1 and C2 remain absent. P1 is still present. |
| 5 | Open Tasks as B in the separate session. | B's session | C3 is still Completed and P2 is still Pending. |

## KAN-39-TC-006 — Verify ownership and durability

- Requirements: KAN-39-REQ-003 / KAN-39-AC-003, KAN-39-REQ-005 / KAN-39-AC-005.
- Proposed level: HTTP integration. Risk: Critical.
- Preconditions: A owns completed C1 and C2 and pending P1. B owns completed C3 and pending P2. Save the full original records.
- Planned test title: KAN-39-TC-006 Verify ownership and durability.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Submit bulk delete | A session and valid CSRF | The operation succeeds. |
| 2 | Read A's tasks through a fresh app instance | Same isolated storage | Only unchanged P1 remains. |
| 3 | Read B's tasks | B session | C3 and P2 match the original records. |

## KAN-39-TC-007 — Reject unauthorized bulk deletion

- Requirements: KAN-39-REQ-003 / KAN-39-AC-003.
- Proposed level: HTTP integration. Risk: Critical.
- Preconditions: Reset the same mixed-owner fixture for each variant and save storage bytes.
- Planned test title: KAN-39-TC-007 Reject unauthorized bulk deletion.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Submit bulk delete without an active session | Valid CSRF | Response is 401 and stored bytes are unchanged. |
| 2 | Submit bulk delete with invalid CSRF | A session with missing or incorrect CSRF, independently | Response is 403 and stored bytes are unchanged. |

## KAN-39-TC-008 — Repeat deletion against an empty scope

- Requirements: KAN-39-REQ-003 / KAN-39-AC-003, KAN-39-REQ-006 / KAN-39-AC-006.
- Proposed level: HTTP integration. Risk: Medium.
- Preconditions: A initially owned C1 and P1. Successful bulk deletion has removed C1. B has C3.
- Planned test title: KAN-39-TC-008 Repeat deletion against an empty scope.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Repeat the bulk request | A session and valid CSRF | No additional records change. A's P1 and B's C3 remain intact. |

## KAN-39-TC-009 — Preserve storage on write failure

- Requirements: KAN-39-REQ-003 / KAN-39-AC-003, KAN-39-REQ-005 / KAN-39-AC-005.
- Proposed level: HTTP integration. Risk: High.
- Preconditions: A owns C1, C2 and P1. B owns C3. Inject a write or rename failure and retain original bytes.
- Planned test title: KAN-39-TC-009 Preserve storage on write failure.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Submit bulk delete | Valid A request | Response reports failure without success. Original storage bytes are intact. |
| 2 | Read records from a fresh app instance | Same isolated storage | All original records remain. |

## KAN-39-TC-010 — Report deletion failure without hiding tasks

- Requirements: KAN-39-REQ-005 / KAN-39-AC-005.
- Proposed level: Browser. Risk: High.
- Preconditions: A owns C1 and P1. Open the confirmation and inject a definite server failure.
- Planned test title: KAN-39-TC-010 Report deletion failure without hiding tasks.

| Step | Action | Test data | Expected observable result |
| --- | --- | --- | --- |
| 1 | Confirm | Injected write failure | An error is visible, no success is announced, and C1 and P1 remain visible. |
| 2 | Reload Tasks | Same session after clearing injection | C1 and P1 are present. |

## Coverage and review

- TC-005 verifies owner isolation in two browser sessions. TC-006 independently verifies server-side ownership, status and persistence.
- Reuse existing lifecycle cases in tests/tasks.api.test.ts and tests/e2e/tasks.lifecycle.spec.ts for single-task delete, complete and reopen regressions. Reuse fixture patterns from tests/tasks.security.test.ts and failure injection from tests/tasks.store.test.ts for the bulk-specific tests.
- Review pending. See traceability.csv for the requirements mapping and the conditional case.
