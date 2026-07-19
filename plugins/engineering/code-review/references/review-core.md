# Code Review Core Workflow

Shared procedure for `/code-review` (single pass) and `/code-review:adversarial` (loop).
The command that sent you here tells you which mode you are in. Follow the steps in order.

Throughout this document, **review target** (审查内容) means whatever the user asked to review:
one or more commits, staged changes, the working tree, specific files, or a branch diff.
Never assume it is a pull request.

## Division of labor

You (the current session) do NOT orchestrate the review. The entire pipeline — diff
collection, reviewer dispatch, finding verification, consolidation — runs inside one dedicated
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
- Reviewers and verifiers are read-only subagents of the orchestrator; never spawn review
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
3. Launch the script as a **background task** (`run_in_background: true`) — this is
   mandatory, not an optimization. The script blocks for the entire review (10–40+ min),
   far beyond the foreground Bash tool timeout: a foreground launch gets killed at the
   timeout, wasting every reviewer token spent so far. Do not pass a `timeout`. After
   launching, do NOT busy-wait: no `sleep` loops, no repeated file reads — end your turn
   and wait for the harness's background-task completion notification, then continue at
   step 4. Launch command:
   ```
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/run-orchestrator.sh" \
     --runner "<runner from config>" \
     --run-dir "RUN_DIR" \
     --target "<precise description of the review target>" \
     --diff-args "<arguments for git diff that produce the target's diff>" \
     --angles "<this round's angle list>" \
     --concurrency <resolved concurrency> \
     [--known-issues-file "RUN_DIR/known-issues.md"]   # round 2+ only
   ```
   `--diff-args` by target type — single commit `X`: `X^..X`; commit range `A..B`: `A^..B`;
   staged: `--cached`; working tree: `HEAD`; files: `HEAD -- <paths>`; branch:
   `<base>...HEAD`.
   Angle lists — round 1 always dispatches the full 8-angle set (3 bug-hunting + 4
   cleanup/altitude + conventions):
   `/code-review` round 1:
   `correctness, removed-behavior, callers, reuse, simplification, efficiency, altitude, conventions`;
   `/code-review:adversarial` round 1: those plus `design, pitfalls, wrapper` (the presence
   of `design` also makes the orchestrator run a post-verification gap sweep); any round 2+:
   `re-review` only.
   The script builds the orchestrator prompt AND the diff packet itself (fails fast on a bad
   diff spec) — never read or fill `references/orchestrator.md` in this session. It also
   enforces the `CODE_REVIEW_CHILD` sentinel and injects the read-only
   `reviewer-deep`/`reviewer`/`verifier` subagent definitions.
4. Read `RUN_DIR/out/orchestrator.out`. The authoritative payload is the **last fenced
   ```json block**: an array of finding objects (`severity`, `verdict`, `angle`, `title`,
   `file`, `line`, `evidence`, `why`, `suggestion`, `verdict_evidence`), already verified
   (verdict `CONFIRMED` or `PLAUSIBLE`; refuted candidates were dropped inside the
   orchestrator). The `CODE-REVIEW RESULT:` marker line above it carries the stats; treat it
   as prose and survive its absence or translation — only a missing/unparseable json block
   (or a non-zero exit code) is a failure: read `orchestrator.err`, report the failure to the
   user, and stop — relaunch at most once, and only if the failure was clearly environmental
   AND you have confirmed the previous orchestrator process actually exited
   (`RUN_DIR/out/orchestrator.exit` exists). Never have two orchestrators alive at once, and
   never relaunch to "retry" a round whose tokens are already spent unless the report is
   truly unusable.

While waiting, do nothing else — no speculative fixes, no other tasks.

## §4 In-session mode (`runner: in-session`)

No external process: you act as the orchestrator yourself. Execute the procedure in
`${CLAUDE_PLUGIN_ROOT}/references/orchestrator.md` directly in this session, with these
substitutions:

- The "launch parameters" that document references are the values you resolved in §1–§2;
  create `RUN_DIR` yourself as in §3 step 1.
- No launcher pre-builds the packet in-session: write `RUN_DIR/packet.md` yourself first —
  target description, `git diff <args> --stat` list, known issues (round 2+), and the full
  `git diff <args>` output, using the same `--diff-args` mapping as §3 — then continue with
  orchestrator.md Step 1's completion tasks (conventions, untracked files).
- Dispatch angle reviewers and verifiers via the `Agent` tool with
  `subagent_type: "code-review:reviewer"` and `run_in_background: false`.
- Choose the model per dispatch with the `model` parameter using tier aliases
  (opus = complex angles, sonnet = moderate angles and verifiers), matching the tier
  guidance in orchestrator.md. Aliases resolve through `ANTHROPIC_DEFAULT_*_MODEL` remapping
  automatically.
- The orchestrator's budget caps (≤ 12 reviewers including large-diff splits, ≤ 10 verifiers,
  total 22) apply unchanged.
- Then continue at §5 with the surviving (CONFIRMED / PLAUSIBLE) findings.

## §5 Verify findings and act

For each finding in the consolidated report, verify it yourself against the actual code — the
orchestrator's verdict is a strong signal, not a substitute for your own check. `CONFIRMED`
findings come with a named trigger: check the quoted evidence holds. `PLAUSIBLE` findings have
a real mechanism but an uncertain trigger: decide yourself whether the trigger is realistic
before acting — the finding's `verdict_evidence` field says what would confirm it. Then
classify:

- **Confirmed, in scope** → fix it now with the smallest change that resolves it. For
  cleanup/altitude/conventions findings "confirmed" means the cost is real and the suggested
  simpler/deeper form actually works.
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

- Per finding: severity, orchestrator verdict (CONFIRMED/PLAUSIBLE), `file:line`, angle,
  disposition (**fixed** / **backlogged** with file path / **rejected** with one-line
  reason).
- Adversarial: rounds executed and why the loop stopped.
- Paths: `RUN_DIR` and any backlog files written.
- Remind the user that nothing was committed.
