---
id: run-dir-under-claude-blocks-headless-writes
status: fixed
fixed: 2026-07-18
severity: major
found: 2026-07-18
source: /code-review, round 1 (discovered operating the pipeline, not by a reviewer)
target: commits 2e6f6a4..77d3ec2 of plugins/engineering/code-review
---

# RUN_DIR under `.claude/` — headless orchestrator cannot write its artifacts

## Problem

`references/review-core.md` §3 puts run artifacts at
`RUN_DIR=.claude/code-review/runs/<ts>/round-<N>/`, and `references/orchestrator.md` Steps 1–2
tell the orchestrator to write `RUN_DIR/packet.md` and `RUN_DIR/prompts/<angle>.md` there. But
Claude Code's sensitive-file protection covers the `.claude/` tree: in the headless orchestrator
session every `Write` to that path is auto-denied ("requested permissions to edit … which is a
sensitive file"), and the `mkdir -p …/prompts` Bash call is blocked the same way. Observed in
run `.claude/code-review/runs/20260718-230506/` (orchestrator session transcript
`be52c054-76f3-42ab-8c84-1e97f1043f7c.jsonl`): two failed packet writes, no `prompts/` dir. The
orchestrator improvised — inlined the whole packet into each reviewer dispatch prompt — so the
round completed (exit 0) but off-contract: no on-disk packet/prompts for audit, larger dispatch
prompts, and the fallback depends on model initiative rather than design. The 17:07 run only
worked because that orchestrator happened to build artifacts via allowlisted Bash redirects
instead of `Write`.

## Why deferred

Pre-existing layout decision, not introduced by the reviewed commits; the fix touches
review-core.md, the launcher script, README, and this repo's `.gitignore`, which is out of
scope for the reviewed diff.

## Suggested fix approach

Move run artifacts out of `.claude/`: e.g. `RUN_DIR=.code-review/runs/<ts>/round-<N>/` at the
repo root (gitignored), or the system temp dir. Concretely: update the `RUN_DIR` convention in
`review-core.md` §3, have `scripts/run-orchestrator.sh` pre-create `RUN_DIR/prompts` alongside
`RUN_DIR/out` (script-side mkdir is not subject to session permission checks), update README
paths and the `.gitignore` guidance in `commands/setup.md`. Done = a fresh `/code-review` run
leaves `packet.md` and `prompts/*.md` on disk with zero permission errors in the orchestrator
transcript. Config stays at `.claude/code-review.local.md` (reads are unaffected).

## Recommended tools

`grep -rn "code-review/runs\|\.claude/code-review" plugins/engineering/code-review/` for every
path reference. Reproduce: run `/code-review <any commit>` and grep the orchestrator session
jsonl under `~/.claude/projects/<repo-slug>/` for `is_error.*sensitive`. Verify: after the fix,
`ls RUN_DIR` shows `packet.md`, `prompts/`, `out/`.
