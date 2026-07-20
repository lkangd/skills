---
id: orchestrator-crash-discards-round-progress
status: fixed
fixed: 2026-07-20
severity: critical
found: 2026-07-20
source: operating the pipeline in vibessage (not found by a reviewer)
target: two /code-review runs of 2026-07-20 in /Users/liangkangda/Fe-project/code/vibessage
---

# Orchestrator session death discards the whole round — no checkpoints, no resume path

## Problem

All pipeline state (reviewer candidate arrays, verifier verdicts, the consolidated findings)
lived only in the headless orchestrator session's context. The only on-disk artifacts were
the launcher-built `packet.md` and `prompts/*.md`. When the session died before printing the
final report, ~95%-complete rounds were lost entirely, and there was no way to continue —
`review-core.md` §3 step 4 only allowed a from-scratch relaunch.

Observed in `/Users/liangkangda/Fe-project/code/vibessage/.code-review/runs/`:

- `20260720-013437/round-1-retry`: died at the very end on `429 已达到 5 小时的使用上限`
  (exit 1) — quota consumed by the round itself, nothing recoverable.
- `20260720-133110/round-1`: died after 46 min on `API Error: 400 请求格式非法` from the
  gateway (exit 1).
- `20260720-141836/round-1`: killed with SIGTERM (exit 143), `orchestrator.exit` never
  written.
- (`20260720-011637/round-1`: older-script failure mode — backgrounded reviewers killed at
  the 600s ceiling — already fixed by `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` + synchronous
  dispatch instructions.)

## Fix (implemented 2026-07-20)

Three layers:

1. **Checkpoints** (`references/orchestrator.md`): a hard rule plus per-step instructions to
   write every subagent result to `RUN_DIR/out/` the moment it arrives —
   `candidates-<angle>[-<slice>].json` per reviewer (`[]` counts; file presence = angle
   done), `verdicts-<n>.json` per verifier batch, `findings.json` before printing the final
   report. A "Resuming" section defines how a resumed orchestrator trusts them.
2. **Session pinning + auto-resume** (`scripts/run-orchestrator.sh`): every launch uses a
   generated `--session-id` saved to `RUN_DIR/session-id`; if the attempt ends with no
   parseable result (exit ≠ 0 or no ```json fence in `orchestrator.out`), the script
   auto-resumes that session once via `claude -p --resume <sid>`. Attempt outputs rotate to
   `orchestrator.{out,err,exit}.<n>`; the unsuffixed triple is always the latest attempt.
3. **Explicit resume** (`--resume --runner … --run-dir …`; surfaced as
   `/code-review resume [<run-dir>]`): tries the original session first, then falls back to
   a fresh salvage session whose prompt is the original bootstrap plus a RESUME NOTE that
   points at the checkpoints — this covers transcripts that reproduce the fatal error (the
   400 case) and post-quota-reset resumption from a new user session.
   `review-core.md` §3 step 4 now says resume, never relaunch from scratch.

## Verification notes

`bash -n` passes. Not yet exercised end-to-end against a real interrupted run — the next
failed round in any consumer repo is the real test: check that `out/candidates-*.json`
appear during the run, and that `--resume` on a killed round finishes without re-dispatching
completed angles.

## Recommended tools

Reproduce a crash cheaply: start a round, `kill -TERM` the runner mid-Step-2, then run the
script with `--resume` and diff the reviewer dispatch count in the resumed transcript
(`~/.claude/projects/<repo-slug>/<session-id>.jsonl`) against the checkpoint files.
