---
description: Adversarial review loop - review, fix, re-review until clean or max rounds
argument-hint: <review-target> [-c=N] [--max-rounds=N]
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
exactly: "Refusing: /code-review:adversarial invoked from inside a code-review reviewer." and
stop. Do not run any tool.

## Arguments

Raw arguments: `$ARGUMENTS`

- `-c=N` → concurrency override for this run.
- `--max-rounds=N` → loop cap override (config default: 3).
- Everything else is the **review target** (审查内容): commit sha(s) or range, `staged`,
  `working-tree`, file paths, `branch <base>`, or a description that maps to one of these.
  If empty, you will ask — never assume a default.

## Procedure

Read `${CLAUDE_PLUGIN_ROOT}/references/review-core.md` and execute it in **loop mode**:

1. Safety rules (§0), load config (§1) — run setup first if `.claude/code-review.local.md` is
   missing.
2. Resolve the review target (§2).
3. **Round 1**: build the packet (§3), prepare **four** angle prompts (§4): `correctness`,
   `conventions`, `callers`, `design`. Dispatch per the configured runner (§5), then verify and
   fix / backlog / reject per §6.
4. **Rounds 2..max_rounds**: follow the loop protocol (§7) exactly — continue only while the
   previous round produced confirmed major/critical findings that you fixed; each later round
   is one single `re-review` reviewer on a fresh cumulative packet with the known-issues list
   inlined.
5. Report per §8, including how many rounds ran and why the loop stopped. Do not commit
   anything.

Budget invariant: this command dispatches at most 4 reviewers in round 1 and exactly 1 per
later round — never more, regardless of findings volume.
