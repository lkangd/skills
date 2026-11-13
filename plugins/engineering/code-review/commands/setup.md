---
description: Configure code-review for the current Git project
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

Resolve the plugin root with `printenv CLAUDE_PLUGIN_ROOT`. If that value is missing,
locate the newest installed code-review plugin under the Claude plugin cache. Follow
`references/configuration.md` under that root for explicit setup.
