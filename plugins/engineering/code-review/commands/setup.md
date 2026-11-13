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
locate the newest installed code-review plugin under the Claude plugin cache. Read
`references/configuration.md` under the resolved root and follow its setup procedure.

Offer the configured Claude runner, bare `claude`, a compatible command prefix such as
`ccsp -g <preset> claude`, and `in-session`. Save the shared JSON settings.
