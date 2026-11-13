---
name: code-review
description: Review an explicit Git change, verify findings, fix confirmed issues, or resume a review.
disable-model-invocation: true
---

Follow `../../references/portable-workflow.md` relative to this skill. Use the Git root as
`workspace` in the bundled `review_*` MCP calls. Each review round is one blocking call.
After dispatch, yield until that call returns. If the launcher is unavailable, report the
blocker and stop. The launcher requests repository authorization on first use.

Arguments are the target and optional `--spec=<path>[,<path>…]` and `-c=N`. Leading
`adversarial` selects the iterative workflow and accepts `--max-rounds=N`. Leading
`resume [<run-dir>]` selects recovery. Leading `setup` opens the configuration procedure.
