# code-review

Review → verify → fix in one command, from the same session that wrote the code.

Replaces the manual loop of "open a second Claude Code session, run a review there, copy the
findings back, ask the first session to fix them". One command dispatches parallel read-only
reviewers (optionally on a **different model**), verifies their findings against the code,
fixes what is real, files what must wait, and reports.

## Commands

| command | what it does |
|---|---|
| `/code-review <target> [-c=N]` | One review round: 3 parallel reviewer angles (correctness, conventions, caller impact) → main agent verifies each finding → fixes confirmed in-scope issues, backlogs deferred ones, rejects false positives with reasons. |
| `/code-review:adversarial <target> [-c=N] [--max-rounds=N]` | The same round 1 plus a 4th angle (design/assumption challenge), then loops: fix → single re-review of the cumulative diff → fix … until a round yields no confirmed major/critical findings or `max_rounds` (default 3) is hit. |
| `/code-review:setup` | Interactive per-project configuration, written to `.claude/code-review.local.md`. Runs automatically on first use. |

The **review target** is always explicit — a commit sha or range, `staged`, `working-tree`,
file paths, or `branch <base>`. With no target the command asks; it never guesses.

## Cross-model review (the point)

The `runner` config is a command prefix used to launch each reviewer as a separate headless
process:

- `claude` (default) — separate process, same model. Works with zero configuration.
- `ccsp -g <preset> claude` — via [cc-settings-preset](https://github.com/lkangd/cc-settings-preset),
  reviewers run on whatever model the preset maps (e.g. a non-Anthropic model), while the
  fixing session keeps its own model. Any wrapper that ends in a `claude`-compatible CLI works.
- `in-session` — no external processes; reviewers are read-only subagents of the current
  session. Model tier is configurable (`in_session_model`), and tier aliases resolve correctly
  through `ANTHROPIC_DEFAULT_*_MODEL` remapping.

## How a round works

1. **Packet build**: the main agent collects the full diff, changed-file list, and relevant
   `CLAUDE.md` excerpts into one packet file — reviewers read it instead of re-exploring the
   repo N times.
2. **Fan-out**: one process/subagent per angle, batched by `concurrency` (`-c=N` per run).
3. **Verify & act**: the main agent confirms each finding against the code. Confirmed and in
   scope → fixed now. Confirmed but pre-existing / too large → one file per issue in the
   backlog (default `docs/code-review-backlog/`, git-tracked, with status tracking and a
   suggested fix approach). Not confirmed → rejected with a stated reason.
4. Nothing is ever committed by the plugin.

## Runaway protection

Built in response to a real incident where a re-entrant review skill recursively spawned 242
descendant agents:

- Reviewers are structurally unable to fan out: headless processes run with a read-only
  `--allowedTools` set and `Task`/`Skill` disallowed; the in-session agent has no delegation
  tools and runs with `permissionMode: plan` (note: its Bash is constrained by prompt rules
  plus the session permission system, not by a per-command allowlist — the external runner is
  the stricter of the two modes).
- `CODE_REVIEW_CHILD=1` sentinel: both commands refuse to run when it is set, and the runner
  script refuses to start when it is already set — recursion is blocked at two layers.
- Hard caps independent of model behavior: max 8 prompts per script call (script-enforced),
  max 4 reviewers in round 1 and exactly 1 per later round (command-enforced).
- Reviewers always inspect the current working tree — never worktree isolation, which cannot
  see uncommitted changes.
- All commands are `disable-model-invocation: true` — only the user can trigger them.

## Configuration

`.claude/code-review.local.md` (created by `/code-review:setup`):

```yaml
---
runner: claude              # or "ccsp -g <preset> claude", or "in-session"
concurrency: 0              # 0 = unlimited; -c=N overrides per run
max_rounds: 3               # adversarial loop cap; --max-rounds=N overrides
backlog_dir: docs/code-review-backlog
in_session_model: opus      # tier for in-session reviewers
---
```

Run artifacts (packets, prompts, reviewer output) go to `.claude/code-review/runs/` — setup
offers to gitignore it.
