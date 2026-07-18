---
description: Review a target (commits, staged, working tree, files), verify findings, fix confirmed issues
argument-hint: <review-target> [-c=N]
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
- Everything else is the **review target** (审查内容): commit sha(s) or range, `staged`,
  `working-tree`, file paths, `branch <base>`, or a description that maps to one of these.
  If empty, you will ask — never assume a default.

## Procedure

Read `${CLAUDE_PLUGIN_ROOT}/references/review-core.md` and execute it in **single-pass mode**
(one review round, no loop):

1. Safety rules (§0), load config (§1) — run setup first if `.claude/code-review.local.md` is
   missing.
2. Resolve the review target (§2).
3. Build the review packet (§3).
4. Prepare the three angle prompts (§4): `correctness`, `conventions`, `callers`.
5. Dispatch the reviewers per the configured runner (§5). Maximum 3 reviewers, launched at most
   once each.
6. Verify every finding against the code, then fix / backlog / reject per §6.
7. Report per §8. Do not commit anything.
