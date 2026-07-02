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
/Users/xxxxxxxxxxx/Work/code/ai-sale/fe-ai-sale-inquries-bg
```

The command creates or reuses:

```text
/Users/xxxxxxxxxxx/Work/code/ai-sale/fe-ai-sale-inquries-bg-dev-f-20260511-auto-aftermarket-for-standard
```

It also creates or updates:

```text
/Users/xxxxxxxxxxx/Work/code/ai-sale/dev-f-20260511-auto-aftermarket-for-standard.code-workspace
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

## Branch Format

Branch names must match:

```text
dev-[f/bg]-[YYYYMMdd]-[description-separated-by-dash]
```

Examples:

- `dev-f-20260511-auto-aftermarket-for-standard`
- `dev-bg-20260511-auto-aftermarket-for-standard`

## Behavior

1. Validates the branch argument.
2. Uses the current git repository as the source repository.
3. Runs `git pull --ff-only --prune` when the current branch has an upstream, otherwise runs `git fetch --all --prune`.
4. Creates a sibling worktree named `<repo-name>-<branch-name>`.
5. Creates or updates `<branch-name>.code-workspace` in the parent directory.
6. Inserts the current repository worktree at the top of the workspace `folders` list and avoids duplicate `path` entries.

## Troubleshooting

- If the branch is not found, create it in the company system and rerun the command after remote sync.
- If the target path exists but is not a git worktree, rename or remove that directory before rerunning.
- If the `.code-workspace` file contains invalid JSON, fix the JSON manually before rerunning.
