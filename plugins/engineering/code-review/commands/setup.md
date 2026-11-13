---
description: Configure code-review for the current Git project
disable-model-invocation: true
allowed-tools:
  - Bash(printenv CLAUDE_PLUGIN_ROOT)
  - Bash(git rev-parse --show-toplevel)
  - Bash(git check-ignore *)
  - Glob
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

Resolve the plugin root with `printenv CLAUDE_PLUGIN_ROOT`. If that value is missing,
use Glob under the Claude plugin cache to locate the newest installed
`code-review/*/scripts/review.py`. Follow `references/configuration.md` under the
resolved root for explicit setup.
