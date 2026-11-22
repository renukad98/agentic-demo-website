# QA story defaults

- Start from `main`. Propose `feature/<story-key>-<slug>` and check for an existing branch before requesting approval. Keep unrelated working-tree changes out of the feature diff.
- Use the Jira story and reviewed requirements as the source of truth. Keep task access scoped to the signed-in owner. Use synthetic data and isolated local test services.
- Keep stable requirement and test IDs. Review the design before implementation. Add developer tests with the feature, map or implement approved non-browser cases with Agent 06, hand browser cases to Agent 07, review persisted automation before execution, and trace results to the tested revision.
- Keep private evidence and operation journals local. Use repository-relative evidence paths and record verified remote IDs only after readback.
- After the local QA gates pass, check for an existing Xray Test Plan before proposing one with the configured prefix. Map reviewed test cases to verified Jira Test keys. Use one Test Execution for the approved run and bind any import to the execution, Test keys, and verified evidence digest.
- Apply the repository approval policy and current scope at every gate. A pipeline file, status, or command never grants permission. Keep each external operation separately scoped and reconcile uncertain writes before any retry.
