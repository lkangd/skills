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

**Keep the whole commit message (subject + body) under 255 characters.** Mars uses the entire commit message verbatim as the MR title, and GitLab rejects titles longer than 255 chars — an overlong message makes MR creation fail. Prefer a precise subject plus at most 2–3 short bullets. The script also checks this before pushing and stops if it is too long.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. **Do not send something like 'Co-Authored-By'.**

## Step 2: Run the integrated ship-to-test script

Run (append `--audit-user "$ARGUMENTS"` when `$ARGUMENTS` is non-empty):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-run.js" run
```

The script internally runs in order: environment checks (auto-install yunke-cli if missing, GitLab token check) → `git pull --rebase` + `git push` → yunke-cli query chain (branch status / repo / app / reviewers) → create MR, then **verify via the GitLab API that the MR for this commit really exists** → merge MR → poll until this commit has actually landed on the `f` branch (merging is asynchronous; deploying immediately would test stale code) → deploy to every ship-to-test target (environments whose `env_code` contains `test` and whose `app_name` matches the directory name), printing each result as-is. Prerequisite query results are stored in the state file and reused verbatim on resume; parameters are not re-inferred.

Note: `yunke-cli` exits 0 even when the operation failed (the failure text only appears in the output payload), so the script does text-level failure detection plus semantic verification against GitLab. Trust the script's `STATUS`, not the raw command output.

**Resuming**: every failure records the failed step in the state file. Simply running the same command again automatically continues from that step (as long as HEAD has not changed); the printed `RESUME` command does the same explicitly. Never work around a failed step by running git/yunke-cli/GitLab API calls yourself, and never skip ahead to a later step — that is exactly how stale code gets shipped to test.

Reviewers come from `~/.yunke-cli/my-workflow-reviewers.json`, with priority: explicit `--audit-user` > `*` record (all projects) > project record (origin as key) > ask the user to choose.

## Step 3: Handle script output

The trailing `STATUS` line is the single source of truth. **`STATUS: OK` is the only successful outcome** — if it is absent (non-zero exit), the pipeline did NOT finish, no matter how much of the output looks fine. Never tell the user it succeeded, and never invent intermediate facts such as "the script retried and succeeded"; report only what the output actually says.

Handle based on the trailing `STATUS`:

- **`STATUS: OK`**: Read `SUMMARY` and the full deploy output for each environment, then report. Any `NOTE:` lines (skipped environments, reused merged MR) must be reflected in the report. If the output contains an `ASK_REGISTER_GLOBAL` line (a reviewer was added via argument this run), ask the user during the report whether to register that reviewer as `*` (all projects); if they agree, run the `register-global` command given on that line.
- **`STATUS: NEED_USER`**: User intervention required. Follow `DETAIL`, then continue with the `RESUME` command in the output after the issue is resolved (do not restart from scratch). Common cases:
  - **commit message too long**: The message exceeds the 255-char MR title limit. Shorten it with `git commit --amend` (keep the subject, trim the body), then resume; if `DETAIL` says the commit was already pushed, the resume's push will need `git push --force-with-lease`.
  - **environment does not support ship-to-test**: A deploy target was rejected by the platform (e.g. `❌ 不支持的环境`). Retrying never helps — ask the user whether to skip that environment, and if they agree resume with the `--skip-env` already included in `RESUME` (the decision is recorded in the state file, and successfully deployed environments are not redeployed).
  - **rebase conflict**: Inspect the conflict yourself and decide whether it can be resolved safely (e.g. pure formatting, clearly unrelated changes). If yes, resolve, run `git rebase --continue`, then resume via `RESUME`; if not, involve the user and resume after they confirm it is done.
  - **reviewer pending selection**: `DETAIL` already includes the candidate list; ask the user to choose, and also ask whether to register the chosen reviewer as `*` (all projects). After selection, put the chosen `user_name` into the `RESUME` command's `--audit-user` and continue (the script writes project memory); if the user agrees to register as `*`, also run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-run.js" register-global <user_name>`.
  - **missing GitLab token**: Ask the user to set the `MY_WORKFLOW_GL_ACCESS_TOKEN` environment variable, then resume (do not print its value).
- **`STATUS: ERROR`**: Read `STEP` and `DETAIL`. If it can be fixed safely (e.g. push rejected and needs sync first), fix then resume via `RESUME`; otherwise explain the failure and suggested actions to the user, and wait for confirmation before resuming. Common causes of MR creation failure: title too long, insufficient Mars permissions, no diff between branches. Common causes of MR merge failure: pipeline not passed, approval required, or conflicts.

## Report

Report only after `STATUS: OK`. If the run ended in `NEED_USER` / `ERROR`, report the failure instead: which step failed, why, and what you need from the user — do not present a partially finished pipeline as done.

After everything completes, briefly report in Chinese:

1. The committed message and push result.
2. The created-and-merged MR link and reviewer.
3. Each ship-to-test target environment and its deploy trigger result (the script already printed full deploy command output; a summary is enough; call out explicitly any environment that failed or was skipped).
