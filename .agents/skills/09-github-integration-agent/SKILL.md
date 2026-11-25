---
name: github-integration-agent
description: Read GitHub context and prepare reviewable repository changes and PR descriptions after local QA completion.
---

# GitHub Integration Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Verify the target is agentic-demo-website; never operate on older repositories. Inspect existing user changes and do not stage unrelated files. This repository initially has many untracked application files: a local file manifest/hash baseline is required when a meaningful Git diff is unavailable. After all local gates pass, prepare an exact proposed file scope, diff and PR body with validation and limitations. For `qa branch`, check the approved base and branch name and obtain scoped approval before creating the local branch. Stage and commit only after their separate local approvals. For `qa pr`, obtain the owner's explicit `OK` on the exact push preview and verify the remote branch. Then obtain a separate `OK` on the exact PR preview and verify the resulting PR. The owner merges manually. Hand confirmed PR and merge evidence back to the orchestrator for closeout.

## Optional remote branch cleanup

After verifying a PR merge and its existing post-merge validation, automatically assess the PR's same-repository source branch. Require a merged PR into the verified remote default branch, the live source ref at the reviewed PR head SHA, and proof that this exact tip is reachable from current remote `main`. Keep branches whose commits are outside `main`, including squash or rebase cases without that ancestry. Exclude `main`, default and protected branches, unrelated branches, and any branch with an open PR as head or base, an active workflow or deployment reference, a registered worktree using its corresponding local branch, or another known active dependency. If required evidence is unavailable, report the missing check without offering deletion. An absent ref needs no action.

For an eligible branch, hand the exact optional deletion preview to the orchestrator for **What's next?** Include repository, PR, remote, full ref, expected tip SHA, and verification findings. Offer one explicit owner `OK` for that exact deletion. No earlier approval applies. After approval, recheck eligibility and freshness. Delete only that remote ref with an expected-tip lease, using `git push --force-with-lease=refs/heads/<branch>:<expected-tip> <remote> :refs/heads/<branch>` when the verified Git transport is available. Never use a broader force or deletion command. If the branch moved or approval scope changed, stop and re-preview only if eligible. Confirm successful deletion with a successful remote ref query showing the branch absent. If the outcome is uncertain, reconcile by read before proposing a retry. Leave local branches and worktrees intact. Cleanup is optional and independent of Jira closeout.

## Inputs

Verified repository identity, local diff/file manifest, source revision, QA report and later explicit write approval.

## Outputs

Local change summary and PR draft; after separately approved actions, verified commit/branch/PR references. Use the [artifact templates](../../../docs/agent-framework/README.md#workflow-and-artifact-contract); hand off paths, revisions, status and blockers to the orchestrator.

## MCP tools or dependencies

GitHub MCP read tools; local Git and discovered write tools only with scoped approval. See [integration limits](../../../docs/agent-framework/mcp-integrations.md).

## Allowed autonomous actions

Read authorized metadata and diffs and generate local review artifacts.

## Actions requiring human approval

Local branch creation, staging, commits and destructive Git operations require scoped approval. Push and PR creation each require the owner's explicit `OK` on the latest exact preview. The owner performs merges manually.

## Validation requirements

Check repository/base/head identity, exact approved file scope, absence of secrets and current QA evidence. Read back remote branch/PR state after approved actions.

## Error handling

On conflicts or uncertain writes stop and report; do not reset user work, force-push or retry PR creation blindly. Missing write capability does not justify a browser/API bypass. Preserve sanitized evidence; never expose credentials in diagnostics.
