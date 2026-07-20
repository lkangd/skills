---
description: Review a target (commits, staged, working tree, files), verify findings, fix confirmed issues
argument-hint: <review-target> [-c=N] | resume [<run-dir>]
disable-model-invocation: true
allowed-tools:
  - Bash(bash:*)
  - Bash(git diff:*)
  - Bash(git show:*)
  - Bash(git log:*)
  - Bash(git status:*)
  - Bash(mkdir:*)
  - Bash(printenv:*)
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

## Recursion guard — check before anything else

Sentinel value (must be empty): `!`printenv CODE_REVIEW_CHILD``

If the sentinel value above is non-empty, you are running inside a reviewer process. Reply
exactly: "Refusing: /code-review invoked from inside a code-review reviewer." and stop. Do not
run any tool.

## Arguments

Raw arguments: `$ARGUMENTS`

- `-c=N` → concurrency override for this run.
- `resume [<run-dir>]` → do not start a new review: resume a previously failed round per
  review-core.md §3 "Resuming a failed round". With no run-dir, locate the newest
  `.code-review/runs/*/round-*` without a usable result (no non-empty `out/findings.json`,
  no ` ```json ` block in `out/orchestrator.out`) and confirm it with the user, then launch
  the script with `--resume` (background task), wait, and continue at §3 step 4 → §5 → §7.
- Everything else is the **review target** (审查内容): commit sha(s) or range, `staged`,
  `working-tree`, file paths, `branch <base>`, or a description that maps to one of these.
  If empty, you will ask — never assume a default.

## Procedure

Read `${CLAUDE_PLUGIN_ROOT}/references/review-core.md` and execute it in **single-pass mode**
(one review round, no loop). You do not orchestrate the review — one orchestrator session does
the diff collection, 8-angle reviewer dispatch, and finding verification, and hands you a
consolidated report:

1. Safety rules (§0), load config (§1) — run setup first if `.claude/code-review.local.md` is
   missing.
2. Resolve the review target (§2).
3. Launch ONE orchestrator via the bundled script with angles
   `correctness, removed-behavior, callers, reuse, simplification, efficiency, altitude, conventions`
   (§3), or execute the orchestrator procedure yourself if config says `runner: in-session`
   (§4). Wait for the consolidated, verified (CONFIRMED / PLAUSIBLE) findings.
4. Verify every surviving finding against the code, then fix / backlog / reject per §5.
5. Report per §7. Do not commit anything.
