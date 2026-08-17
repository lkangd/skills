---
description: Commit → push → create MR (dev-f → f or dev-bg → bg) → merge MR → deploy f branch to test
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

Run the current project's changes through the full ship-to-test pipeline: commit → push → create Merge Request (dev-f → f or dev-bg → bg) → merge the MR via GitLab API → deploy the f branch to all test environments.

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

The script internally runs in order: environment checks (auto-install yunke-cli if missing, GitLab token check) → `git pull --rebase` + `git push` → yunke-cli query chain (branch status / repo / app / reviewers) → create MR, then **verify via the GitLab API that the MR head is exactly this round's commit** → merge MR → resolve and confirm the target-side merge/squash SHA on the `f` branch → record the test-branch baseline → trigger every ship-to-test target (environments whose `env_code` contains `test` and whose `app_name` matches the directory name) → poll until every repository's target-side SHA is actually present on the mapped test branch. The yunke success response only means the trigger was accepted; it is not deployment completion. Prerequisite query results and verification progress are stored in the state file and reused verbatim on resume; parameters are not re-inferred. If a non-primary repository's MR merger list does not include the chosen reviewer (Mars: `获取审核人Id失败` / `用户不存在`), skip that repository, continue with the rest, and surface the reason as a `NOTE` / `skipped_repos` entry — do not treat it as a pipeline failure or ask the user to pick another reviewer for it.

Note: `yunke-cli` exits 0 even when the operation failed (the failure text only appears in the output payload), and a success payload only acknowledges the trigger. The script therefore does text-level failure detection plus semantic verification against GitLab. Run it with a tool timeout of at least 15 minutes so the test-branch verification window can finish. Trust the script's trailing `STATUS`, not the raw command output.

**Resuming**: every failure records the failed step in the state file. Simply running the same command again automatically continues from that step (as long as HEAD, branch, and origin have not changed); the printed `RESUME` command does the same explicitly. `--from` cannot bypass this run-identity check. A deploy resume in `triggering` / `verifying` state only continues GitLab content verification and does not call yunke again. Never work around a failed step by running git/yunke-cli/GitLab API calls yourself, and never skip ahead to a later step — that is exactly how stale code gets shipped to test.

Reviewers come from `~/.yunke-cli/my-workflow-reviewers.json`, with priority: explicit `--audit-user` > `*` record (all projects) > project record (origin as key) > ask the user to choose.

## Step 3: Handle script output

The trailing `STATUS` line is the single source of truth. **`STATUS: OK` is the only successful outcome** — if it is absent (non-zero exit), the pipeline did NOT finish, no matter how much of the output looks fine. Never tell the user it succeeded, and never invent intermediate facts such as "the script retried and succeeded"; report only what the output actually says.

Handle based on the trailing `STATUS`:

- **`STATUS: OK`**: Read `SUMMARY` and the full trigger output for each environment, then report. Confirm that every non-skipped environment has `status: verified`; distinguish `trigger_status` (accepted/not needed) from `verification_status: verified`, and distinguish `verification_mode: observed_after_trigger` from `already_present`. Any `NOTE:` lines (skipped environments, skipped repositories whose merger list lacks the reviewer, reused merged MR, invalidated stale verification) must be reflected in the report. If the output contains an `ASK_REGISTER_GLOBAL` line (a reviewer was added via argument this run), ask the user during the report whether to register that reviewer as `*` (all projects); if they agree, run the `register-global` command given on that line.
- **`STATUS: DRY_RUN`**: Only produced by `--dry-run`. The run stopped after `plan`: no MR was created, merged, or deployed. Never report it as a successful ship-to-test.
- **`STATUS: NEED_USER`**: User intervention required. Follow `DETAIL`, then continue with the `RESUME` command in the output after the issue is resolved (do not restart from scratch). Common cases:
  - **commit message too long**: The message exceeds the 255-char MR title limit. Shorten it with `git commit --amend` (keep the subject, trim the body), then resume; if `DETAIL` says the commit was already pushed, the resume's push will need `git push --force-with-lease`.
  - **environment does not support ship-to-test**: A deploy target was rejected by the platform (e.g. `❌ 不支持的环境`). Retrying never helps — ask the user whether to skip that environment, and if they agree resume with the `--skip-env` already included in `RESUME` (the decision is recorded in the state file, and successfully deployed environments are not redeployed).
  - **rebase conflict**: Inspect the conflict yourself and decide whether it can be resolved safely (e.g. pure formatting, clearly unrelated changes). If yes, resolve, run `git rebase --continue`, then resume via `RESUME`; if not, involve the user and resume after they confirm it is done.
  - **reviewer pending selection**: `DETAIL` already includes the candidate list; ask the user to choose, and also ask whether to register the chosen reviewer as `*` (all projects). After selection, put the chosen `user_name` into the `RESUME` command's `--audit-user` and continue (the script writes project memory); if the user agrees to register as `*`, also run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-run.js" register-global <user_name>`.
  - **missing GitLab token**: Ask the user to set the `MY_WORKFLOW_GL_ACCESS_TOKEN` environment variable, then resume (do not print its value).
- **`STATUS: ERROR`**: Read `STEP` and `DETAIL`. If it can be fixed safely (e.g. push rejected and needs sync first), fix then resume via `RESUME`; otherwise explain the failure and suggested actions to the user, and wait for confirmation before resuming. Common causes of MR creation failure: title too long, insufficient Mars permissions, no diff between branches. Common causes of MR merge failure: pipeline not passed, approval required, or conflicts. If deploy verification times out, report that the trigger may already be running but the mapped test branch does not yet contain every target SHA; resume with the printed command to continue verification without retriggering. If an environment ends as `unverifiable`, the platform accepted the trigger but that `env_code` has no known GitLab test-branch mapping, so content could not be checked — report it as unverified and ask the user to confirm the environment manually; resuming will not retrigger it.

## Report

Report only after `STATUS: OK`. If the run ended in `NEED_USER` / `ERROR`, report the failure instead: which step failed, why, and what you need from the user — do not present a partially finished pipeline as done.

After everything completes, briefly report in Chinese:

1. The committed message and push result.
2. The created-and-merged MR link and reviewer. If `SUMMARY.skipped_repos` or a `NOTE` says a repository was skipped because the reviewer is not in its MR merger list, report that repository and the reason; do not present it as a failed ship-to-test.
3. Each ship-to-test target environment's trigger result and GitLab content-verification result, including whether the target SHA was observed after this trigger or was already present (call out explicitly any environment that failed verification or was skipped).
