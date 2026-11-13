# Project configuration

All hosts use `.code-review/config.local.json` at the Git root. The workflow can run with
built-in defaults. Setup reads the current JSON if present, shows its effective settings, and
asks the user for any changes to concurrency, adversarial round cap, backlog path and
host-specific settings. Preserve settings for the other hosts.

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
no concurrency limit. The backlog path is relative to the Git root. The Claude runner can
also be a Claude-compatible command prefix such as `ccsp -g <preset> claude`, or `in-session`.
Keep credentials in the native harness configuration.

Each host object accepts optional `models.low`, `models.medium`, and `models.high` entries
with `model` and/or `effort` strings. Use the model identifier and effort values accepted
by that harness. Pi model IDs use `provider/id`. Claude in-session model overrides use
the aliases accepted by its Agent tool. Review attempts discover available models and
supported effort from the actual backend when that interface is accessible.

Write valid JSON to the shared path. If `.code-review/` is unignored, ask before adding it
to the repository's `.gitignore`. Display the saved settings and normal/adversarial usage.
