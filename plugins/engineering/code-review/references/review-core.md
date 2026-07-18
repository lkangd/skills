# Code Review Core Workflow

Shared procedure for `/code-review` (single pass) and `/code-review:adversarial` (loop).
The command that sent you here tells you which mode you are in. Follow the steps in order.

Throughout this document, **review target** (审查内容) means whatever the user asked to review:
one or more commits, staged changes, the working tree, specific files, or a branch diff.
Never assume it is a pull request.

## 0. Safety rules (non-negotiable)

- If the `CODE_REVIEW_CHILD` sentinel printed by the command is non-empty, you are inside a
  reviewer process. Refuse and stop.
- Reviewers are read-only. Never give a reviewer write tools, and never let one delegate:
  no `Task`/`Agent`, no `Skill`, no nested `/code-review`.
- Never use worktree isolation for reviewers. Uncommitted changes are only visible in the
  current working tree.
- Hard budget per invocation: at most 4 reviewer processes/subagents in round 1, and exactly 1
  in each later round. If anything would exceed this, stop and report instead.
- Never commit, push, stage, or revert anything unless the user explicitly asks.

## 1. Load configuration

Read `.claude/code-review.local.md` in the project root. Its YAML frontmatter:

| field | default | meaning |
|---|---|---|
| `runner` | `claude` | Command prefix that launches a reviewer process, e.g. `ccsp -g gpt claude`. Special value `in-session` uses subagents instead of external processes. |
| `concurrency` | `0` | Max reviewers running at once. `0` = no limit. |
| `max_rounds` | `3` | Adversarial loop cap. |
| `backlog_dir` | `docs/code-review-backlog` | Where deferred findings are filed. |
| `in_session_model` | `opus` | Model tier for in-session reviewer subagents. |

If the file does not exist, run the setup flow from `commands/setup.md` first (ask the
questions, write the file), then continue.

Command-line flags override config for this run only: `-c=N` overrides `concurrency`,
`--max-rounds=N` overrides `max_rounds` (adversarial only).

## 2. Resolve the review target

The target must be explicit. Parse it from the arguments (a commit sha or range, `staged`,
`working-tree`, file paths, `branch <base>`, or a natural-language description that maps to one
of these).

If no target was given, do NOT pick one silently. Gather candidates cheaply
(`git log --oneline -3`, `git status --short`, `git diff --cached --stat | tail -1`) and use
`AskUserQuestion` to let the user choose: latest commit / working tree / staged / something else.

## 3. Build the review packet

One packet per round, built by you (the main agent) so reviewers never re-explore the repo.

Create `RUN_DIR=.claude/code-review/runs/<yyyymmdd-HHMMSS>/round-<N>/` with subdirs `prompts/`
and `out/`. Write `RUN_DIR/packet.md` containing, in order:

1. **Target**: one paragraph describing the review target and the exact git commands used below.
2. **Changed files**: the `--stat` list.
3. **Diff**: the full unified diff of the target:
   - single commit `X`: `git diff X^..X`
   - commit range `A..B`: `git diff A^..B`
   - staged: `git diff --cached`
   - working tree: `git diff HEAD`, plus the full content of untracked files from
     `git status --porcelain` (cap each untracked file at ~400 lines, note truncation)
   - files: `git diff HEAD -- <paths>` plus full content for untracked ones
   - branch: `git diff <base>...HEAD`
4. **Project conventions**: the root `CLAUDE.md` (if any) and every `CLAUDE.md` in directories
   the diff touches. Include file paths and contents, trimmed to sections that could apply.
5. **Round context** (round 2+ only): see the loop protocol below.

If the diff exceeds ~5000 lines, keep it complete anyway and say so in the Target section —
reviewers must see everything; do not summarize code.

## 4. Prepare angle prompts

Angle templates live in `${CLAUDE_PLUGIN_ROOT}/references/angles/`:

| template | angle | used in |
|---|---|---|
| `correctness.md` | logic errors and bugs in the diff | both modes, round 1 |
| `conventions.md` | project-convention violations | both modes, round 1 |
| `callers.md` | caller/interface impact of the change | both modes, round 1 |
| `design.md` | design and assumption challenges | adversarial only, round 1 |
| `re-review.md` | fix verification + regression scan | rounds 2+ (single reviewer) |

For each template needed this round, produce `RUN_DIR/prompts/<angle>.md` by replacing the
placeholders `{{PACKET_PATH}}` (absolute path to `packet.md`), `{{REPO_ROOT}}` (absolute repo
root), and — for `re-review.md` only — `{{KNOWN_ISSUES}}` (see loop protocol). `sed` with `|`
delimiters works; for `{{KNOWN_ISSUES}}` it is easier to write the prompt file yourself.

## 5. Dispatch reviewers

### External runner (default)

Run the bundled script in the background and poll its output until it finishes:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run-reviewers.sh" \
  --runner "<runner from config>" \
  --concurrency <N> \
  --outdir "RUN_DIR/out" \
  RUN_DIR/prompts/<angle>.md ...
```

Use `run_in_background: true` for this Bash call (reviews can take several minutes), then poll.
The script sets the `CODE_REVIEW_CHILD=1` sentinel, restricts each reviewer to read-only tools,
refuses more than 8 prompts, and writes `out/<angle>.out|.err|.exit` per reviewer. Call it at
most once per round. If any `.exit` is non-zero, read the `.err`, report the failure, and
continue with the reviewers that succeeded — do not relaunch the failed one more than once.

### In-session (`runner: in-session`)

1. Determine the model tier mapping: `printenv | grep -E '^ANTHROPIC_' | sort`. The tier
   aliases opus > sonnet > haiku may be remapped to third-party models via
   `ANTHROPIC_DEFAULT_OPUS_MODEL` etc. Always pass tier aliases (`opus`/`sonnet`/`haiku`) as the
   `model` parameter — the harness resolves them. Use the tier from `in_session_model`.
2. Dispatch one `Agent` call per angle prompt file with `subagent_type: "code-review:reviewer"`,
   `run_in_background: false`, `model: <tier>`, and a prompt of: "Read and execute the
   instructions in <absolute path to the angle prompt file>."
3. Respect `concurrency`: if `N > 0`, launch at most `N` agents per message and wait for each
   batch to finish before the next. If `0`, launch all in one message.
4. Never launch more agents than there are angle prompts this round.

## 6. Verify findings and act

Collect every finding from the reviewer outputs. For each one, verify it yourself against the
actual code (read the file, check the claim). Then classify:

- **Confirmed, in scope** → fix it now with the smallest change that resolves it.
- **Confirmed, but out of scope** (pre-existing, or the fix is large/risky relative to the
  review target) → file it in the backlog: create one file per issue in `backlog_dir` following
  `${CLAUDE_PLUGIN_ROOT}/references/backlog-template.md`. Before creating, glob the backlog dir
  for an existing file about the same issue; update it instead of duplicating.
- **Not confirmed** → record why the finding is wrong (you will report this; do not fix).

Do not soften reviewer findings to avoid work, and do not "fix" things no reviewer flagged.

## 7. Loop protocol (adversarial mode only)

After round N's fixes:

1. Decide whether to continue: continue only if round N produced at least one **confirmed**
   finding of severity **major or critical** that you fixed. Stop when a round yields none, or
   when `max_rounds` is reached.
2. Round N+1 uses exactly one reviewer with the `re-review.md` template on a **new packet**
   whose diff is the cumulative view: the original review target's diff plus all uncommitted
   fix changes (`git diff HEAD` on top of the original target diff; describe both in the Target
   section).
3. `{{KNOWN_ISSUES}}` = one line per already-handled issue, formatted
   `- [fixed|backlogged|rejected] <file>: <one-line summary>`. Include everything from all
   previous rounds. Do not paste backlog file contents — one line each, nothing more.

## 8. Report

End with a single consolidated report:

- Per finding: severity, `file:line`, angle that found it, verdict (**fixed** / **backlogged**
  with file path / **rejected** with one-line reason).
- Adversarial: rounds executed and why the loop stopped.
- Paths: `RUN_DIR` and any backlog files written.
- Remind the user that nothing was committed.
