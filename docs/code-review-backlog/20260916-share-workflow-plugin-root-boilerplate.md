---
id: share-workflow-plugin-root-boilerplate
status: open
severity: nit
found: 2026-09-16
source: /code-review, round 1
target: staged plugin slash-command interpolation fixes
---

# Share the repeated workflow plugin-root boilerplate

## Problem

The same `## Plugin root` block was added to three my-workflows commands:

- `plugins/engineering/my-workflows/commands/create-dev-worktree.md:13-17`
- `plugins/engineering/my-workflows/commands/clean-dev-worktree.md:20-24`
- `plugins/engineering/my-workflows/commands/ship-to-test.md:13-17`

Each copies `!`printenv CLAUDE_PLUGIN_ROOT`` plus the empty-value / do-not-use-`${CLAUDE_PLUGIN_ROOT}` guidance. Wording or policy changes must be repeated and can drift. `generate-test-report.md` has a close variant of the same text.

## Why deferred

Real reuse nit, not worth interrupting this bugfix. Each command still needs its own load-time `printenv` line; Claude Code will not execute bang-backtick inside a referenced file. Pulling four lines of prose into a template adds indirection without removing the required per-command interpolation.

## Suggested fix approach

Keep `!`printenv CLAUDE_PLUGIN_ROOT`` in every command. If the surrounding guidance is extracted, put it in `plugins/engineering/my-workflows/references/` and have each command Read it only after PLUGIN_ROOT is printed. Done when the empty-install policy lives in one place and the three (four) commands only differ in what they do with PLUGIN_ROOT.

## Recommended tools

- Grep: `printenv CLAUDE_PLUGIN_ROOT`
- Diff the Plugin root sections of create/clean/ship-to-test/generate-test-report
- After extraction, run each command once to confirm load-time printenv still injects a path
