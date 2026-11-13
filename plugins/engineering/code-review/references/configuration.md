# Project configuration

Before a review or resume, run `python3 -B "<plugin-root>/scripts/review.py" --repo "<git-root>" config`.
This validates `.code-review/config.local.json` at the Git root. If it succeeds, use the
saved configuration. If it fails, or the user explicitly requested setup, complete the
steps below before launching a runner.

1. Run the same command with `config-template` to get a proposed configuration. Retain
   existing valid project values unless the user changes them.
2. Ask the user to supply or accept the concurrency, adversarial round cap, backlog path,
   external Claude runner, and model settings for Claude Code, Codex and Pi. For each host,
   the user can choose harness model selection by leaving its overrides empty.
3. Show the complete JSON and ask for explicit confirmation to save it and, for a review
   invocation, proceed. If the user asks for changes, show the updated JSON and ask again.
   Wait for affirmative confirmation before writing or launching anything.
4. Pass the confirmed JSON on stdin to the same command with `config-save`. Use a quoted
   heredoc delimiter if passing it from a shell. The command validates and saves the file
   atomically. If validation fails, correct the proposal with the user and confirm it again.
   For explicit setup, finish after saving.

The template includes every required field.

```json
{
  "concurrency": 4,
  "max_rounds": 3,
  "backlog_dir": "docs/code-review-backlog",
  "claude": { "runner": "claude" },
  "codex": {},
  "pi": {}
}
```

Concurrency is the maximum simultaneous review or verification tasks. Set it to `0` for
no concurrency limit. The backlog path is relative to the Git root. The Claude runner is
an external command such as `claude` or a compatible prefix such as `ccsp -g <preset> claude`.
Keep credentials in the native harness configuration.

Each host object accepts optional `models.low`, `models.medium`, and `models.high` entries
with `model` and/or `effort` strings. Use the model identifier and effort values accepted
by that harness. Pi model IDs use `provider/id`. Review attempts discover available
models and supported effort from the actual backend when that interface is accessible.
