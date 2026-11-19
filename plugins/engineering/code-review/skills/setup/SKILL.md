---
name: setup
description: Configure code-review for the current Git project
disable-model-invocation: true
allowed-tools:
  - Bash(printenv CODE_REVIEW_CHILD)
  - Bash(git rev-parse --show-toplevel)
  - Bash(git check-ignore *)
  - Glob
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

Claude Code plugin install path (substituted when this skill loads): `${CLAUDE_PLUGIN_ROOT}`.

Follow [the shared workflow](../../references/portable-workflow.md) in setup mode.
