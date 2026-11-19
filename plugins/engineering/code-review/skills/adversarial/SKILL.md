---
name: adversarial
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
  - Bash(python3:*)
  - Bash(printenv:*)
  - Bash(test:*)
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

Claude Code plugin install path (substituted when this skill loads): `${CLAUDE_PLUGIN_ROOT}`.

Invocation arguments: `$ARGUMENTS`. If the placeholder is literal, use the text supplied
with the skill invocation.

Follow [the shared workflow](../../references/portable-workflow.md) in adversarial mode.
