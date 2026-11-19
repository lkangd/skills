# Project configuration

Before a review or resume, run `python3 -B "<plugin-root>/scripts/review.py" --repo "<git-root>" config`.
This validates `.code-review/config.local.json` at the Git root. If it succeeds, use the
saved configuration. If it fails, or the user explicitly requested setup, complete the
steps below before launching a runner.

1. Run the same command with `config-template` to get a proposed configuration. Retain
   existing valid project values unless the user changes them.
2. Ask the user to supply or accept the concurrency, adversarial round cap, backlog path,
   runner and model settings for Claude Code, Codex and Pi. For each host, the user can
   choose harness model selection by leaving its model overrides empty.
3. Show the complete JSON and ask for explicit confirmation to save it and, for a review
   invocation, proceed. If the user asks for changes, show the updated JSON and ask again.
   Wait for affirmative confirmation before writing or launching anything.
4. Pass the confirmed JSON on stdin to the same command with `config-save`. Use a quoted
   heredoc delimiter if passing it from a shell. The command validates and saves the file
   atomically. If validation fails, correct the proposal with the user and confirm it again.
5. From the Git root, run `git check-ignore -- .code-review/config.local.json .code-review/runs/example/out/findings.json`.
   If either path is missing from the output, ask whether to add `/.code-review/` to the
   root `.gitignore`. If it has an exact `.claude/code-review/` entry and that directory is
   gone, offer to replace that entry with the new rule. Apply the user's choice, then
   finish explicit setup or continue the requested review.

The template includes every required field.

```json
{
  "concurrency": 4,
  "max_rounds": 3,
  "backlog_dir": "docs/code-review-backlog",
  "claude": { "runner": "claude" },
  "codex": { "runner": "codex" },
  "pi": { "runner": "pi" }
}
```

Concurrency is the maximum simultaneous review or verification tasks. Set it to `0` for
no concurrency limit. The backlog path is relative to the Git root. Each host can use
`"runner": "claude"`, `"runner": "codex"`, or `"runner": "pi"`. The selection determines
which harness runs that round. For a wrapper use the Claude-compatible command prefix
`"ccsp -g <preset> claude"`, or specify the harness and command explicitly, for example
`"runner": {"harness":"codex","command":"/path/to/wrapped-codex"}`. Codex and Pi use
their own harness when their runner field is omitted.
Keep credentials in the native harness configuration.

Each host object accepts optional `models.low`, `models.medium`, and `models.high` entries
with `model` and/or `effort` strings. Use the model identifier and effort values accepted
by the configured runner or native harness. Native Pi model IDs use `provider/id`.
Review attempts discover available models, supported effort and context size from the
selected harness. When the catalog distinguishes capabilities, it uses them to match
models to low, medium and high complexity. Explicit overrides take precedence. When the
catalog cannot distinguish models, it uses the harness default and supported effort.
