---
id: single-round-exhausts-5h-quota
status: fixed
fixed: 2026-07-20
severity: major
found: 2026-07-20
source: operating the pipeline in vibessage (not found by a reviewer)
target: /code-review run 20260720-154939 in /Users/liangkangda/Fe-project/code/vibessage
---

# One review round burns a whole 5-hour GLM quota window (~18M input tokens)

## Problem

Run 20260720-154939 (glm-mix runner) started at 15:49 and hit the backend's 5-hour usage cap
at 17:05 — mid-verify, before any verdicts. Transcript accounting
(`~/.claude/projects/-Users-liangkangda-Fe-project-code-vibessage/a92efd00-*.jsonl` + its
`subagents/` dir):

- Orchestrator (glm-5.2): **6.2M input** (1.03M raw + 5.18M cache-read), 233K output, over
  **104 assistant turns** averaging ~60K resident context each.
- 8 angle reviewers (glm-4.6 ×6, glm-5.2 ×2): **~12.1M input combined**, 24–71 turns each
  (worst: 2.9M input / 71 turns for a single angle).
- Total ≈ 18.3M input for one incomplete round on a 2,400-line diff.

Root cause is multiplicative, not any single payload: cost = turns × resident context. The
92KB packet (~30K tokens) is re-billed on every turn of every session that holds it, so a
reviewer making 50 fragmented Read/Grep calls pays the packet ~50×. Contributing orchestrator
waste: 16 turns reading the 8 angle templates and Write-ing concretized copies (each such
turn re-sent the full ~60K context — ~1M tokens for work that needs zero model involvement),
plus narration-only turns (tier announcements, split plans) and unbatched checkpoint writes.

## Fix (implemented 2026-07-20)

- `run-orchestrator.sh` pre-concretizes every `prompts/<angle>.md` with bash string
  substitution (`{{PACKET_PATH}}`, `{{REPO_ROOT}}`, `{{KNOWN_ISSUES}}`) at zero model cost;
  `shopt -u patsub_replacement` keeps bash 5.2 from mangling `&` in replacements. Only the
  sweep prompt ({{VERIFIED_FINDINGS}} is runtime data) remains orchestrator-built.
  orchestrator.md Step 2 now forbids touching the templates; the bootstrap prompt says so too.
- orchestrator.md hard rule "Token discipline": batch ALL independent tool calls per message,
  fold tier/split announcements into the dispatch message, no narration-only turns, target
  15–25 own turns.
- Reviewer prompts (script `AGENTS_JSON` + `agents/reviewer.md` for in-session): read the
  packet with the fewest Read calls, batch independent calls, ~15 tool calls total, repo
  files only for specific suspicions — uncertain candidates still get reported (the verify
  pass filters), so the budget cuts turns, not recall.
- Verifier stage: batch location groups into 2–4 verifier dispatches (~6 groups each) instead
  of one-per-location; verifier prompt gets a ~10-call budget.

Expected: orchestrator ~6.2M → well under 2M; reviewers roughly 3–4× cheaper; round total
~18M → ~5M. Budgets are instruction-level (the harness cannot hard-cap subagent turns), so
compliance by GLM models must be confirmed on the next live round.

## Verification notes

Not yet live-validated (quota resets 20:49). On the next round, rerun the transcript token
aggregation and check: orchestrator ≤ ~30 turns with no template reads; per-reviewer ≤ ~20
messages; 2–4 verifier subagents; total input a few M, and finding quality comparable to run
20260719-183317 (12 reported findings baseline).

## Addendum 2026-07-21 — corrected baseline and second optimization pass

Run 20260720-230735 (23:07–23:53, exit 0, 67% of a 5h quota window) ran WITHOUT the fixes
above — they were uncommitted, so the marketplace cache served the crash-resilience version.
It is therefore the accurate pre-fix baseline. Measurement correction: jsonl rows duplicate
`message.usage` across streamed content blocks; summing rows (the 18.3M figure above)
overcounts. Deduped (max usage per message id): **10.6M all-in** (raw 0.96M, cache_read
9.36M, output 0.28M) — reviewers 71%, orchestrator 20% (2.17M, 57 API calls), verifiers 8%.

New waste found in that round's timeline, fixed in the second pass:

- **Report generated twice**: after writing findings.json (14.8KB) the orchestrator re-emitted
  the same array as a 15KB fenced block in its final message — glm-5.2 generation made the
  23:48→23:53 tail ~5 min. Contract changed: `RUN_DIR/out/findings.json` is now the
  authoritative payload (review-core §3.4 parses the file; stdout json block demoted to
  fallback; `has_result()` accepts either); the final message is a two-line receipt.
- **Straggler wall-time**: correctness-B ran 28.8 min with 85K output tokens (glm-5.2
  reasoning); all other reviewers finished by 23:22 — ~20 of 46 minutes spent waiting on one
  subagent. Partially mitigated by the turn budget; inherent to glm-5.2 generation speed.
- **Mis-tiering**: altitude (a cleanup angle) ran on the deep tier and burned 1.15M all-in.
  orchestrator.md now hard-forbids `reviewer-deep` for cleanup/conventions angles.
- **Single-candidate verifiers**: 3 of 8 verifier dispatches carried one candidate each
  (2–4-batch instruction was in the uncommitted pass).
- README documents appending `--model sonnet` to the runner string to move the orchestrator
  session itself off the flagship (~15%/round further).

## Recommended tools

Token audit one-liner: python over the session jsonl + `subagents/*.jsonl`, summing
`message.usage` (input, cache_creation, cache_read, output) per file — see this entry's
Problem section numbers for the baseline shape.
