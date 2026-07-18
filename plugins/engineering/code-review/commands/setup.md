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
exists. Then use `AskUserQuestion` (batch the questions; at most 4 per call):

1. **Reviewer runner** — how review processes are launched:
   - `Bare claude (default)` → `runner: claude`. Separate headless process, same model as the
     current session. Zero external dependencies.
   - `Custom command template` → e.g. `ccsp -g <preset> claude` to review with a different
     model. Only offer as recommended when ccsp was detected; collect the exact prefix via the
     option's free-text or a follow-up. The prefix must end in a `claude`-compatible CLI that
     accepts `-p`, `--allowedTools`, `--disallowedTools`, `--max-turns`.
   - `In-session subagents` → `runner: in-session`. No extra processes; reviewers run as
     read-only subagents in this session.
2. **Concurrency** — max reviewers at once: `Unlimited (default)` → `0`, or `2`, or `1`.
3. **Adversarial max rounds** — `3 (default)`, `2`, or `5`.
4. **Backlog directory** — where deferred findings are filed (tracked in git):
   `docs/code-review-backlog (default)` or a custom path.

## Write the config

Write `.claude/code-review.local.md`:

```markdown
---
runner: <answer>
concurrency: <answer>
max_rounds: <answer>
backlog_dir: <answer>
---

Configuration for the code-review plugin. Edit values above or re-run /code-review:setup.
```

## Housekeeping

- Review runs write packets under `.code-review/runs/` (repo root, deliberately outside
  `.claude/` whose tree rejects headless writes). Check `.gitignore`; if it does not cover that
  path, ask the user whether to append `.code-review/` to `.gitignore`, and do so if confirmed.
- Finish by showing the written config values and a one-line usage reminder:
  `/code-review <target>` and `/code-review:adversarial <target>`.
