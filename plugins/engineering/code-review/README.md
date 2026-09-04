# code-review

Review → verify → fix in one command, from the same session that wrote the code.

Replaces the manual loop of "open a second Claude Code session, run a review there, copy the
findings back, ask the first session to fix them". One command dispatches parallel read-only
reviewers (optionally on a **different model**), verifies their findings against the code,
fixes what is real, files what must wait, and reports.

## Commands

| command | what it does |
|---|---|
| `/code-review <target> [-c=N] [--spec=<path>,...]` | One review round: 5 parallel reviewer angles — three bug hunters (line-by-line correctness, removed-behavior audit, cross-file callers), one `cleanup` reviewer covering reuse / simplification / altitude / efficiency, and documented conventions (CLAUDE.md, CONTRIBUTING, coding standards; skipped automatically when the repo has none) — plus an optional spec-conformance angle when a spec source is resolved → independent verifiers confirm/refute each bug-class candidate (cleanup candidates pass through marked unverified) → main agent re-verifies → fixes confirmed in-scope issues, backlogs deferred ones, rejects false positives with reasons. |
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
> suspecting the plugin. `Stop` hooks are the other cost: they fire once per orchestrator
> turn, so a hook that spawns a process adds its runtime 15–20 times per round.

> **Background subagents**: Claude Code runs `Agent` calls in the background by default in
> recent versions, and some gateway models background every dispatch regardless of the
> prompt. The launcher sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` to keep reviewers in the
> foreground (where the orchestrator's turn waits for them), and the transcript harvester
> also understands the `<task-notification>` messages a backgrounded agent reports through,
> so checkpoints are written either way.

> **Third-party gateways and prompt caching**: the packet-in-system-prompt design pays off
> only when the gateway serves prompt-cache reads. Observed hit rates: Anthropic and the
> Kimi/GLM endpoints 85–95%; GPT-family endpoints behind ccsp 2–10%, i.e. every reviewer
> turn re-pays the whole packet. On such a gateway prefer `concurrency: 4`, a narrower
> target, or a runner preset whose reviewer tiers point at a caching model.

## How a round works

The current session never orchestrates. It resolves the review target, launches **one**
orchestrator session, and acts on the consolidated result.

1. **Orchestrate (inside the orchestrator session)**:
   - starts dispatching immediately — the launcher script already built the review packet
     (target, `--stat` list, spec documents, full diff) and its addendum (convention
     documents such as `CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md`, untracked-file content
     for working-tree targets), pre-concretized every angle-prompt file, and embedded the
     packet verbatim in the system prompt of the reviewer and verifier agent definitions
     (all at zero model-token cost, outside the session). Reviewers thus start with the
     whole diff in context instead of re-exploring the repo N times, under an explicit turn
     budget (batched tool calls, ~12 calls, and a hard `maxTurns` of 20 in the agent
     definition — a runaway reviewer is cut off and retried once, never left to burn
     50M tokens);
   - dispatches one read-only reviewer **subagent** per angle — or, when the diff exceeds
     ~1,500 lines, several per high-risk angle, each restricted to a coherent file-group slice —
     choosing the model tier by task complexity (opus = bug-hunting angles, sonnet = cleanup
     and moderate angles), batched by `concurrency` (`-c=N` per run). Reviewers are
     **recall-biased**: they pass every candidate with a nameable failure scenario through
     instead of self-censoring — filtering is the verify pass's job. Every reviewer returns a
     `{"status":"completed","findings":[...]}` receipt; an empty `findings` array explicitly
     records a successful zero-finding review, so interrupted runs never repeat that angle;
   - **verifies** every bug-class candidate with independent verifier subagents that return
     `CONFIRMED` / `PLAUSIBLE` / `REFUTED` per candidate (PLAUSIBLE is the default; REFUTED
     requires evidence constructible from the code) and drops only the refuted ones.
     Cleanup-class candidates (reuse, simplification, altitude, efficiency) skip the
     verifier — across 458 observed candidates verifiers refuted 7% of them while consuming
     half of all verifier time — and reach the report marked `unverified: true` for the main
     session to judge;
   - writes the consolidated findings array to `RUN_DIR/out/findings.json` (the
     authoritative payload the main session parses) and ends with a two-line
     `CODE-REVIEW RESULT` receipt — every inter-agent handoff (reviewer → orchestrator →
     verifier → main session) is JSON with ASCII keys, so a non-English-tuned runner model
     cannot break the protocol by translating labels, and the findings JSON is generated
     once, never re-emitted through the model.

   The bookkeeping between those steps — normalizing paths, numbering candidates, merging
   literal repeats, splitting them into verifier batches, joining verdicts back on, marking
   findings whose file changed under the review as `stale` — is done by `scripts/findings.sh`,
   not by the model. **findings.json is uncapped**: every candidate that survives
   verification is reported, ordered most severe first. An earlier 12-finding cap (a leftover
   from when findings were inlined in the final message) was observed discarding 2 critical
   and 8 major verified findings in a single round.
2. **Verify & act (back in the current session)**: the main agent re-confirms each surviving
   finding against the code (`stale` ones first, `unverified` ones with extra care).
   Confirmed and in scope → fixed now. Confirmed but pre-existing /
   too large → one file per issue in the backlog (default `docs/code-review-backlog/`,
   git-tracked, with status tracking and a suggested fix approach). Not confirmed → rejected
   with a stated reason.
3. Nothing is ever committed by the plugin.

## Runaway protection

Built in response to a real incident where a re-entrant review skill recursively spawned 242
descendant agents:

- Reviewers and verifiers are structurally unable to fan out: they are per-run agent files
  (`RUN_DIR/agents/.claude/agents/`, loaded into the orchestrator via `--add-dir`) with tool
  allowlists containing no `Task`, no `Skill`, and no write tools; the orchestrator itself runs
  with `Skill` disallowed and inspection-grade Bash only, and is told never to request the
  `fork` subagent type (a fork would inherit its full tool pool). The in-session agent likewise
  has no delegation tools and runs with `permissionMode: plan`.
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
concurrency: 0              # 0 = unlimited; -c=N overrides per run (setup suggests 4 for
                            # third-party gateways, whose rate limits turn 8 parallel
                            # reviewers into 429 retries)
max_rounds: 3               # adversarial loop cap; --max-rounds=N overrides
backlog_dir: docs/code-review-backlog
---
```

Environment knobs read by the launcher: `CODE_REVIEW_REVIEWER_MAX_TURNS` (default 20) and
`CODE_REVIEW_VERIFIER_MAX_TURNS` (default 15) set the per-agent `maxTurns` budget.

> **Where the tokens go**: the dominant per-round input cost was never the subagents' fixed
> prefix (system prompt, CLAUDE.md, tools — identical across siblings and already served from
> the prompt cache) but the packet: 12–24 fresh subagents each `Read` the same 30k-token file,
> and a tool result sitting behind a per-angle prompt is never shared. The launcher therefore
> embeds the packet in each agent definition's system prompt, so siblings of one tier share
> an identical prefix and the first reviewer's cache write serves the rest at cache-read
> price; it also removes the chunked reads the 25,000-token `Read` cap used to force. Claude
> Code's `fork` subagents (`/subtask`) get their cheapness from the same identical-prefix
> property, but were rejected here: a fork runs on the parent's model (no tier split),
> inherits the parent's full tool pool (no read-only guarantee), forces background dispatch
> in the headless session, and would hand every verifier the other reviewers' raw findings.
> Whether the cache pays out depends on the gateway behind `runner` honoring prompt caching;
> without it the change is still a net turn reduction, never a regression.

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
