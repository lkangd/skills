---
description: Adversarial review loop - review, fix, re-review until clean or max rounds
argument-hint: <review-target> [-c=N] [--max-rounds=N] [--spec=<path>,...]
disable-model-invocation: true
allowed-tools:
  - Bash(bash:*)
  - Bash(git diff:*)
  - Bash(git show:*)
  - Bash(git log:*)
  - Bash(git status:*)
  - Bash(mkdir:*)
  - Bash(printenv:*)
  - Bash(test:*)
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

## Plugin root — resolve before any script call

Resolved plugin root: `!`bash -c 'r="${CLAUDE_PLUGIN_ROOT}"; [ -f "$r/scripts/run-orchestrator.sh" ] || r=$(ls -td "$HOME"/.claude/plugins/cache/*/code-review/*/scripts/run-orchestrator.sh 2>/dev/null | head -1); r=${r%/scripts/run-orchestrator.sh}; printf "%s\n" "${r:-UNRESOLVED}"'``

The absolute path printed above is **PLUGIN_ROOT** for this run. `CLAUDE_PLUGIN_ROOT` is *not*
exported into Bash or Read tool calls, so any command carrying the literal
`${CLAUDE_PLUGIN_ROOT}` expands to an empty string and dies with exit 127 before the
orchestrator starts. Wherever review-core.md writes `PLUGIN_ROOT`, substitute that absolute
path. If it printed `UNRESOLVED`, stop and tell the user the plugin install could not be
located.

## Arguments

Raw arguments: `$ARGUMENTS`

- `-c=N` → concurrency override for this run.
- `--max-rounds=N` → loop cap override (config default: 3).
- `--spec=<path>[,<path>…]` → spec document(s) to review the change against (review-core.md
  §2.5; without the flag, spec sources are resolved from session context or by asking).
- Everything else is the **review target** (审查内容): commit sha(s) or range, `staged`,
  `working-tree`, file paths, `branch <base>`, or a description that maps to one of these.
  If empty, you will ask — never assume a default.

## Procedure

Read `PLUGIN_ROOT/references/review-core.md` and execute it in **loop mode**. You do
not orchestrate the reviews — each round launches one orchestrator session that does the diff
collection, reviewer dispatch, and finding verification, and hands you a consolidated report:

1. Safety rules (§0), load config (§1) — run setup first if `.claude/code-review.local.md` is
   missing.
2. Resolve the review target (§2) and the spec sources (§2.5) — explicit `--spec=` paths,
   else specs already in this session's context, else ask (default: no spec).
3. **Round 1**: launch ONE orchestrator with angles
   `correctness, removed-behavior, callers, reuse, simplification, efficiency, altitude, conventions, design, pitfalls, wrapper`
   — plus `spec` (with one `--spec-file` per document) when §2.5 resolved spec sources —
   (§3) — the orchestrator also runs a post-verification gap sweep in this mode — or execute
   the orchestrator procedure yourself if config says `runner: in-session` (§4). Then verify
   the surviving (CONFIRMED / PLAUSIBLE) findings and fix / backlog / reject per §5.
4. **Rounds 2..max_rounds**: follow the loop protocol (§6) exactly — continue only while the
   previous round produced confirmed major/critical findings that you fixed; each later round
   launches one orchestrator with angles `re-review` on the cumulative diff, with the
   known-issues list inlined.
5. Report per §7, including how many rounds ran and why the loop stopped. Do not commit
   anything.

Budget invariant: exactly one orchestrator launch per round. All reviewer/verifier fan-out
happens inside the orchestrator under its own caps (≤ 13 reviewers, ≤ 10 verifiers).
