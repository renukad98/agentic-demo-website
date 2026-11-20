# KAN-39 test design revision review

- Prior review: test-review-01/review.md.
- Reason: KAN-39 AC3 removed the reference to tasks outside the current
  filtered view. KAN-44 was renamed and its Manual Test steps were revised
  to verify deletion scope using separate sessions for users A and B.
- Jira revisions: KAN-39 2026-11-20T16:11:06.988+0530,
  KAN-44 2026-11-20T16:16:31.687+0530.
- testDesign 7dc745a3f2defe579fc6a032ae6b8f82527563a04f6d00ed7346d784e3af7ff0
- TC-005 runs without a filter or conditional skip. The focused Chromium run
  passed and verified that A's pending task and B's tasks were preserved.
- KAN-39-RV-001: resolved by the revised criterion and test.
- Decision: accepted for design.
