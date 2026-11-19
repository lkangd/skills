---
name: create-dev-worktree
disable-model-invocation: true
description: Create a dev branch worktree, VS Code workspace, and cmux workspace
argument-hint: <branch-name>
allowed-tools:
  - Bash(bash:*)
---

Use the arguments supplied with the skill invocation.

Claude Code plugin install path: `${CLAUDE_PLUGIN_ROOT}`.

Read [Bundled files](../../references/bundled-files.md) to resolve the plugin root and project working directory.

Claude Code arguments: `$ARGUMENTS`

## Goal

Create a sibling git worktree for the current repository using the required branch name, then create or update a sibling VS Code workspace named `<branch-name>.code-workspace`, then create or reuse a cmux workspace with the same name and split panes so each worktree has a stacked pair of terminals.

## Execute

Run the bundled workflow script once with the branch name as a single shell-quoted argument. Use its output to report the result.

```text
bash "<plugin-root>/scripts/create-dev-worktree.sh" "<branch-name>"
```

## Report

Reply concisely in Chinese:

1. State whether the worktree was created or already existed.
2. State the `.code-workspace` file path that was created or updated.
3. State the cmux workspace name and whether it was created, split, reused, or skipped.
4. If the script failed, explain the failing step and the exact next action. If the branch is missing from the invocation, show the skill syntax for the current host.
