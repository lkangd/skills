---
description: Clean dev branch worktrees and VS Code workspace
argument-hint: <branch-name> [--force]
allowed-tools:
  - Bash(bash:*)
  - Bash(printenv:*)
---

## Goal

Clean local development resources for branch `$ARGUMENTS` after the feature has gone live:

1. Inspect the sibling `$ARGUMENTS.code-workspace` file.
2. Clean every workspace folder whose path belongs to the target branch.
3. Close the cmux workspace named `$ARGUMENTS` once the preflight checks pass, before anything is removed.
4. Remove each matching git worktree.
5. Delete the local branch in each related repository.
6. Delete the workspace file after all related worktrees and local branches are cleaned.

## Plugin root

Resolve **PLUGIN_ROOT** with a Bash tool call before running the script. Do not use load-time bang-backtick for this: `printenv VAR` exits 1 when unset and aborts command load.

printenv CLAUDE_PLUGIN_ROOT

If that command fails or prints nothing, stop and explain that the plugin installation could not be located. Do not write `${CLAUDE_PLUGIN_ROOT}` into later Bash tool calls.

## Execute

Run the bundled cleanup script exactly once with Bash and use its output as the source of truth:

bash "PLUGIN_ROOT/scripts/clean-dev-worktree.sh" "$ARGUMENTS"

## Report

Reply concisely in Chinese:

1. If the script prints `STATUS: CLEANED`, summarize the result table.
2. If the script prints `STATUS: CONFIRMATION_REQUIRED`, do not run more commands. Explain why automatic deletion stopped and ask the user to confirm before using `--force`.
3. If the script prints `STATUS: ERROR`, explain the failed check and the exact next action.
4. If the script prints any `WARN:` line, such as cmux not running, report it as well.
