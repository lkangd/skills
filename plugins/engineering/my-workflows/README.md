# My Workflows Plugin

Personal engineering workflow commands.

## Commands

### `/create-dev-worktree <branch-name>`

Creates a sibling git worktree for the current repository and creates or updates a sibling VS Code `.code-workspace` file for the same branch.

Use this after creating a remote development branch in the company system.

```bash
/create-dev-worktree dev-f-20260511-auto-aftermarket-for-standard
```

For a repository at:

```text
/Users/liangkangda/Work/code/ai-sale/fe-ai-sale-inquries-bg
```

The command creates or reuses:

```text
/Users/liangkangda/Work/code/ai-sale/fe-ai-sale-inquries-bg-dev-f-20260511-auto-aftermarket-for-standard
```

It also creates or updates:

```text
/Users/liangkangda/Work/code/ai-sale/dev-f-20260511-auto-aftermarket-for-standard.code-workspace
```

The workspace entry uses the sibling worktree directory as both `name` and relative `path`:

```json
{
    "folders": [
        {
            "name": "fe-ai-sale-inquries-bg-dev-f-20260511-auto-aftermarket-for-standard",
            "path": "fe-ai-sale-inquries-bg-dev-f-20260511-auto-aftermarket-for-standard"
        }
    ],
    "settings": {}
}
```

### `/my-workflows:clean-dev-worktree <branch-name> [--force]`

Cleans local development resources after a feature branch has gone live.

```bash
/my-workflows:clean-dev-worktree dev-f-20260702-ai-live-stream-reply
```

The command reads the sibling workspace file:

```text
<parent-directory>/dev-f-20260702-ai-live-stream-reply.code-workspace
```

For every workspace folder whose `path` or `name` ends with the branch name, it:

1. Checks the matching worktree path exists and is a linked git worktree.
2. Checks the worktree is on the expected branch.
3. Checks there are no uncommitted or untracked files.
4. Fetches refs and checks the local branch is merged into the default remote branch, such as `origin/main`.
5. Removes the worktree.
6. Deletes the local branch in that repository.
7. Deletes the `.code-workspace` file after all related targets are cleaned.

If the workspace contains multiple folders, all matching folders are cleaned together. For example, this workspace causes both the `bff` and `fe` worktrees and local branches to be cleaned:

```json
{
    "folders": [
        {
            "name": "bff-ai-sale-inquries-bg-dev-f-20260702-ai-live-stream-reply",
            "path": "bff-ai-sale-inquries-bg-dev-f-20260702-ai-live-stream-reply"
        },
        {
            "name": "fe-ai-sale-inquries-bg-dev-f-20260702-ai-live-stream-reply",
            "path": "fe-ai-sale-inquries-bg-dev-f-20260702-ai-live-stream-reply"
        }
    ],
    "settings": {}
}
```

#### Cleanup safety

The command automatically deletes only when every target is safe.

It stops with `STATUS: CONFIRMATION_REQUIRED` when it sees recoverable risk, such as:

- Missing worktree paths referenced by the workspace file.
- Uncommitted or untracked files in a worktree.
- A local branch that is not merged into the default remote branch.
- Remote refs that cannot be fetched for the safety check.

After manually confirming those risks are acceptable, rerun with `--force`:

```bash
/my-workflows:clean-dev-worktree dev-f-20260702-ai-live-stream-reply --force
```

The command stops with `STATUS: ERROR` and does not delete anything for protected cases, such as:

- The target path is not a git worktree.
- The target is a main repository rather than a linked git worktree.
- The target worktree is checked out on a different branch.
- The current shell is inside the target worktree.

## Branch Format

Branch names must match:

```text
dev-[f/bg]-[YYYYMMdd]-[description-separated-by-dash]
```

Examples:

- `dev-f-20260511-auto-aftermarket-for-standard`
- `dev-bg-20260511-auto-aftermarket-for-standard`

## Troubleshooting

- If `/create-dev-worktree` cannot find the branch, create it in the company system and rerun after remote sync.
- If `/create-dev-worktree` finds the target path but it is not a git worktree, rename or remove that directory before rerunning.
- If `/clean-dev-worktree` reports `CONFIRMATION_REQUIRED`, review the table before rerunning with `--force`.
- If the `.code-workspace` file contains invalid JSON, fix the JSON manually before rerunning either command.
