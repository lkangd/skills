---
name: wrapup
description: This skill should be used when the user explicitly invokes "wrapup" to finish a session with current-worktree checks, full test gates, scoped commits, and a call to the handoff skill for the next agent.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

# Wrapup

Run the following steps in order. Treat any supplied arguments as the next session's focus, not as authorization to expand the scope of fixes or commits.

Before starting, verify that `handoff:handoff` is available through the Skill tool. If unavailable, stop and report that the `handoff` dependency must be installed and enabled; do not perform fixes or commits and do not substitute an inline handoff implementation.

## 1. Inspect the current worktree

Run `git status` in the current worktree. Include all staged, unstaged, and untracked work, not just changes from the current issue. Inspect the relevant diffs to distinguish session work from pre-existing or unrelated modifications.

Stay within the current worktree. Do not enumerate, inspect, switch to, or modify other branches or worktrees.

List unrelated changes separately. Ask for authorization before including them in fixes or commits unless the user has already explicitly authorized their inclusion. Preserve excluded changes, including staged changes; do not reset, discard, or stash them to make the worktree look clean.

If the workspace is not a Git repository, report that status and commits are unavailable, then continue with applicable test gates and the handoff.

## 2. Run full test gates; fix anything red

Identify the project's complete validation gates from its instructions, scripts, and CI configuration. Run the full applicable gates, including tests, lint, type checks, and builds where defined, rather than only tests for the current issue. If no gates exist, report that explicitly; do not invent a passing result.

Fix failures within the authorized scope and rerun the affected gates, then run the full gates again after the final fix. Ask before changing unrelated code or requiring destructive or external actions. Never remove tests, weaken assertions, or disable checks merely to obtain a green result.

Distinguish actual failures from unavailable checks. Record missing credentials, unavailable services, dependency problems, failing commands, and checks not run. If a failure cannot be safely resolved, do not commit the failed scope; still continue to the handoff with the blocker and next steps. Commit independently passing scopes only when their relevant gates have been verified.

## 3. Commit in clean, scoped units

Group authorized changes into coherent commits with clear messages following repository conventions. Review each proposed commit's diff and stage only its intended files or hunks. Keep unrelated and excluded staged changes out of every commit; never commit the entire index blindly.

Verify that each proposed commit includes the changes its passing checks depend on, or that those dependencies are already committed. If excluded or omitted changes prevent verifying the proposed scope independently, leave it uncommitted and record the blocker. Do not disturb excluded work or use another branch or worktree to manufacture a clean test environment.

Do not create empty commits, amend existing commits, bypass hooks, or push automatically. If a hook fails, fix it within scope and retry; otherwise record the blocker and leave the work uncommitted. If no authorized changes remain, skip committing and report why.

## 4. Invoke the handoff skill

Call the Skill tool with `skill: "handoff:handoff"`. Pass any supplied arguments unchanged in `args` as the next session's focus; omit `args` when none were supplied.

Follow the loaded skill in the current conversation so it can include the decisions, commit outcomes, validation results, excluded work, and blockers from steps 1–3. Delegate all document content and save-location rules to that skill; do not duplicate them here or write a second document.

If the skill call or document generation fails, report the blocker and completed work honestly. Do not claim a handoff was saved or invent a replacement.

After the handoff completes, report its saved path, commit outcomes, validation results, blockers, and the final `git status` for the current worktree. Do not claim the worktree is clean if excluded changes or the new handoff remain.
