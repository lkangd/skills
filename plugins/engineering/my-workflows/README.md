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

### `/my-workflows:ship-to-test [审核人]`

Ships the current `dev-f` branch changes all the way to the test environment. The agent only writes the commit message; everything else runs in one shot via `scripts/ship-to-test-run.js`:

1. Env checks: git repo, `dev-f*` branch, `MY_WORKFLOW_GL_ACCESS_TOKEN` present, `yunke-cli` installed (auto-installs if missing).
2. Commit-message pre-check (Mars uses the whole commit message as the MR title, GitLab caps it at 255 chars — checked *before* pushing, while `git commit --amend` is still a local-only fix), then `git pull --rebase` + `git push` (`push -u` when the branch has no upstream yet).
3. `yunke-cli` query chain: `branch-status` (yields `app_branch_id` and the test deploy targets: `env_code` containing `test` for the app whose `app_name` is contained in the project directory name) → `repositories` (yields `service_name` and GitLab project path) → `applications` (yields `product_id`) → reviewer resolution.
4. Creates the Merge Request from `dev-f-*` to the matching `f-*` branch, then **verifies via the GitLab API that the MR for this round really exists** (the create response contains no MR link, and `yunke-cli` exits 0 even when creation failed) and merges it with `MY_WORKFLOW_GL_ACCESS_TOKEN`. Per repository, "this round's commit" is the local `HEAD` for the checked-out repo and the remote `dev` branch tip for any other repo; an older merged MR is only reused when that commit is already on `f`.
5. Waits until that commit has actually landed on the `f` branch (polls the GitLab `commits/:sha/refs` API; merging is asynchronous, deploying immediately would test stale code), then deploys the `f` branch to every matched test environment and prints the full deploy output for each.

Because `yunke-cli` reports business failures with exit code 0 (the error text only appears in the output payload), every action command is additionally checked for failure markers in its text, and anything it cannot classify is treated as a failure rather than a success.

The script prints a `STATUS: OK | NEED_USER | ERROR` protocol with `STEP` / `DETAIL` / `RESUME` lines — `STATUS: OK` is the only successful outcome. Each failure records the failed step in `<git-dir>/ship-to-test-state.json`, so simply running the script again resumes from that step (as long as `HEAD` has not changed); `--from sync|plan|create|merge|deploy` forces a specific step and `--restart` forces a full rerun. Query results are cached in the same state file and reused verbatim on resume. Deploy results are recorded per environment: a resume never redeploys an environment that already succeeded, and an environment the platform refuses to ship to (e.g. `❌ 不支持的环境`) can be skipped for good with `--skip-env <env_code>`.

The chosen MR reviewer is remembered in `~/.yunke-cli/my-workflow-reviewers.json`, either per project (keyed by the `origin` remote URL) or globally (keyed by `*`). Resolution priority: explicit argument > `*` entry > project entry > ask the user. When a new reviewer is added, the agent asks whether to register it as the `*` entry (`ship-to-test-run.js register-global <user_name>`). Pass a reviewer name or keyword as the argument to override the memory:

```bash
/my-workflows:ship-to-test 张三
```

### `/my-workflows:generate-test-report <change-scope> [--view=e2e|code-review|both] [--output=<path>]`

Analyzes a user-specified Git change scope and writes an audience-focused test-submission report. Reports are written in Simplified Chinese by default.

The default perspective is E2E manual testing. Code Review content is included only when explicitly requested with `--view=code-review`, `--view=both`, or equivalent natural-language intent. The adaptive presentation guide at `references/test-report-template.md` uses tables for structured comparisons and omits headings for delivery surfaces that are not affected by the change.

The scope can be a commit, commit range, branch comparison, staged changes, uncommitted changes, or an unambiguous natural-language description:

```bash
/my-workflows:generate-test-report HEAD~3..HEAD
/my-workflows:generate-test-report abc123 --view=code-review
/my-workflows:generate-test-report current branch compared with main --view=both --output=docs/testing/
/my-workflows:generate-test-report uncommitted --output=docs/test-reports/report.md
```

When `--output` is omitted, the command finds the existing directory with the highest concentration of Markdown files, inspects whether it is an appropriate project documentation or report location, and writes the report there only when the fit is clear. Otherwise it asks the user to choose a directory instead of creating a new documentation convention. Existing report files are never overwritten without confirmation.

The command reconstructs behavior before and after the change from repository evidence. Missing environment, account, route, test-data, or command details are marked explicitly instead of being inferred.

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
