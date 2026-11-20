# KAN-39 test design review

- Run: test-review-01. Reviewer: Test Review Agent, sequential self-review by the same Codex session that drafted the design.
- Decision: accepted for design.
- Jira KAN-39, issue ID 10079. Source revision checked against Jira: 2026-11-20T15:12:50.392+0530.
- Reviewed requirements: requirements-01 revision 1. Reviewed design: test-design-01 revision 1.
- testDesign 62634fdf94245c1dfb449fa130c567959c4a6c298b58c8708d3fa242ac6063b9
- Application baseline: 77b4f70767f999fd983bcddbebe4b37aa927f5a6.

## Findings

| ID | Case / requirements | Severity | Finding and action | Owner | Disposition |
| --- | --- | --- | --- | --- | --- |
| KAN-39-RV-001 | TC-005 / REQ-001, REQ-003, REQ-005 | Major coverage dependency | The current task page has no supported filter. Keep the browser case conditional and check the implementation baseline before automation or proposing this case for publication. TC-006 separately verifies owner/status scope and durability. | Playwright Automation / Test Review | Open for filtered-view execution. The design defines the expected behavior and records the gap explicitly. |
| KAN-39-RV-002 | TC-001, TC-003 / REQ-002, REQ-004 | Minor | For the no-delete assertion, register a request observer before the action and check it after observing the resulting dialog state. TC-003 also checks persisted state after reload. | Playwright Automation | Automation review follow-up. |
| KAN-39-RV-003 | TC-007, TC-009, TC-010 / REQ-003, REQ-005 | Minor | Exercise each unauthorized variant with an independent session and fixture. Use deterministic isolated write failure for persistence assertions. Distinguish browser error feedback from the HTTP assertion that original storage bytes survive. | Feature Development / Playwright Automation | Automation review follow-up. |

## Coverage and handoff

- Verified both directions of traceability across six acceptance criteria, six requirements, ten scenarios and 18 mappings. Every mapping names an existing case and matches its declared source criterion. All cases have numbered steps and observable results.
- Coverage includes confirm, cancel and Escape, empty and pending-only lists, repeated requests, cross-owner isolation, authentication, CSRF, durable deletion and failed writes. Fixtures use isolated storage with separate synthetic sessions and reset between variants.
- Reuse the existing task lifecycle tests for single-task delete, complete and reopen regression. The planned browser and HTTP cases exercise different observable outcomes for the bulk action.
- No blocking defect in the design. Filtered-view execution remains conditional as recorded above. Application and browser checks were not run. Automation assertions remain pending review.
- QA handoff: reviewed. Eligible unpaused Stories with pending Manual Test publication may proceed to an exact Xray preview. Apply the existing publication gates and evaluate conditional cases before including them.
