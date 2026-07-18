# Code Review Core Workflow

Shared procedure for `/code-review` (single pass) and `/code-review:adversarial` (loop).
The command that sent you here tells you which mode you are in. Follow the steps in order.

Throughout this document, **review target** (审查内容) means whatever the user asked to review:
one or more commits, staged changes, the working tree, specific files, or a branch diff.
Never assume it is a pull request.

## Division of labor

You (the current session) do NOT orchestrate the review. The entire pipeline — diff
collection, reviewer dispatch, confidence scoring, consolidation — runs inside one dedicated
orchestrator session launched through the configured runner. Your job is only:

1. resolve the review target,
2. launch the orchestrator and wait,
3. act on its consolidated report (verify → fix / backlog / reject),
4. report to the user.

Exception: when config sets `runner: in-session`, there is no external process — you execute
the orchestrator procedure yourself (§4).

## §0 Safety rules (non-negotiable)

- If the `CODE_REVIEW_CHILD` sentinel printed by the command is non-empty, you are inside a
  reviewer/orchestrator process. Refuse and stop.
- Launch at most ONE orchestrator process per round, via the bundled script only. Never invoke
  the runner ad hoc, and never call the script twice in a round.
- Reviewers and scorers are read-only subagents of the orchestrator; never spawn review
  subagents from the current session in external mode.
- Never use worktree isolation anywhere in this workflow.
- Never commit, push, stage, or revert anything unless the user explicitly asks.

## §1 Load configuration

Read `.claude/code-review.local.md` in the project root. Its YAML frontmatter:

| field | default | meaning |
|---|---|---|
| `runner` | `claude` | Command prefix that launches the orchestrator session, e.g. `ccsp -g gpt claude`. Special value `in-session`: no external process (§4). |
| `concurrency` | `0` | Max reviewer subagents at once inside the orchestrator. `0` = no limit. |
| `max_rounds` | `3` | Adversarial loop cap. |
| `backlog_dir` | `docs/code-review-backlog` | Where deferred findings are filed. |

If the file does not exist, run the setup flow from `commands/setup.md` first, then continue.
Flags override config for this run only: `-c=N` → concurrency, `--max-rounds=N` (adversarial).

## §2 Resolve the review target

The target must be explicit. Parse it from the arguments (a commit sha or range, `staged`,
`working-tree`, file paths, `branch <base>`, or a natural-language description that maps to one
of these).

If no target was given, do NOT pick one silently. Gather candidates cheaply
(`git log --oneline -3`, `git status --short`, `git diff --cached --stat | tail -1`) and use
`AskUserQuestion` to let the user choose.

## §3 Launch the orchestrator (external mode)

1. Set `RUN_DIR=.code-review/runs/<yyyymmdd-HHMMSS>/round-<N>/` (repo root, NOT under
   `.claude/` — Claude Code's sensitive-file protection auto-denies headless writes there).
   The launcher script creates it.
2. Round 2+ only: write the known-issues list (§6) to `RUN_DIR/known-issues.md`.
3. Launch, with `run_in_background: true`, then poll until it finishes:
   ```
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/run-orchestrator.sh" \
     --runner "<runner from config>" \
     --run-dir "RUN_DIR" \
     --target "<precise description of the review target plus the exact git diff command(s) that produce it>" \
     --angles "<this round's angle list>" \
     --concurrency <resolved concurrency> \
     [--known-issues-file "RUN_DIR/known-issues.md"]   # round 2+ only
   ```
   Angle lists: `/code-review` round 1: `correctness, conventions, callers`;
   `/code-review:adversarial` round 1: those plus `design`; any round 2+: `re-review` only.
   The script builds the orchestrator prompt itself — never read or fill
   `references/orchestrator.md` in this session. It also enforces the `CODE_REVIEW_CHILD`
   sentinel and injects the read-only `reviewer-deep`/`reviewer`/`scorer` subagent definitions.
4. Read `RUN_DIR/out/orchestrator.out`. It contains a `CODE-REVIEW RESULT:` header followed by
   zero or more finding blocks, each already confidence-scored (only ≥ 80 survive). If the
   exit code is non-zero, read `orchestrator.err`, report the failure to the user, and stop —
   relaunch at most once, and only if the failure was clearly environmental.

While waiting, do nothing else — no speculative fixes, no other tasks.

## §4 In-session mode (`runner: in-session`)

No external process: you act as the orchestrator yourself. Execute the procedure in
`${CLAUDE_PLUGIN_ROOT}/references/orchestrator.md` directly in this session, with these
substitutions:

- The "launch parameters" that document references are the values you resolved in §1–§2;
  create `RUN_DIR` yourself as in §3 step 1.
- Dispatch angle reviewers and scorers via the `Agent` tool with
  `subagent_type: "code-review:reviewer"` and `run_in_background: false`.
- Choose the model per dispatch with the `model` parameter using tier aliases
  (opus = complex angles, sonnet = moderate angles, haiku = scorers), matching the tier
  guidance in orchestrator.md. Aliases resolve through `ANTHROPIC_DEFAULT_*_MODEL` remapping
  automatically.
- The orchestrator's budget caps (≤ 6 reviewers including large-diff splits, ≤ 10 scorers,
  total 16) apply unchanged.
- Then continue at §5 with the surviving (≥ 80) findings.

## §5 Verify findings and act

For each finding in the consolidated report, verify it yourself against the actual code — the
confidence score is a strong signal, not a substitute for your own check. Then classify:

- **Confirmed, in scope** → fix it now with the smallest change that resolves it.
- **Confirmed, but out of scope** (pre-existing, or the fix is large/risky relative to the
  review target) → file it in the backlog: one file per issue in `backlog_dir` following
  `${CLAUDE_PLUGIN_ROOT}/references/backlog-template.md`. Glob the backlog dir first and update
  an existing entry instead of duplicating.
- **Not confirmed** → record why the finding is wrong (you will report this; do not fix).

Do not soften findings to avoid work, and do not "fix" things no reviewer flagged.

## §6 Loop protocol (adversarial mode only)

After round N's fixes:

1. Continue only if round N produced at least one **confirmed major/critical** finding that you
   fixed. Stop when a round yields none, or when `max_rounds` is reached.
2. Round N+1 launches the orchestrator again (§3) with `--angles "re-review"` and a
   `--target` describing the cumulative view: the original review target's diff plus all
   uncommitted fix changes.
3. `RUN_DIR/known-issues.md` (passed via `--known-issues-file`) = one line per already-handled
   issue from all previous rounds: `- [fixed|backlogged|rejected] <file>: <one-line summary>`.
   One line each — never paste backlog file contents.

## §7 Report

End with a single consolidated report:

- Per finding: severity, confidence score, `file:line`, angle, verdict (**fixed** /
  **backlogged** with file path / **rejected** with one-line reason).
- Adversarial: rounds executed and why the loop stopped.
- Paths: `RUN_DIR` and any backlog files written.
- Remind the user that nothing was committed.
