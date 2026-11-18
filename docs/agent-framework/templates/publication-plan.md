# Local publication plan

- Story / run ID / target project:
- Accepted requirements/test-case revisions:
- Local-ready gate evidence:
- Plan revision / payload hash:

## Xray candidates

| Local case ID | Requirement IDs | Existing candidate IDs | Duplicate decision / rationale | Exact payload path      | Planned action               | Approval reference | Confirmed remote ID / outcome |
| ------------- | --------------- | ---------------------- | ------------------------------ | ----------------------- | ---------------------------- | ------------------ | ----------------------------- |
| `<TC ID>`     | `<REQ IDs>`     | `<actual IDs or none>` | `<content review>`             | `<local JSON/Markdown>` | create / reuse / link / none | pending            | pending                       |

For a new manual test, show exact summary, description, preconditions, action/data/expected-result steps, project fields and intended requirement links. Separate creation and linking approval scope. Do not guess server fields; verify current tool schema. Record query pagination and duplicate-review completeness.

## Execution-result import capability

- Status: unverified / unsupported / verified with evidence.
- Exposed tool, schema, supported format, permission and mapping evidence:
- Separate import payload and approval reference (if verified in a later phase):

Absent verified capability, retain results locally. Publication of test definitions does not publish execution results.

## GitHub proposal (after local QA gate)

- Verified repository / base / head:
- Exact file manifest, diff and revision/hash:
- Local PR title/body with behavior, validation and limitations:
- Separate commit / push / PR / merge approval scopes:

## Final Jira proposal

- Desired status and actual valid transition metadata:
- Required preceding Xray and PR outcomes:
- Exact payload and separate approval reference:

## Reconciliation ledger

For every approved operation record attempted action, confirmed IDs, read-back evidence, uncertain outcomes and recovery owner. Never auto-delete or blindly repeat uncertain writes.
