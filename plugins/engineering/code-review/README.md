# code-review

Review → verify → fix in one command, from the same session that wrote the code.

Replaces the manual loop of "open a second Claude Code session, run a review there, copy the
findings back, ask the first session to fix them". One command dispatches parallel read-only
reviewers (optionally on a **different model**), verifies their findings against the code,
fixes what is real, files what must wait, and reports.

## Commands

| command | what it does |
|---|---|
| `/code-review <target> [-c=N] [--spec=<path>,...]` | One review round: 8 parallel reviewer angles (line-by-line correctness, removed-behavior audit, cross-file callers, reuse, simplification, efficiency, altitude, documented conventions — CLAUDE.md, CONTRIBUTING, coding standards) plus an optional spec-conformance angle when a spec source is resolved → independent verifiers confirm/refute each candidate → main agent re-verifies → fixes confirmed in-scope issues, backlogs deferred ones, rejects false positives with reasons. |
| `/code-review:adversarial <target> [-c=N] [--max-rounds=N]` | The same round 1 plus three deep angles (design/assumption challenge, language-pitfall specialist, wrapper/proxy correctness) and a post-verification gap sweep, then loops: fix → single re-review of the cumulative diff → fix … until a round yields no confirmed major/critical findings or `max_rounds` (default 3) is hit. |
| `/code-review:setup` | Interactive per-project configuration, written to `.claude/code-review.local.md`. Runs automatically on first use. |

The **review target** is always explicit — a commit sha or range, `staged`, `working-tree`,
file paths, or `branch <base>`. With no target the command asks; it never guesses.

**Spec conformance** is an optional extra angle: given one or more spec documents (issue,
PRD, plan — multiple at once are supported), a dedicated reviewer checks the diff against
them for missing/partial requirements, scope creep, and requirements implemented with
contradicting behavior, quoting the spec line per finding. Spec sources resolve in order:
explicit `--spec=<path>[,<path>…]` → documents already in the invoking session's context
(the usual case when reviewing from the session that wrote the code) → one question with
**no spec** as the default and a free-text option to paste path(s). With no source the
angle is skipped and the report says so.

Requirement-declared behavior is suppressed **inside** the pipeline, not rejected after the
fact: reviewers and the verifier treat behavior the packet's Target or Spec section declares
as required as intended — never a finding in itself — while its unhandled consequences (a
stale caller left behind, an invariant lost that no requirement supersedes) still surface.
Without this, a deliberate module removal comes back as a confirmed "removed route with no
replacement" finding that the main session must reject by hand.

## Cross-model review (the point)

The `runner` config is a command prefix used to launch the orchestrator as a separate headless
process:

- `claude` (default) — separate process, same model. Works with zero configuration.
- `ccsp -g <preset> claude` — via [cc-settings-preset](https://github.com/lkangd/cc-settings-preset),
  the whole review pipeline runs on whatever model the preset maps (e.g. a non-Anthropic
  model), while the fixing session keeps its own model. Any wrapper that ends in a
  `claude`-compatible CLI works.
- `in-session` — no external process; the current session executes the orchestrator procedure
  itself with read-only subagents.

> **Tier remapping caveat**: subagent tiers resolve through the preset's
> `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, but the gateway behind the preset must actually
> serve those model names as distinct models — some (e.g. bigmodel's Anthropic endpoint) silently
> route unknown or retired names to their flagship, collapsing all tiers into one. Verify with a
> minimal `claude -p ... --agents '{"t":{"model":"haiku",...}}' --output-format json` run: the
> `modelUsage` keys must list one entry per tier. Session transcripts are not evidence — they
> record the gateway's echoed model name, not what was requested.

> **Inherited hooks caveat**: the orchestrator is a normal Claude Code session, so your
> user-level `~/.claude/settings.json` hooks apply to it too. A `PreToolUse` hook that
> rewrites or blocks Bash commands will fire on the orchestrator's own tooling — one observed
> round lost three turns to a hook rejecting `jq --slurpfile` as dangerous. If a round stalls
> on shell commands, check `RUN_DIR/out/orchestrator.err` and the hook's own logs before
> suspecting the plugin.

## How a round works

The current session never orchestrates. It resolves the review target, launches **one**
orchestrator session, and acts on the consolidated result.

1. **Orchestrate (inside the orchestrator session)**:
   - completes the review packet — the launcher script already wrote the target, `--stat`
     list, and full diff into it, and pre-concretized every angle-prompt file (both at zero
     model-token cost, outside the session); the orchestrator appends relevant `CLAUDE.md`
     excerpts and untracked-file content. Reviewers read the packet instead of re-exploring
     the repo N times, under an explicit turn budget (batched tool calls, ~15 calls max);
   - dispatches one read-only reviewer **subagent** per angle — or, when the diff exceeds
     ~1,500 lines, several per high-risk angle, each restricted to a coherent file-group slice —
     choosing the model tier by task complexity (opus = bug-hunting angles, sonnet = cleanup
     and moderate angles), batched by `concurrency` (`-c=N` per run). Reviewers are
     **recall-biased**: they pass every candidate with a nameable failure scenario through
     instead of self-censoring — filtering is the verify pass's job. Every reviewer returns a
     `{"status":"completed","findings":[...]}` receipt; an empty `findings` array explicitly
     records a successful zero-finding review, so interrupted runs never repeat that angle;
   - **verifies** every candidate with independent verifier subagents that return
     `CONFIRMED` / `PLAUSIBLE` / `REFUTED` per candidate (PLAUSIBLE is the default; REFUTED
     requires evidence constructible from the code) and drops only the refuted ones;
   - writes the consolidated findings array to `RUN_DIR/out/findings.json` (the
     authoritative payload the main session parses) and ends with a two-line
     `CODE-REVIEW RESULT` receipt — every inter-agent handoff (reviewer → orchestrator →
     verifier → main session) is JSON with ASCII keys, so a non-English-tuned runner model
     cannot break the protocol by translating labels, and the findings JSON is generated
     once, never re-emitted through the model.

   The bookkeeping between those steps — normalizing paths, numbering candidates, splitting
   them into verifier batches, joining verdicts back on — is done by `scripts/findings.sh`,
   not by the model. **findings.json is uncapped**: every candidate that survives
   verification is reported, ordered most severe first. An earlier 12-finding cap (a leftover
   from when findings were inlined in the final message) was observed discarding 2 critical
   and 8 major verified findings in a single round.
2. **Verify & act (back in the current session)**: the main agent re-confirms each surviving
   finding against the code. Confirmed and in scope → fixed now. Confirmed but pre-existing /
   too large → one file per issue in the backlog (default `docs/code-review-backlog/`,
   git-tracked, with status tracking and a suggested fix approach). Not confirmed → rejected
   with a stated reason.
3. Nothing is ever committed by the plugin.

## Runaway protection

Built in response to a real incident where a re-entrant review skill recursively spawned 242
descendant agents:

- Reviewers and verifiers are structurally unable to fan out: they are subagents injected into
  the orchestrator via `--agents` with tool allowlists containing no `Task`, no `Skill`, and no
  write tools; the orchestrator itself runs with `Skill` disallowed and inspection-grade Bash
  only. The in-session agent likewise has no delegation tools and runs with
  `permissionMode: plan`.
- `CODE_REVIEW_CHILD=1` sentinel: both commands refuse to run when it is set, and the
  orchestrator script refuses to start when it is already set — recursion is blocked at two
  layers.
- Hard caps independent of model behavior: exactly one orchestrator process per round
  (the script builds the single orchestrator prompt itself from its flags), and inside it at
  most 13 angle reviewers (large diffs split into file-group slices and the optional spec
  angle count against this), one adversarial gap sweep, and at most 10 verifiers.
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
---
```

> **Cheaper orchestrator**: the orchestrator session itself runs on the runner's default
> model (often the flagship). Its work is mostly mechanical — appending a `--model` flag to
> the runner string (e.g. `ccsp -g <preset> claude --model sonnet`) moves orchestration to a
> mid tier while reviewer/verifier tiers stay as declared, typically shaving ~15% off a
> round with no effect on finding quality. Validate once before adopting: the orchestrator
> still needs to follow the dispatch/dedup protocol reliably.

Run artifacts (packets, prompts, reviewer output) go to `.code-review/runs/` — setup offers to
gitignore it. The directory sits at the repo root on purpose: anything under `.claude/` is
covered by Claude Code's sensitive-file protection, which auto-denies the headless
orchestrator's writes.

## Crash resilience

A review round is 10–40+ minutes of reviewer tokens; an API error in the last turn must not
discard them. Three layers ensure it doesn't:

- The launcher persists `RUN_DIR/review-plan.json` and runs a transcript harvester beside the
  orchestrator. Each completed reviewer/verifier tool result is validated and atomically
  checkpointed to `RUN_DIR/out/` immediately (`candidates-<task-id>.json` or
  `verdicts-<n>.json`) even when other calls in the same parallel wave are still running. This
  avoids the parent model's all-tools barrier: one slow or failed Agent cannot strand already
  completed siblings in the transcript. Resume runs `findings.sh pending` against the plan, so
  completed zero-finding tasks are skipped while missing or invalid receipts remain pending.
- The launcher pins the orchestrator's `--session-id` (saved to `RUN_DIR/session-id`) and,
  when the session dies without a parseable report, **auto-resumes it once** — the resumed
  session continues at the first incomplete step instead of starting over.
- `/code-review resume [<run-dir>]` re-enters a failed round later — e.g. after a usage-limit
  reset, from a brand-new session. It resumes the original orchestrator session first; if
  that transcript is unusable (e.g. it reproduces the fatal API error), it falls back to a
  fresh salvage session that trusts the on-disk plan and checkpoints and re-runs only what is
  missing. Pre-plan runs with unsliced legacy checkpoints are migrated from their persisted
  launch prompt; legacy sliced runs fail closed because their original slice scope is not
  recoverable.
