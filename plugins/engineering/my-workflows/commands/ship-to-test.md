---
description: Commit → push → create MR (dev-f → f) → merge MR → deploy f branch to test
argument-hint: [reviewer name or keyword]
allowed-tools:
  - Bash(git:*)
  - Bash(yunke-cli:*)
  - Bash(npm:*)
  - Bash(curl:*)
  - Bash(node:*)
---

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Goal

Run the current project's changes through the full ship-to-test pipeline: commit → push → create Merge Request (dev-f → f) → merge the MR via GitLab API → deploy the f branch to all test environments.

`$ARGUMENTS` is an optional MR reviewer name or keyword.

Except for Step 1 (commit, which requires generating a commit message), the entire pipeline is completed in one shot by the integrated script. **Do not manually run git pull/push, yunke-cli query/create/deploy, or GitLab API calls in place of the script**; the agent only: runs the script, reads its output, and on failure resumes from the breakpoint using the `RESUME` command provided by the script.

## Step 1: Commit changes

If git status in Context shows no changes (clean working tree), skip this step and go directly to Step 2.

Based on the above changes, create a single git commit. If recent commits are empty, use the standard commitizen commit format.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. **Do not send something like 'Co-Authored-By'.**

## Step 2: Run the integrated ship-to-test script

Run (append `--audit-user "$ARGUMENTS"` when `$ARGUMENTS` is non-empty):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-run.js" run
```

The script internally runs in order: environment checks (auto-install yunke-cli if missing, GitLab token check) → `git pull --rebase` + `git push` → yunke-cli query chain (branch status / repo / app / reviewers) → create MR and resolve the MR link via GitLab API → merge MR → poll until the merge commit has actually landed on the `f` branch (merging is asynchronous; deploying immediately would test stale code) → deploy to every ship-to-test target (environments whose `env_code` contains `test` and whose `app_name` matches the directory name), printing each result as-is. Prerequisite query results are stored in the state file and reused verbatim on resume; parameters are not re-inferred.

Reviewers come from `~/.yunke-cli/my-workflow-reviewers.json`, with priority: explicit `--audit-user` > `*` record (all projects) > project record (origin as key) > ask the user to choose.

## Step 3: Handle script output

Handle based on the trailing `STATUS`:

- **`STATUS: OK`**: Read `SUMMARY` and the full deploy output for each environment, then report. If the output contains an `ASK_REGISTER_GLOBAL` line (a reviewer was added via argument this run), ask the user during the report whether to register that reviewer as `*` (all projects); if they agree, run the `register-global` command given on that line.
- **`STATUS: NEED_USER`**: User intervention required. Follow `DETAIL`, then continue with the `RESUME` command in the output after the issue is resolved (do not restart from scratch). Common cases:
  - **rebase conflict**: Inspect the conflict yourself and decide whether it can be resolved safely (e.g. pure formatting, clearly unrelated changes). If yes, resolve, run `git rebase --continue`, then resume via `RESUME`; if not, involve the user and resume after they confirm it is done.
  - **reviewer pending selection**: `DETAIL` already includes the candidate list; ask the user to choose, and also ask whether to register the chosen reviewer as `*` (all projects). After selection, put the chosen `user_name` into the `RESUME` command's `--audit-user` and continue (the script writes project memory); if the user agrees to register as `*`, also run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-run.js" register-global <user_name>`.
  - **missing GitLab token**: Ask the user to set the `MY_WORKFLOW_GL_ACCESS_TOKEN` environment variable, then resume (do not print its value).
- **`STATUS: ERROR`**: Read `STEP` and `DETAIL`. If it can be fixed safely (e.g. push rejected and needs sync first), fix then resume via `RESUME`; otherwise explain the failure and suggested actions to the user, and wait for confirmation before resuming. Common causes of MR merge failure: pipeline not passed, approval required, or conflicts.

## Report

After everything completes, briefly report in Chinese:

1. The committed message and push result.
2. The created-and-merged MR link and reviewer.
3. Each ship-to-test target environment and its deploy trigger result (the script already printed full deploy command output; a summary is enough; call out any failed environments explicitly).
