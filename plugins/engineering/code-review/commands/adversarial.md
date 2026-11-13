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
  - Bash(python3:*)
  - Bash(test:*)
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

## Recursion guard — check before anything else

Before any other tool call, run:

printenv CODE_REVIEW_CHILD

If it prints a non-empty value, you are running inside a reviewer process. Reply
exactly: "Refusing: /code-review:adversarial invoked from inside a code-review reviewer." and
stop. Do not run any other tool. If the command fails or prints nothing, continue.

## Plugin root — resolve before any script call

Resolve **PLUGIN_ROOT** with Bash tool calls. Do not use load-time bang-backtick for env vars:
`printenv VAR` exits 1 when unset and aborts command load; `${…}` is rejected as expansion.

1. `printenv CLAUDE_PLUGIN_ROOT` — use that path when `PLUGIN_ROOT/scripts/run-orchestrator.sh`
   exists.
2. Otherwise run:

```bash
bash -c 'r=$(ls -td "$HOME"/.claude/plugins/cache/*/code-review/*/scripts/run-orchestrator.sh 2>/dev/null | head -1); r=${r%/scripts/run-orchestrator.sh}; printf "%s\n" "${r:-UNRESOLVED}"'
```

`CLAUDE_PLUGIN_ROOT` is *not* exported into later Bash or Read tool calls, so any command
carrying the literal `${CLAUDE_PLUGIN_ROOT}` expands to an empty string and dies with exit 127
before the orchestrator starts. Wherever review-core.md writes `PLUGIN_ROOT`, substitute the
absolute path from step 1 or 2. If the result is `UNRESOLVED`, stop and tell the user the
plugin install could not be located.

## Arguments

Raw arguments: `$ARGUMENTS`

- `-c=N` → concurrency override for this run.
- `--max-rounds=N` → loop cap override.
- `--spec=<path>[,<path>…]` → spec document(s) to review the change against (review-core.md
  §2.5; without the flag, spec sources are resolved from session context or by asking).
- Everything else is the **review target** (审查内容): commit sha(s) or range, `staged`,
  `working-tree`, file paths, `branch <base>`, or a description that maps to one of these.
  If empty, you will ask — never assume a default.

## Procedure

Read `PLUGIN_ROOT/references/portable-workflow.md` and execute it in **adversarial mode**.
Run `python3 -B "PLUGIN_ROOT/scripts/review.py" --repo "<git-root>" run --backend claude --mode adversarial`
with the resolved arguments in a background Bash task. For later rounds use the `next`
subcommand. Yield to the task's completion notification after each launch.
