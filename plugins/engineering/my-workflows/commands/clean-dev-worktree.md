---
description: Clean dev branch worktrees and VS Code workspace
argument-hint: <branch-name> [--force]
allowed-tools:
  - Bash(bash:*)
---

## Goal

Clean local development resources for branch `$ARGUMENTS` after the feature has gone live:

1. Inspect the sibling `$ARGUMENTS.code-workspace` file.
2. Clean every workspace folder whose path belongs to the target branch.
3. Remove each matching git worktree.
4. Delete the local branch in each related repository.
5. Delete the workspace file after all related worktrees and local branches are cleaned.

## Execute

Run the bundled cleanup script exactly once and use its output as the source of truth:

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/clean-dev-worktree.sh" "$ARGUMENTS"`

## Report

Reply concisely in Chinese:

1. If the script prints `STATUS: CLEANED`, summarize the result table.
2. If the script prints `STATUS: CONFIRMATION_REQUIRED`, do not run more commands. Explain why automatic deletion stopped and ask the user to confirm before using `--force`.
3. If the script prints `STATUS: ERROR`, explain the failed check and the exact next action.
