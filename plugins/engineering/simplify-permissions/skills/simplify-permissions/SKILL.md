---
name: simplify-permissions
description: This skill should be used to audit, simplify, merge, or apply Claude Code `permissions.allow` rules in settings files. Trigger on permission prompts, allowlist cleanup, fine-grained Bash/MCP/tool rules, `精简权限`, or `整理 permissions.allow`. Default to dry-run analysis and never write settings until the user confirms the final proposed diff.
argument-hint: "[settings-file] [--apply] [--aggressive]"
---

# Simplify Permissions

Audit Claude Code `permissions.allow` rules and recommend safe simplifications. The goal is to reduce noisy, duplicated approvals without quietly expanding what Claude Code can do. Default to read-only analysis. Do not modify any settings file unless the user explicitly requests applying changes and confirms the final diff after seeing the simplification principles.

## Default Target

- If no target is provided, inspect `.claude/settings.local.json` in the current project.
- If the user names a file, use that file.
- If the requested scope is ambiguous, ask whether to use local project, shared project, or user settings.
- Treat `.claude/settings.local.json` as personal/project-local, `.claude/settings.json` as team-shared, and `~/.claude/settings.json` as user-global.

## Required Documentation Check

Before making judgments about rule syntax or matching behavior, consult current Claude Code docs for `permissions` and, when scope matters, `settings`.

Prefer Context7 or the docs skill/helper when available. Apply documented rules, including:

- `Tool` and `Tool(specifier)` matching.
- `Bash(...)` wildcard behavior and word-boundary implications.
- compound Bash commands being split and matched independently.
- MCP allow wildcards using the anchored form `mcp__<server>__*`, while remembering that this still grants every exposed tool on that server.
- `Read`/`Edit` path anchors: `//`, `~/`, `/`, and relative paths.
- deny/ask/allow precedence: deny first, then ask, then allow.

## Analysis Workflow

1. Read the target settings file before making any recommendation.
2. Parse JSON and extract `permissions.allow`; preserve all unrelated settings.
3. Group allow rules by tool family:
   - `Bash(...)`
   - `mcp__*`
   - `Skill(...)`
   - `Read(...)`, `Edit(...)`, `Write(...)`
   - `WebFetch(...)`
   - other tools
4. For `Bash(...)`, group by command family: `rg`, `git`, `eslint`, `yarn`, `npm`, `pnpm`, `rtk`, `python`, `node`, `lsof`, and other commands.
5. Identify:
   - exact duplicates
   - narrow rules already covered by a broader same-scope rule
   - low-risk read/query groups that can be merged
   - validation/test groups that can be merged without allowing arbitrary scripts
   - high-risk command families that should stay narrow
   - stale or low-value rules that can be deleted instead of generalized
6. Produce a table and exact add/remove lists. Do not write changes during analysis.

## Output Format

Use a concise table with these columns:

| Classification | Current Rule(s) | Suggested Rule | Action | Reason | Risk |
|---|---|---|---|---|---|

Classifications:

- `可合并`: safe or low-risk consolidation.
- `建议保留`: keep narrow because broadening changes the safety boundary.
- `可删除`: duplicate, stale, or low-value rule.
- `需确认`: potentially useful but materially broadens capability.
- `高风险`: do not broaden; consider ask/deny if relevant.

For large allowlists, group repeated rows by family and include representative examples, but keep the final add/remove lists exact and copyable.

After the table, include:

- current allow count
- estimated allow count after suggested low-risk cleanup
- exact rules recommended to add
- exact rules recommended to remove
- unchanged rules that remain intentionally narrow
- rules explicitly not recommended

## Simplification Principles

Before any settings modification, show these principles to the user in the response:

1. Prefer reducing repeated read/query permissions over broadening execution capability.
2. Merge only when the broader rule preserves the same practical safety boundary.
3. Do not broaden write, network, package installation, deployment, git history, or arbitrary script execution commands.
4. Keep powerful wrappers narrow; do not replace many subcommands with a whole-wrapper allow rule.
5. Preserve `ask` and `deny` rules unless the user explicitly asks to analyze them.
6. For shared project settings, be stricter than local settings because changes affect collaborators.
7. When uncertain, keep the narrower rule and mark it as needing human confirmation.

## Safe Merge Heuristics

Usually safe to recommend when supported by existing rules:

- Many `Bash(rg ...)` rules -> `Bash(rg *)`.
- Many absolute-path ripgrep rules -> `Bash(/opt/homebrew/bin/rg *)` or equivalent exact executable path.
- Read-only git queries like `git -C <repo> grep`, `blame`, `ls-tree`, `log`, `diff`, or `status` -> command-specific wildcard such as `Bash(git -C * grep *)`, not `Bash(git *)`.
- Repeated local eslint invocations -> the same eslint entrypoint plus `*`, such as `Bash(./node_modules/.bin/eslint *)`.
- Repeated local port checks -> `Bash(lsof *)` when only process/port inspection is represented.

## Confirmation-Only Merges

Recommend these only as `需确认` unless the existing rules and user context prove the broader rule preserves the intended boundary:

- Many `mcp__same-server__tool` rules -> `mcp__same-server__*`. MCP wildcards are anchored, but still allow every current and future tool exposed by that server.
- Many read-only wrapper calls -> a wrapper subcommand wildcard, such as `Bash(rtk rg *)` or `Bash(rtk read *)`, only when the subcommand itself is constrained to read/query behavior.
- Broad validation scripts, such as `Bash(node scripts/check-*.js *)` or `Bash(python scripts/validate_*.py *)`, only when the matched scripts are already present and are not arbitrary task runners.

## Do Not Auto-Broaden

Do not recommend these as low-risk automatic merges:

- `Bash(*)`
- `Bash(rtk *)`
- `Bash(git *)`
- `Bash(yarn *)`
- `Bash(npm *)`
- `Bash(pnpm *)`
- `Bash(node *)`
- `Bash(python *)`
- `Bash(curl *)`
- `Bash(wget *)`
- `Bash(docker *)`
- `Bash(kubectl *)`
- `Bash(aws *)`
- broad `Read`, `Edit`, or `Write` rules
- unanchored MCP allow globs such as `mcp__*`

For `rtk`, prefer subcommand-specific rules such as `Bash(rtk rg *)`, `Bash(rtk read *)`, `Bash(rtk tsc *)`, and `Bash(rtk lint *)` rather than `Bash(rtk *)`.

For `rtk git` and `rtk yarn`, prefer narrower forms such as `Bash(rtk git status *)`, `Bash(rtk git log *)`, `Bash(rtk git diff *)`, `Bash(rtk yarn lint *)`, `Bash(rtk yarn test *)`, and `Bash(rtk yarn build *)` unless the user confirms the wider subcommand boundary.

For package managers, prefer explicit scripts such as `Bash(yarn lint *)`, `Bash(yarn test *)`, `Bash(yarn build *)`, and `Bash(yarn check:types)` rather than `Bash(yarn *)`.

For Python and Node, preserve narrow stdin or exact-command rules; do not broaden to all scripts.

## Apply Mode Requirements

Only modify a settings file if all of the following are true:

1. The user explicitly asks to apply/write/update the simplified permissions.
2. You have read the current target file in this conversation.
3. You have shown the simplification principles to the user.
4. You have shown the final proposed changes, including additions, removals, and unchanged high-risk rules.
5. You show a diff-style summary of the planned settings change.
6. You ask for final confirmation using the available explicit confirmation mechanism, such as `AskUserQuestion` when available.
7. The user confirms that the final proposal is acceptable.

The `--apply` argument means the user wants an apply proposal; it does not bypass the final confirmation requirement.

If the user has not confirmed the final proposal, stop after presenting the table and ask whether to apply it.

When applying:

- Preserve all non-permission settings.
- Preserve `permissions.ask` and `permissions.deny` unchanged unless explicitly requested.
- Remove exact duplicates.
- Add approved broader rules.
- Remove only the narrow rules explicitly covered by the approved broader rules.
- Keep original ordering as much as practical: existing unrelated rules first, then new consolidated rules in the appropriate group.
- Validate JSON after writing.
- Report before/after allow counts.

## Confirmation Prompt

Before writing, ask a direct final question such as:

"我将按上面的原则把 `<target>` 的 `permissions.allow` 从 X 条精简到 Y 条；会新增 A 条合并规则、删除 B 条被覆盖/重复规则，并保留高风险命令不扩大。确认现在写入吗？"

Offer choices:

- `确认写入`
- `只看建议，不写入`
- `调整方案`

Do not write unless the user chooses `确认写入` or gives equivalent explicit confirmation.
