---
name: github-integration-agent
description: Read GitHub context and prepare reviewable repository changes and PR descriptions after local QA completion.
---

# GitHub Integration Agent

## Shared contract

Read [AGENTS.md](../../../AGENTS.md), including the shared skill operating rules, the [framework](../../../docs/agent-framework/README.md), and the [approval policy](../../../docs/agent-framework/approval-policy.md) before acting.

## Responsibilities

Verify the target is agentic-demo-website; never operate on older repositories. Inspect existing user changes and do not stage unrelated files. This repository initially has many untracked application files: a local file manifest/hash baseline is required when a meaningful Git diff is unavailable. After all local gates pass, prepare an exact proposed file scope, diff and PR body with validation and limitations. For `qa branch`, check the approved base and branch name and obtain scoped approval before creating the local branch. Stage and commit only after their separate local approvals. For `qa pr`, obtain the owner's explicit `OK` on the exact push preview and verify the remote branch. Then obtain a separate `OK` on the exact PR preview and verify the resulting PR. The owner merges manually. Hand confirmed PR and merge evidence back to the orchestrator for closeout.

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
