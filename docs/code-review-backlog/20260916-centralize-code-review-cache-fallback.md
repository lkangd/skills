---
id: centralize-code-review-cache-fallback
status: open
severity: minor
found: 2026-09-16
source: /code-review, round 1
target: staged plugin slash-command interpolation fixes
---

# Centralize the duplicated cache-root fallback

## Problem

`plugins/engineering/code-review/commands/code-review.md:38-43` and `adversarial.md:38-43` now contain the same agent-side fallback:

```bash
bash -c 'r=$(ls -td "$HOME"/.claude/plugins/cache/*/code-review/*/scripts/run-orchestrator.sh 2>/dev/null | head -1); r=${r%/scripts/run-orchestrator.sh}; printf "%s\n" "${r:-UNRESOLVED}"'
```

`plugins/engineering/code-review/references/review-core.md:15-16` already describes the same cache lookup. Cache layout, newest-install selection, suffix stripping, and the `UNRESOLVED` sentinel have to stay synchronized across both entry points plus review-core.

## Why deferred

The duplication is real, but extracting a shared helper is larger than this interpolation bugfix and is constrained by Claude Code: load-time bang-backtick cannot contain `${…}`, and the command cannot Read `review-core.md` until PLUGIN_ROOT is already known. The fallback therefore currently has to live in the command files.

## Suggested fix approach

Keep each command's required `!`printenv CLAUDE_PLUGIN_ROOT`` line. Move the cache-lookup bash into one canonical place (a plugin script found via the same `ls -td` glob, or a short shared command snippet both files include without `${…}`). Preserve: env-first when `scripts/run-orchestrator.sh` exists; else newest cache install; else `UNRESOLVED`. Done when both commands and review-core describe one resolver, not three copies.

## Recommended tools

- Grep: `ls -td "$HOME"/.claude/plugins/cache/*/code-review`
- Compare `commands/code-review.md`, `commands/adversarial.md`, and `references/review-core.md` plugin-root sections
- After any extraction, invoke `/code-review` and `/code-review:adversarial` to confirm load-time `printenv` still works and missing-orchestrator fallback still prints a path or `UNRESOLVED`
