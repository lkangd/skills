---
name: code-review
description: Review a target (commits, staged, working tree, files), verify findings, fix confirmed issues
argument-hint: <review-target> [-c=N] [--spec=<path>,...] | resume [<run-dir>]
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

Use normal mode by default. Select resume mode when the first word is `resume` and use
the optional run directory that follows. In Codex, also accept the existing leading
`adversarial` and `setup` arguments as mode selectors.

Follow [the shared workflow](../../references/portable-workflow.md) in the selected mode.
