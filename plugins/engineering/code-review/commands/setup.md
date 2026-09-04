---
description: Configure the code-review plugin for this project (runner, concurrency, rounds, backlog)
disable-model-invocation: true
allowed-tools:
  - Bash(printenv:*)
  - Bash(command:*)
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

Configure the code-review plugin for the current project by writing
`.claude/code-review.local.md`. If the file already exists, read it first and use its values as
the defaults in the questions below, then overwrite with the answers.

## Questions

Detect first: `command -v ccsp` (is ccsp installed?), and whether `.claude/code-review.local.md`
exists. Then ask ALL FOUR questions below in ONE `AskUserQuestion` call (4 questions, single
call). Never skip a question or silently fill a default — even when the default is obviously
right, the user must pick it explicitly; a config value the user never saw is a misconfiguration
waiting to surface. Only values from answers (or the existing config on re-run) may be written:

1. **Reviewer runner** — how review processes are launched:
   - `Bare claude (default)` → `runner: claude`. Separate headless process, same model as the
     current session. Zero external dependencies.
   - `Custom command template` → e.g. `ccsp -g <preset> claude` to review with a different
     model. Only offer as recommended when ccsp was detected; collect the exact prefix via the
     option's free-text or a follow-up. The prefix must end in a `claude`-compatible CLI that
     accepts `-p`, `--allowedTools`, `--disallowedTools`, `--max-turns`.
   - `In-session subagents` → `runner: in-session`. No extra processes; reviewers run as
     read-only subagents in this session.
2. **Concurrency** — max reviewers at once: `Unlimited` → `0`, `4`, `2`, or `1`. Mark
   `Unlimited` as the default when the runner is bare `claude`, and `4` as the default when it
   is a custom command template (a third-party gateway): observed rounds on such gateways
   turned 8 parallel reviewers into 429/500 retries and re-dispatches that cost more wall time
   than the parallelism saved.
3. **Adversarial max rounds** — `3 (default)`, `2`, or `5`.
4. **Backlog directory** — where deferred findings are filed (tracked in git):
   `docs/code-review-backlog (default)` or a custom path.

## Write the config

Write `.claude/code-review.local.md`:

```markdown
---
runner: <answer>
concurrency: <answer>   # 0 = unlimited: all reviewers dispatched at once
max_rounds: <answer>
backlog_dir: <answer>
---

Configuration for the code-review plugin. Edit values above or re-run /code-review:setup.
```

## Housekeeping

- **Tier check for ccsp presets**: when the runner is `ccsp -g <preset> …`, Read
  `~/.ccsp/settings/<preset>.json` (skip silently if absent) and compare its
  `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`
  values (top level or under `env`). If two or more are the same model — or any is unset while
  the others are set — tell the user in one line that reviewer tiers collapse onto one model
  for this preset (the plugin's opus/sonnet split then saves nothing) and which preset key to
  edit. Do not change the preset. Also mention, when the mapped models are GPT-family, that
  those gateways have shown 2–10% prompt-cache hit rates in this plugin, so `concurrency: 4`
  and narrower targets matter more there.
- Review runs write packets under `.code-review/runs/` (repo root, deliberately outside
  `.claude/` whose tree rejects headless writes). Check `.gitignore`; if it does not cover that
  path, ask the user whether to append `.code-review/` to `.gitignore`, and do so if confirmed.
  Migration: if `.gitignore` still contains the retired `.claude/code-review/` entry (written by
  setup versions before the run dir moved), replace it with `.code-review/` in the same spot —
  no need to ask.
- Finish by showing the written config values and a one-line usage reminder:
  `/code-review <target>` and `/code-review:adversarial <target>`.
