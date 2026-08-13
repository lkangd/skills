# Code Review Core Workflow

Shared procedure for `/code-review` (single pass) and `/code-review:adversarial` (loop).
The command that sent you here tells you which mode you are in. Follow the steps in order.

Throughout this document, **review target** (审查内容) means whatever the user asked to review:
one or more commits, staged changes, the working tree, specific files, or a branch diff.
Never assume it is a pull request.

`PLUGIN_ROOT` below is the absolute plugin path the invoking command resolved and printed for
you. Substitute that literal path every time it appears — in Bash commands and in Read paths
alike. Never write `${CLAUDE_PLUGIN_ROOT}` into a tool call: that variable is not exported into
the Bash tool's shell, so it expands to an empty string and the call dies with exit 127 before
anything runs. If the command did not give you a path, resolve it yourself with
`bash -c 'ls -td "$HOME"/.claude/plugins/cache/*/code-review/*/scripts/run-orchestrator.sh | head -1'`
and take the directory two levels above the script.

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
Flags override config for this run only: `-c=N` → concurrency, `--max-rounds=N` (adversarial),
`--spec=<path>[,<path>…]` → explicit spec documents (§2.5).

## §2 Resolve the review target

The target must be explicit. Parse it from the arguments (a commit sha or range, `staged`,
`working-tree`, file paths, `branch <base>`, or a natural-language description that maps to one
of these).

If no target was given, do NOT pick one silently. Gather candidates cheaply
(`git log --oneline -3`, `git status --short`, `git diff --cached --stat | tail -1`) and use
`AskUserQuestion` to let the user choose.

## §2.5 Resolve the spec sources

The optional `spec` angle checks the change against what it was supposed to implement —
missing/partial requirements, scope creep, requirements implemented with contradicting
behavior. It needs one or more **spec documents** (issue text, PRD, plan, design doc).
Resolve them in this order; several documents at once are normal:

1. **Explicit flag**: every path from `--spec=<path>[,<path>…]`. Use them as-is.
2. **This session's context**: the review is often invoked from the same conversation that
   produced the change — if that context already contains the requirements (a plan you wrote,
   an issue or PRD the user pasted, a spec file you worked from), use them directly: collect
   the file paths, and write any requirements that exist only in conversation context to
   `RUN_DIR/spec-context.md` (create `RUN_DIR` first as in §3 step 1) and include that path.
   Only use requirements that actually governed this change — do not reconstruct a spec from
   your own guesses.
3. **Ask**: otherwise use one `AskUserQuestion` — "Review against a spec?" with options
   **"No spec — code-quality review only" (default, first)** and **"Provide spec document
   path(s)"**; the user supplies one or more paths (comma- or space-separated) via the
   option's free text. Verify each path exists before use.

With no spec source, omit the `spec` angle from the round and say so in the report (§7) —
never fabricate a spec, and never block the review on one.

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
   step 4. Launch command (`PLUGIN_ROOT` = the resolved absolute path; if
   `test -f "<PLUGIN_ROOT>/scripts/run-orchestrator.sh"` fails, the path is wrong — fix it
   before launching rather than sending a doomed background task):
   ```
   bash "PLUGIN_ROOT/scripts/run-orchestrator.sh" \
     --runner "<runner from config>" \
     --run-dir "RUN_DIR" \
     --target "<precise description of the review target>" \
     --diff-args "<arguments for git diff that produce the target's diff>" \
     --angles "<this round's angle list>" \
     --concurrency <resolved concurrency> \
     [--spec-file "<path>"]...                         # one flag per spec document (§2.5)
     [--known-issues-file "RUN_DIR/known-issues.md"]   # round 2+ only
   ```
   `--target` should state, beyond identifying the diff, any behavior the user or the
   requirements explicitly declared as intended (deliberate removals, accepted tradeoffs,
   a mandated approach) — reviewers and verifiers treat declared-intended behavior as
   not-a-defect and judge only its unhandled consequences. This is what keeps "you deleted
   X" findings from surfacing when deleting X was the task, even when no spec document
   was resolved.
   `--diff-args` by target type — single commit `X`: `X^..X`; commit range `A..B`: `A^..B`;
   staged: `--cached`; working tree: `HEAD`; files: `HEAD -- <paths>`; branch:
   `<base>...HEAD`.
   Angle lists — round 1 always dispatches the full 8-angle set (3 bug-hunting + 4
   cleanup/altitude + conventions):
   `/code-review` round 1:
   `correctness, removed-behavior, callers, reuse, simplification, efficiency, altitude, conventions`;
   `/code-review:adversarial` round 1: those plus `design, pitfalls, wrapper` (the presence
   of `design` also makes the orchestrator run a post-verification gap sweep); when §2.5
   resolved spec sources, append `spec` to the round-1 list and pass one `--spec-file` per
   document; any round 2+: `re-review` only — still pass the same `--spec-file` flags so the
   re-reviewer keeps the requirements as context.
   The script builds the orchestrator prompt AND the diff packet itself (fails fast on a bad
   diff spec) — never read or fill `references/orchestrator.md` in this session. It also
   enforces the `CODE_REVIEW_CHILD` sentinel and injects the read-only
   `reviewer-deep`/`reviewer`/`verifier` subagent definitions.
4. Read the result. The authoritative payload is **`RUN_DIR/out/findings.json`**: an array
   of finding objects (`severity`, `verdict`, `angle`, `title`, `file`, `line`, `evidence`,
   `why`, `suggestion`, `verdict_evidence`), already verified (verdict `CONFIRMED` or
   `PLAUSIBLE`; refuted candidates were dropped inside the orchestrator). The array is
   uncapped and ordered most severe first, correctness before cleanup at equal severity — a
   thorough adversarial round on a large diff can return 30–40 findings, which is a working
   list to triage in order, not a signal that something went wrong.
   `RUN_DIR/out/orchestrator.out` holds a two-line receipt (`CODE-REVIEW RESULT:` marker +
   stats); treat it as prose and survive its absence or translation. Fallback: if
   findings.json is missing or unparseable, use the **last fenced ```json block** in
   orchestrator.out. A failure is: a non-zero exit code, or neither a parseable
   findings.json nor a json block. On failure: the script has already auto-resumed
   the orchestrator session once internally, so do NOT blindly relaunch. Read
   `orchestrator.err`, confirm the process actually exited (`RUN_DIR/out/orchestrator.exit`
   exists), then resume — never restart — the round per "Resuming a failed round" below, at
   most once; if that also fails (e.g. quota exhausted until a stated reset time), report the
   failure and the exact resume command to the user and stop. Never have two orchestrators
   alive at once, and never relaunch from scratch for a round whose tokens are already spent.

While waiting, do nothing else — no speculative fixes, no other tasks.

### Resuming a failed round

A round whose orchestrator died is not lost: the packet, prompts, persisted task list
(`RUN_DIR/review-plan.json`, including immutable `requested_angles`), orchestrator session id
(`RUN_DIR/session-id`), and per-step
checkpoints (`RUN_DIR/out/candidates-*.json`, `verdicts-*.json`, `findings.json`) survive on
disk. Each new candidates checkpoint is an explicit
`{"status":"completed","findings":[...]}` receipt, so an empty findings array still proves
that exact planned task finished and must not be re-dispatched. Resume it — as a background
task, same as a launch — with:

```
bash "PLUGIN_ROOT/scripts/run-orchestrator.sh" --resume \
  --runner "<runner from config>" \
  --run-dir "<the failed RUN_DIR>"
```

The script first resumes the original orchestrator session (context intact, it continues at
the first incomplete step); if that yields no report it launches a fresh salvage session
that trusts the checkpoints and re-does only what is missing. On completion, continue at §3
step 4 as if the round had run normally. This also works across sessions: when the user asks
to resume a review that died earlier (e.g. after a usage-limit reset), locate the newest
`.code-review/runs/*/round-*` without a usable result (no non-empty `out/findings.json` and
no ` ```json ` block in `out/orchestrator.out`), confirm it with the user, and resume it
instead of starting a new round.

## §4 In-session mode (`runner: in-session`)

No external process: you act as the orchestrator yourself. Execute the procedure in
`PLUGIN_ROOT/references/orchestrator.md` directly in this session, with these
substitutions:

- The "launch parameters" that document references are the values you resolved in §1–§2;
  create `RUN_DIR` yourself as in §3 step 1.
- No launcher pre-builds the packet in-session: write `RUN_DIR/packet.md` yourself first —
  target description (stating declared-intended behavior, as §3 requires of `--target`),
  `git diff <args> --stat` list, known issues (round 2+), the spec documents from §2.5 (a
  `## Spec` section with one `### Spec document: <path>` block per document, before the
  diff, opening with the same intended-behavior note the launcher writes — required
  behavior is intended, only its uncovered consequences are findings; omit the section when
  there is no spec), and the full
  `git diff <args>` output, using the same `--diff-args` mapping as §3 — then continue with
  orchestrator.md Step 1's completion tasks (conventions, untracked files). Likewise
  concretize `RUN_DIR/prompts/<angle>.md` from the templates yourself (orchestrator.md
  Step 2 assumes the launcher did it; in-session there is none) — including
  `{{PACKET_NOTE}}`: measure the packet and tell reviewers whether it fits in one `Read`
  (the tool rejects anything over 25,000 tokens) or must be read in chunks, and at what
  chunk size.
- Create `RUN_DIR/review-plan.json` alongside the prompts with one `{id, angle, prompt}` task
  per angle and `status: ready`; for a large diff, persist concrete slice prompt files and use
  one task per slice instead. Before every initial/resume dispatch, run
  `scripts/findings.sh pending --run-dir RUN_DIR` and dispatch exactly those task IDs. Then run
  `prepare` before verification and `build` before reporting instead of doing that bookkeeping
  by hand.
- Dispatch angle reviewers and verifiers via the `Agent` tool with
  `subagent_type: "code-review:reviewer"` and `run_in_background: false`.
- Choose the model per dispatch with the `model` parameter using tier aliases
  (opus = complex angles, sonnet = moderate angles and verifiers), matching the tier
  guidance in orchestrator.md. Aliases resolve through `ANTHROPIC_DEFAULT_*_MODEL` remapping
  automatically.
- The orchestrator's budget caps (≤ 13 reviewers including large-diff splits and the
  optional `spec` angle, plus the Step 3.5 sweep, ≤ 10 verifiers, total 24) apply unchanged.
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
  `PLUGIN_ROOT/references/backlog-template.md`. Glob the backlog dir first and update
  an existing entry instead of duplicating.
- **Not confirmed** → record why the finding is wrong (you will report this; do not fix).

Work the list in its given order and account for every entry — a long list is triaged, never
truncated. When it runs long, the cheap move is to batch the tail: `minor`/`nit` cleanup
findings that are real but not worth interrupting this change for go to the backlog together,
one entry each, rather than being dropped or silently skipped. Say so in the report.

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
- Spec: which spec documents the round reviewed against, or one line that the spec angle
  was skipped because no spec source was resolved (§2.5).
- Adversarial: rounds executed and why the loop stopped.
- Paths: `RUN_DIR` and any backlog files written.
- Remind the user that nothing was committed.
