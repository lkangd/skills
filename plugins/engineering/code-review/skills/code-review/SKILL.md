---
name: code-review
description: Review an explicit Git change, verify findings, fix confirmed issues, or resume a review.
disable-model-invocation: true
---

Use the installed code-review plugin for this explicit invocation. Read
`../../references/portable-workflow.md` relative to this skill. Resolve the current workspace
with `git rev-parse --show-toplevel` and pass that absolute path as `workspace` to the bundled
`review_*` MCP tools. The launcher requests repository authorization the first time.

Arguments are the target and optional `--spec=<path>[,<path>…]` and `-c=N`. Leading
`adversarial` selects the iterative workflow and accepts `--max-rounds=N`. Leading
`resume [<run-dir>]` selects recovery. Leading `setup` opens the configuration procedure.
