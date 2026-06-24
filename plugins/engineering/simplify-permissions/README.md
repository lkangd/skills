# Simplify Permissions Plugin

Audit Claude Code `permissions.allow` rules and recommend safe simplifications for `.claude/settings.local.json`, `.claude/settings.json`, and `~/.claude/settings.json`.

The skill defaults to dry-run analysis. It reports duplicate rules, low-risk read/query consolidations, intentionally narrow high-risk rules, exact add/remove lists, and a diff-style apply proposal. It never writes settings changes until the user has reviewed the simplification principles and explicitly confirmed the final proposal.

## Plugin goals

- Reduce noisy repeated permission prompts without quietly expanding execution capability
- Preserve `permissions.ask` and `permissions.deny` unless the user explicitly asks to analyze them
- Keep high-risk Bash, package-manager, network, deployment, git-write, script-execution, and broad file rules narrow
- Treat shared project settings more conservatively than local settings
- Make apply mode auditable with exact additions, removals, unchanged rules, and final confirmation

## Directory layout

```text
plugins/engineering/simplify-permissions/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── simplify-permissions/
        ├── SKILL.md
        └── evals/
            ├── evals.json
            └── fixtures/
```

A one-round evaluation workspace was generated as a sibling directory:

```text
plugins/engineering/simplify-permissions-workspace/
└── iteration-1/
```

That workspace contains old/new skill comparison outputs, `grading.json` files, `benchmark.json`, and `benchmark.md` from the initial human-review loop.

## Evaluation summary

The eval suite now covers:

- `permission-prompt-dry-run` — dry-run cleanup report for local settings with duplicate and read-query consolidation
- `apply-still-confirms` — `--apply` proposal that must still stop for final human confirmation
- `shared-risk-boundaries` — conservative recommendations for team-shared settings with MCP, `rtk`, Node/Python, package-manager, and Edit risks
- `moving-target-reload` — apply-path drift detection that pauses when the target snapshot changes before final confirmation
- `stale-temp-and-worktree-rules` — delete-first handling for `/tmp`, `/var/folders`, and `.claude/worktrees` artifact rules
- `malformed-rule-detection` — detection of malformed or likely invalid `Bash(...)` and `Skill(...)` entries
- `post-merge-second-pass` — bounded post-write cleanup planning for rules that become redundant after first-pass consolidation

Benchmark summary from `simplify-permissions-workspace/iteration-1/benchmark.md`:

| Configuration | Pass Rate | Time (s) | Tokens |
| --- | ---: | ---: | ---: |
| `with_skill` | 0.93 ± 0.12 | 552.7 ± 108.2 | 81 ± 140 |
| `old_skill` | 0.87 ± 0.23 | 562.2 ± 45.3 | 30 ± 51 |

The eval surfaced one follow-up to watch for in future iterations: dry-run reports should count `permissions.allow` entries accurately and clearly distinguish raw array length from deduplicated count.

## Maintenance

- **Tune behavior**: edit `skills/simplify-permissions/SKILL.md`
- **Update evals**: edit `skills/simplify-permissions/evals/evals.json` and fixtures under `skills/simplify-permissions/evals/fixtures/`
- **Rerun review**: create a new `simplify-permissions-workspace/iteration-N/` and generate the review viewer with `eval-viewer/generate_review.py`
- **Keep safety bias**: prefer narrower rules whenever a merge changes the practical safety boundary

## Author

Curtis Liong (<lkangd@gmail.com>)
