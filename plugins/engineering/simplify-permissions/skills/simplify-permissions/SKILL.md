---
name: simplify-permissions
description: This skill should be used to audit, simplify, merge, or apply Claude Code `permissions.allow` rules in settings files. Trigger on permission prompts, allowlist cleanup, fine-grained Bash/MCP/tool rules, permission simplification, or cleanup of `permissions.allow`. Default to dry-run analysis and never write settings until the user confirms the final proposed diff.
argument-hint: "[settings-file] [--apply] [--aggressive]"
---

# Simplify Permissions

Audit Claude Code `permissions.allow` rules and recommend safe simplifications. The goal is to reduce noisy, duplicated approvals without quietly expanding what Claude Code can do. Default to read-only analysis. Do not modify any settings file unless the user explicitly requests applying changes and confirms the final proposed diff.

## Default Target

- If no target is provided, inspect `.claude/settings.local.json` in the current project.
- If the user names a file, use that file.
- If the requested scope is ambiguous, ask whether to use local project, shared project, or user settings.
- Treat `.claude/settings.local.json` as personal or project-local, `.claude/settings.json` as team-shared, and `~/.claude/settings.json` as user-global.

## Required Documentation Check

Before making judgments about rule syntax or matching behavior, consult current Claude Code docs for `permissions` and, when scope matters, `settings`.

Prefer Context7 or the docs skill or helper when available. Apply documented rules, including:

- `Tool` and `Tool(specifier)` matching.
- `Bash(...)` wildcard behavior and word-boundary implications.
- compound Bash commands being split and matched independently.
- MCP allow wildcards using the anchored form `mcp__<server>__*`, while remembering that this still grants every exposed tool on that server.
- `Read`/`Edit`/`Write` path anchors: `//`, `~/`, `/`, and relative paths.
- deny/ask/allow precedence: deny first, then ask, then allow.

## Snapshot Consistency

Treat every recommendation as tied to a specific file snapshot.

- On the first read, record the target file, current `permissions.allow` count, whether `permissions.ask` and `permissions.deny` exist, and any notable high-risk families.
- Before any final apply confirmation, re-read the target file.
- If the `permissions.allow` count changed, or the relevant rule set changed in a way that affects the proposal, stop and tell the user the file drifted.
- When drift is detected, do not silently merge old and new proposals. Ask the user whether to:
  - continue from the current file,
  - continue from the earlier snapshot, or
  - first explain the newly added or changed rules.

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
4. For `Bash(...)`, group by command family: `rg`, absolute-path `rg`, `git`, `eslint`, `yarn`, `npm`, `pnpm`, `rtk`, `python`, `node`, `lsof`, `command -v`, absolute-path read-only commands, and other commands.
5. In the first analysis pass, identify:
   - exact duplicates
   - narrow rules already covered by a broader same-scope rule
   - low-risk read or query groups that can be merged
   - stale or low-value rules that should be deleted instead of generalized
   - malformed or likely invalid rules that should be deleted instead of merged
   - wrapper or read-only candidate merges that reduce prompts but require confirmation
   - high-risk command families that should stay narrow
6. Produce a layered dry-run report with four explicit buckets:
   - low-risk direct suggestions
   - confirmation-only candidates
   - stale or malformed delete candidates
   - intentionally narrow or high-risk rules to keep
7. If the user wants apply mode, re-read the file before showing the final confirmation prompt. If the file drifted, pause and resolve the snapshot choice before presenting a final diff.
8. After writing, validate JSON and run a lightweight second pass that looks only for:
   - exact rules newly covered by the approved broader rules
   - newly exposed stale temp, worktree, or artifact rules
   - obvious same-family residue that the first pass missed
9. Keep the post-write rescan bounded. Do at most two total cleanup rounds unless the user explicitly asks for a deeper audit.

## Output Format

Use a concise table with these columns:

| Classification | Current Rule(s) | Suggested Rule | Action | Reason | Risk | Not Merged Because |
|---|---|---|---|---|---|---|

Classifications:

- `Merge`: safe or low-risk consolidation.
- `Keep Narrow`: keep narrow because broadening changes the safety boundary.
- `Delete`: duplicate, stale, malformed, or low-value rule.
- `Needs Confirmation`: potentially useful but materially broadens capability or wrapper scope.
- `High Risk`: do not broaden; consider ask or deny if relevant.

For `Not Merged Because`, use `-` when a row is already resolved. Otherwise use a short label such as:

- `boundary protection`
- `needs user approval`
- `should delete, not merge`
- `second-pass cleanup after main change`
- `possible missed coverage; rescan recommended`

For large allowlists, group repeated rows by family and include representative examples, but keep the final add and remove lists exact and copyable.

After the table, include:

- target file and snapshot allow count
- whether `ask` and `deny` exist
- estimated allow count after suggested low-risk cleanup
- exact rules recommended to add
- exact rules recommended to remove
- stale or malformed rules recommended to delete first
- wrapper candidates that could reduce future prompts but require confirmation
- unchanged rules that remain intentionally narrow
- rules explicitly not recommended
- second-pass follow-up items, or `none` if the first pass already looks closed

If snapshot drift is detected before apply confirmation, stop and show the drift instead of pretending the add and remove list is still final.

## Simplification Principles

Before any settings modification, show these principles to the user in the response:

1. Prefer deleting duplicates, stale rules, and malformed rules before adding broader permissions.
2. Prefer reducing repeated read or query permissions over broadening execution capability.
3. Merge only when the broader rule preserves the same practical safety boundary.
4. Do not broaden write, network, package installation, deployment, git history mutation, or arbitrary script execution commands.
5. Keep powerful wrappers narrow; do not replace many subcommands with a whole-wrapper allow rule.
6. Preserve `ask` and `deny` rules unless the user explicitly asks to analyze them.
7. For shared project settings, be stricter than local settings because changes affect collaborators.
8. When uncertain, keep the narrower rule and mark it as needing human confirmation.

## Stale or Low-Value Rule Patterns

Treat these as delete-first candidates unless the user gives a current reason to keep them:

- temp-file paths such as `/tmp/...`
- macOS temp paths such as `/var/folders/...`
- Claude worktree temp paths such as `.claude/worktrees/agent-*/...`
- one-off review artifacts such as generated `.html`, `.txt`, `.json`, or staged diff files in temp or worktree locations
- absolute-path rules pointing at obviously ephemeral outputs

When one of these appears:

- prefer `Delete` over generalizing it
- explain that the rule looks tied to a one-off artifact, temp area, or agent worktree
- only discuss a broader replacement if the user explicitly wants fewer prompts for the same command family in future work

## Malformed or Likely Invalid Rules

Always check for rules that look syntactically wrong, semantically meaningless, or inconsistent with the docs, for example:

- `Bash(?Skill)`
- `Bash(Skill)`
- `Skill(code-review:*)`
- `Skill(update-config:*)`
- Bash rules that are obviously just a search term or filename rather than a command prefix

Handle them as follows:

- classify them as `Delete` with reason `Malformed or likely invalid`
- do not try to normalize them into a broader valid rule automatically
- keep valid neighboring rules separate so the user can distinguish bad leftovers from legitimate permissions

## Absolute-Path Read-Only Command Decision Tree

For absolute-path read or query commands such as `/bin/ls`, `/usr/bin/find`, `/usr/bin/grep`, and `/opt/homebrew/bin/rg`, use this order:

1. If the rule is tied to an obviously ephemeral target or one-off artifact, mark it `Delete`.
2. If the rule is already covered by an existing broader same-binary rule, mark it `Delete`.
3. If the command family is read-only or query-only and the user wants fewer repeated prompts, treat the broader same-binary wildcard as either `Merge` or `Needs Confirmation`, depending on how much path or argument coverage expands.
4. If docs or current evidence do not clearly justify the broader match, explain the uncertainty and do not silently skip the rule.

Do not leave these rules unexplained. They should end up as delete, merge, confirm, or keep with a short reason.

## Safe Merge Heuristics

Usually safe to recommend when supported by existing rules:

- Many `Bash(rg ...)` rules -> `Bash(rg *)`.
- Many absolute-path ripgrep rules that already span varied targets and arguments -> `Bash(/opt/homebrew/bin/rg *)` or equivalent exact executable path, but only when the broader same-binary wildcard does not materially widen the practical boundary. Otherwise keep it in `Needs Confirmation`.
- Read-only git queries like `git -C <repo> grep`, `blame`, `ls-tree`, `log`, `diff`, or `status` -> command-specific wildcard such as `Bash(git -C * grep *)`, not `Bash(git *)`.
- Repeated local eslint invocations -> the same eslint entrypoint plus `*`, such as `Bash(./node_modules/.bin/eslint *)`.
- Repeated local port checks -> `Bash(lsof *)` when only process or port inspection is represented.
- Repeated executable-existence checks -> `Bash(command -v *)` only when the existing rules are plainly limited to command lookup.

## Confirmation-Only Merges

Recommend these only as `Needs Confirmation` unless the existing rules and user context prove the broader rule preserves the intended boundary:

- Many `mcp__same-server__tool` rules -> `mcp__same-server__*`. MCP wildcards are anchored, but still allow every current and future tool exposed by that server.
- Many read-only wrapper calls -> a wrapper subcommand wildcard, such as `Bash(rtk rg *)`, `Bash(rtk read *)`, or `Bash(yarn -s yrc eslint *)`, only when the subcommand itself is constrained to read or query behavior.
- Broad validation scripts, such as `Bash(node scripts/check-*.js *)` or `Bash(python scripts/validate_*.py *)`, only when the matched scripts are already present and are not arbitrary task runners.
- Absolute-path read-only command wildcards when they would reduce prompt noise but still broaden path or argument coverage beyond the currently observed rules.

When these appear, surface them in a dedicated wrapper or confirmation-candidate section instead of burying them under `Keep Narrow`.

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
- whole-wrapper allow rules that hide multiple subcommands behind one broad prefix
- broad `Read`, `Edit`, or `Write` rules
- `Skill(*)` or wildcard-style `Skill(...)` patterns that are not documented syntax
- unanchored MCP allow globs such as `mcp__*`

For `rtk`, prefer subcommand-specific rules such as `Bash(rtk rg *)`, `Bash(rtk read *)`, `Bash(rtk tsc *)`, and `Bash(rtk lint *)` rather than `Bash(rtk *)`.

For `rtk git` and `rtk yarn`, prefer narrower forms such as `Bash(rtk git status *)`, `Bash(rtk git log *)`, `Bash(rtk git diff *)`, `Bash(rtk yarn lint *)`, `Bash(rtk yarn test *)`, and `Bash(rtk yarn build *)` unless the user confirms the wider subcommand boundary.

For package managers, prefer explicit scripts such as `Bash(yarn lint *)`, `Bash(yarn test *)`, `Bash(yarn build *)`, and `Bash(yarn check:types)` rather than `Bash(yarn *)`.

For Python and Node, preserve narrow stdin or exact-command rules; do not broaden to all scripts.

For malformed rules, delete or escalate them; do not reinterpret them as valid broad permissions.

## Apply Mode Requirements

Only modify a settings file if all of the following are true:

1. The user explicitly asks to apply, write, or update the simplified permissions.
2. You have read the current target file in this conversation.
3. You have checked current Claude Code docs for permission semantics.
4. You have shown the simplification principles to the user.
5. You have shown the snapshot-based final proposal, including additions, removals, stale or malformed deletes, unchanged high-risk rules, and confirmation-only candidates.
6. You re-read the target file after the first analysis and before the final confirmation prompt.
7. If the file drifted, you paused and resolved which snapshot to use.
8. You show a diff-style summary of the planned settings change.
9. You ask for final confirmation using the available explicit confirmation mechanism, such as `AskUserQuestion` when available.
10. The user confirms that the final proposal is acceptable.

The `--apply` argument means the user wants an apply proposal; it does not bypass the re-read or final confirmation requirement.

If the user has not confirmed the final proposal, stop after presenting the table and ask whether to apply it.

When applying:

- preserve all non-permission settings
- preserve `permissions.ask` and `permissions.deny` unchanged unless explicitly requested
- remove exact duplicates
- delete approved stale or malformed rules
- add approved broader rules
- remove only the narrow rules explicitly covered by the approved broader rules
- keep original ordering as much as practical: existing unrelated rules first, then new consolidated rules in the appropriate group
- validate JSON after writing
- report before and after allow counts
- run a lightweight second pass and report any newly exposed cleanup items

## Confirmation Prompt

Before writing, ask a direct final question such as:

"I will simplify `<target>` `permissions.allow` from X entries to Y entries. I will add A merged rules, remove B covered, duplicate, stale, or malformed rules, and keep high-risk commands narrow. Confirm write now?"

Offer choices:

- `Confirm write`
- `Show suggestions only`
- `Adjust plan`

Do not write unless the user chooses `Confirm write` or gives equivalent explicit confirmation.

## Snapshot Drift Prompt

If the file changed between the first analysis and final confirmation, ask a direct question such as:

"`<target>` changed during analysis: `permissions.allow` went from X entries to Y entries. Which version should I use?"

Offer choices:

- `Use current file`
- `Use earlier snapshot`
- `Explain new rules first`
