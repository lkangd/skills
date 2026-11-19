---
name: clean-dev-worktree
disable-model-invocation: true
description: Clean dev branch worktrees and VS Code workspace
argument-hint: <branch-name> [--force]
allowed-tools:
  - Bash(bash:*)
---

Use the arguments supplied with the skill invocation.

Claude Code plugin install path: `${CLAUDE_PLUGIN_ROOT}`.

Read [Bundled files](../../references/bundled-files.md) to resolve the plugin root and project working directory.

Claude Code arguments: `$ARGUMENTS`

## Goal

Clean local development resources for a required branch name and an optional `--force` (`-f`) flag after the feature has gone live:

1. Inspect the sibling `<branch-name>.code-workspace` file.
2. Clean every workspace folder whose path belongs to the target branch.
3. Close the cmux workspace named after the branch once the preflight checks pass, before anything is removed.
4. Remove each matching git worktree.
5. Delete the local branch in each related repository.
6. Delete the workspace file after all related worktrees and local branches are cleaned.

## Execute

Run the bundled cleanup script once with the branch and any supplied force flag together as one shell-quoted argument. Use its output to report the result.

```text
bash "<plugin-root>/scripts/clean-dev-worktree.sh" "<branch-name> [--force]"
```

## Report

Reply concisely in Chinese:

1. If the script prints `STATUS: CLEANED`, summarize the result table.
2. If the script prints `STATUS: CONFIRMATION_REQUIRED`, do not run more commands. Explain why automatic deletion stopped and ask the user to confirm before using `--force`. Give the retry invocation for the current host.
3. If the script prints `STATUS: ERROR`, explain the failed check and the exact next action.
4. If the script prints any `WARN:` line, such as cmux not running, report it as well.
