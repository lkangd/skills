---
description: Create a dev branch worktree and VS Code workspace
argument-hint: <branch-name>
allowed-tools:
  - Bash(bash:*)
---

## Goal

Create a sibling git worktree for the current repository using branch `$ARGUMENTS`, then create or update a sibling VS Code workspace named `$ARGUMENTS.code-workspace`.

## Execute

Run the bundled workflow script exactly once and use its output as the source of truth:

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/create-dev-worktree.sh" "$ARGUMENTS"`

## Report

Reply concisely in Chinese:

1. State whether the worktree was created or already existed.
2. State the `.code-workspace` file path that was created or updated.
3. If the script failed, explain the failing step and the exact next action.
