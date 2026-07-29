---
name: simplify-permissions
description: This skill should be used to audit, simplify, merge, or apply Claude Code `permissions.allow` rules in settings files. Trigger on permission prompts, allowlist cleanup, fine-grained Bash/MCP/tool rules, permission simplification, or cleanup of `permissions.allow`. Default to dry-run analysis and never write settings until the user confirms the final proposed diff.
argument-hint: "[settings-file] [--apply] [--aggressive]"
disable-model-invocation: true
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

Prefer Context7 or the docs skill or helper when available. Keep the check scoped: read only the sections relevant to the rule families actually present in the target file, and do not re-fetch docs already read earlier in the session. The built-in auto-allow list does not require a docs fetch — use `references/builtin-auto-allow.md`. Apply documented rules, including:

- `Tool` and `Tool(specifier)` matching.
- `Bash(...)` wildcard behavior and word-boundary implications.
- compound Bash commands being split and matched independently.
- MCP allow wildcards using the anchored form `mcp__<server>__*`, while remembering that this still grants every exposed tool on that server.
- `Read`/`Edit`/`Write` path anchors: `//`, `~/`, `/`, and relative paths.
- deny/ask/allow precedence: deny first, then ask, then allow.
- which commands Claude Code auto-allows without prompting. Exact rules fully covered by built-in auto-allow are dead weight: delete them, do not merge them. A reference snapshot of the built-in auto-allow list lives in `references/builtin-auto-allow.md` in this skill directory.

## Snapshot Consistency

Treat every recommendation as tied to a specific file snapshot.

- On the first read, record the target file, current `permissions.allow` count, whether `permissions.ask` and `permissions.deny` exist, and any notable high-risk families.
- Before any final apply confirmation, re-read the target file.
- If the `permissions.allow` count changed, or the relevant rule set changed in a way that affects the proposal, stop and tell the user the file drifted.
- Exception: drift consisting only of self-referential rules — permissions auto-added for this session's own audit or apply commands — is not blocking. Fold those rules into the base delete package, note them in the report, and continue without a new confirmation round.
- When non-self-referential drift is detected, do not silently merge old and new proposals. Ask the user whether to:
  - continue from the current file,
  - continue from the earlier snapshot, or
  - first explain the newly added or changed rules.

## Execution Footprint and Prompt Hygiene

This skill cleans an allowlist; its own execution must not pollute that allowlist or generate avoidable permission prompts.

- For analysis, prefer auto-allowed read-only commands: `jq`, `rg`, `grep`, `sort`, `uniq`, `wc`. Avoid interpreter scripts for anything a `jq` pipeline can do.
- Never write helper scripts to `/tmp` or anywhere outside the project. Every write, edit, and execution of an out-of-project script triggers a fresh permission prompt, and approving one with "don't ask again" injects a new junk rule into the very file being cleaned.
- Apply changes to the settings file with the built-in file-editing tools (Edit/Write) directly on the target file, or with a single deterministic command. Do not build a throwaway classifier script at apply time.
- Expect self-referential rules: any permission rule created during this session by the audit's own commands is automatically part of the base delete package (see Snapshot Consistency).
- Minimize total user interruptions: the target is one confirmation interaction for the whole run (the multi-select apply prompt), plus only genuinely blocking questions.

## Analysis Workflow

1. Read the target settings file before making any recommendation.
2. Parse JSON and extract `permissions.allow`; preserve all unrelated settings.
3. Build a scripted frequency table (for example `jq` plus `sort | uniq -c`) that groups every rule by tool family and, for `Bash(...)`, by leading command plus first subcommand. Do not rely on eyeballing the raw JSON; in large files the biggest families are exactly the ones that get missed.
4. Group allow rules by tool family:
   - `Bash(...)`
   - `mcp__*`
   - `Skill(...)`
   - `Read(...)`, `Edit(...)`, `Write(...)`
   - `WebFetch(...)`
   - other tools
5. For `Bash(...)`, group by command family: `rg`, absolute-path `rg`, `git`, `eslint`, `yarn`, `npm`, `pnpm`, `rtk`, `python`, `node`, `lsof`, `command -v`, absolute-path read-only commands, and other commands. Two extra requirements:
   - Before grouping, normalize superficial variants so they land in the same family: double-quoted vs single-quoted paths to the same executable, `bash <script>` vs direct `<script>` invocation, `/usr/bin/git` vs `git`, and leading environment-variable assignments.
   - For `git`, `gh`, and `docker`, split the family into read-only subcommands (`grep`, `log`, `diff`, `show`, `blame`, `status`, `ls-tree`, `ls-files`, `rev-parse`, `rev-list`, and similar) and mutating subcommands, and classify the two halves independently. Never let a few mutating rules drag an entire family into `High Risk`.
6. In the first analysis pass, identify:
   - exact duplicates, including duplicates that only differ in quoting or wrapper form
   - narrow rules already covered by a broader same-scope rule
   - rules fully covered by Claude Code built-in auto-allow that will never prompt again (see "Rules Covered by Built-In Auto-Allow")
   - dangerous existing broad rules that already grant arbitrary code execution (see "Dangerous Existing Broad Rules")
   - low-risk read or query groups that can be merged
   - stale, one-shot, or low-value rules that should be deleted instead of generalized
   - malformed or likely invalid rules that should be deleted instead of merged
   - wrapper or read-only candidate merges that reduce prompts but require confirmation
   - high-risk command families that should stay narrow
7. Coverage is mandatory: every family with 3 or more rules must appear in the report table with an explicit classification (`Merge`, `Delete`, `Needs Confirmation`, `Keep Narrow`, or `High Risk`). Silently skipping a family — especially a large one — is a failed audit. Cross-check the frequency table from step 3 against the report table before presenting it.
8. Produce a layered dry-run report with four explicit buckets:
   - low-risk direct suggestions
   - confirmation-only candidates
   - stale or malformed delete candidates
   - intentionally narrow or high-risk rules to keep
9. If the user wants apply mode, re-read the file before showing the final confirmation prompt. If the file drifted, pause and resolve the snapshot choice before presenting a final diff.
10. After writing, validate JSON and run a lightweight second pass that looks only for:
    - exact rules newly covered by the approved broader rules
    - newly exposed stale temp, worktree, or artifact rules
    - obvious same-family residue that the first pass missed
11. Keep the post-write rescan bounded. Do at most two total cleanup rounds unless the user explicitly asks for a deeper audit. If the second pass finds residue that falls within a category the user already approved (the same stale, one-shot, auto-allow-covered, malformed, or duplicate buckets as the base package), delete it in the same session without asking again and list it in the final report. Only residue that would require a new broadening decision needs another confirmation.

## Output Format

Use a concise table with these columns:

| Classification | Current Rule(s) | Suggested Rule | Action | Reason | Risk | Not Merged Because |
|---|---|---|---|---|---|---|

Classifications:

- `Merge`: safe or low-risk consolidation.
- `Keep Narrow`: keep narrow because broadening changes the safety boundary.
- `Delete`: duplicate, stale, one-shot, malformed, low-value, or covered by built-in auto-allow.
- `Needs Confirmation`: potentially useful but materially broadens capability or wrapper scope.
- `High Risk`: do not broaden; consider ask or deny if relevant.

For `Not Merged Because`, use `-` when a row is already resolved. Otherwise use a short label such as:

- `boundary protection`
- `needs user approval`
- `should delete, not merge`
- `second-pass cleanup after main change`
- `possible missed coverage; rescan recommended`

For large allowlists, group repeated rows by family and include representative examples. Control output volume — on a 400-rule file, redundant prose costs several minutes of generation time:

- Keep the report table at family level; never enumerate hundreds of rules row by row.
- Write each rule's full text at most once across the whole response. The exact remove list appears once, grouped by family; other sections refer to families and counts.
- For remove lists above ~50 entries, present family names with counts plus a handful of examples in the proposal, as long as the exact computed list is what the apply step executes. The add list is always shown in full because it changes capability.
- The apply-time diff summary repeats counts and the add list, not the full remove list.

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
- confirmation that every family with 3 or more rules appears in the table
- prompt-source substitution advice when repeated read-only interpreter one-liners were found (see "Prompt-Source Substitution Advice")
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
- rules invoking compiled one-off debug binaries or scripts, such as `Bash(./probe)`, `Bash(./repro 8 10)`, or `Bash(/tmp/bench_*)` — the target file usually no longer exists
- rules whose arguments are inherently one-shot and will never match again verbatim: a specific commit hash, a dead PID (`kill 74225`), a session or space UUID, an exact line-number range, or an exact search regex with heavy quoting and escaping
- interpreter one-liners whose inline script text is tied to a single past task (see "Interpreter One-Liner Rules")
- debug `echo` probes such as `Bash(echo "exit: $?")` — `echo` is built-in auto-allowed, and the exact string never recurs

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

## Rules Covered by Built-In Auto-Allow

Claude Code auto-allows a large set of read-only commands without ever prompting: common file and text inspection commands (`cat`, `ls`, `head`, `tail`, `wc`, `echo`, `which`, `tree`, and many more), validated read-only forms of `grep`, `rg`, `sed`, `find`, `jq`, `ps`, and others, all read-only `git` subcommands (`status`, `log`, `diff`, `show`, `blame`, `grep`, `branch`, `ls-files`, `rev-parse`, and similar), read-only `gh` subcommands, and read-only `docker` subcommands (`ps`, `images`, `logs`, `inspect`). Read `references/builtin-auto-allow.md` in this skill directory for the full snapshot before classifying rules in this bucket.

- An exact allow rule whose command is fully covered by built-in auto-allow will never prompt again. Classify it `Delete` with reason `covered by built-in auto-allow`. Deleting is strictly better than merging.
- This is usually the single largest cleanup bucket in old allowlists: entire `git grep`/`git log`/`git blame` families accumulated before auto-allow existed can be removed wholesale.
- Auto-allow validates flags: a command is only covered when its flags are read-only (for example `find` without `-delete`/`-exec`, `sed` with read-only expressions). When unsure whether a specific flag combination is covered, keep the rule and say so instead of guessing.

## Dangerous Existing Broad Rules

Beyond refusing to create broad rules, actively scan the existing allowlist for rules that already grant arbitrary code execution silently. Look for:

- stdin interpreter rules: `Bash(python3 -)`, `Bash(python -)`, bare `Bash(osascript)`, bare `Bash(bash)` or `Bash(sh)`
- prefix-wildcard inline-script rules such as `Bash(python3 -c ' *)` or `Bash(node -e ' *)` — the trailing wildcard makes these equivalent to allowing any code in that interpreter
- shell-execution wildcards such as `Bash(bash -c *)` or `Bash(sh -c *)`
- unquoted broad wrappers that reduce to the same thing, such as `Bash(xargs *)` with command-running usage

Classify these `High Risk`, recommend deleting them or moving them to `permissions.ask`, and surface them at the top of the report before any count-reduction discussion. Finding one of these matters more than any merge.

## Interpreter One-Liner Rules

Rules that embed an inline script get special handling. This covers any interpreter invoked with `-e`, `-c`, `-ne`, `-pe`, `-pi`, or `-i` (`perl`, `ruby`, `node`, `python`, `swift`, `osascript -e`, and similar), plus interpreters that take the script as a bare first argument, such as `awk '{...}'` and `sed` with a mutating expression:

- The script body is arbitrary code. Never merge or broaden these: `Bash(perl -ne *)` is arbitrary code execution no matter how read-only the observed scripts look.
- The inline script text plus target path almost never recurs verbatim, so observed instances are one-shot: classify them `Delete`.
- Treat `-i`/`-pi` variants as write operations on the target files.
- The only valid outcomes for this family are `Delete` and `Keep Narrow`. They must never appear under `Merge` or `Needs Confirmation`.

## Prompt-Source Substitution Advice

When the audit finds 3 or more read-only interpreter one-liners doing work that built-in auto-allowed commands already cover (printing line ranges, numbered file views, simple text extraction), the allowlist cannot fix that prompt noise — only agent behavior can. Add a short advice block at the end of the report suggesting a project memory rule (for example in CLAUDE.md) such as:

> Prefer the Read tool or `sed -n '<start>,<end>p'` over perl/awk/python one-liners when viewing file contents.

Present this as advice only. Do not edit CLAUDE.md from this skill unless the user explicitly asks.

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
- Three or more rules invoking the same fixed script path with varying arguments — plugin or skill helper scripts, docs helpers, project tooling — merge to the exact script path plus a trailing wildcard, such as `Bash(python3 "<path>/record_trace.py" *)`, `Bash(node .claude/skills/<skill>/scripts/<tool> *)`, or `Bash(~/.claude-code-docs/claude-docs-helper.sh *)`, only when the script itself is not an arbitrary task runner. This pattern often compresses 5-15 rules into one.
- Absolute-path read-only command wildcards when they would reduce prompt noise but still broaden path or argument coverage beyond the currently observed rules.

When these appear, surface them in a dedicated wrapper or confirmation-candidate section instead of burying them under `Keep Narrow`. Every confirmation-only candidate must also appear as a selectable option in the apply confirmation prompt; never drop them silently when the user says "apply".

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

This list forbids whole-wrapper rules, not subcommand-level merges. `Bash(git *)` being listed does not forbid merging read-only git queries into `Bash(git -C <repo> grep *)` or `Bash(git log *)` — those remain valid `Merge` candidates under the safe merge heuristics. Do not over-generalize "never broaden git" into "never touch the git family".

For `rtk`, prefer subcommand-specific rules such as `Bash(rtk rg *)`, `Bash(rtk read *)`, `Bash(rtk tsc *)`, and `Bash(rtk lint *)` rather than `Bash(rtk *)`.

For `rtk git` and `rtk yarn`, prefer narrower forms such as `Bash(rtk git status *)`, `Bash(rtk git log *)`, `Bash(rtk git diff *)`, `Bash(rtk yarn lint *)`, `Bash(rtk yarn test *)`, and `Bash(rtk yarn build *)` unless the user confirms the wider subcommand boundary.

For package managers, prefer explicit scripts such as `Bash(yarn lint *)`, `Bash(yarn test *)`, `Bash(yarn build *)`, and `Bash(yarn check:types)` rather than `Bash(yarn *)`.

For Python, Node, Perl, Ruby, and any other interpreter, preserve narrow stdin or exact-command rules; do not broaden to all scripts, and never allowlist an inline-script wildcard (see "Interpreter One-Liner Rules").

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
9. You ask for final confirmation using the available explicit confirmation mechanism, such as `AskUserQuestion` when available, with multi-select enabled so the base delete set and each confirmation-only candidate can be approved or declined individually.
10. The user confirms that the final proposal is acceptable.

The `--apply` argument means the user wants an apply proposal; it does not bypass the re-read or final confirmation requirement.

If the user has not confirmed the final proposal, stop after presenting the table and ask whether to apply it.

When applying:

- apply mechanically: the confirmed proposal already contains exact add and remove lists, so the write step only executes those lists. Do not re-derive classifications with new heuristic code at apply time; if the apply logic disagrees with the proposal, the apply logic is wrong.
- edit the settings file directly with the built-in file-editing tools or one deterministic command; create a backup copy of the settings file next to it before the first write
- preserve all non-permission settings
- preserve `permissions.ask` and `permissions.deny` unchanged unless explicitly requested
- remove exact duplicates
- delete approved stale or malformed rules
- add approved broader rules, including any confirmation-only candidates the user selected
- remove only the narrow rules explicitly covered by the approved broader rules
- list any declined confirmation-only candidates as untouched, so the user sees they were considered and skipped by choice
- keep original ordering as much as practical: existing unrelated rules first, then new consolidated rules in the appropriate group
- validate JSON after writing
- report before and after allow counts
- run a lightweight second pass; delete residue in already-approved categories directly and report it, and only ask again for residue that needs a new broadening decision

## Confirmation Prompt

Before writing, ask a direct final question such as:

"I will simplify `<target>` `permissions.allow` from X entries to Y entries. Select which changes to apply."

Use a multi-select confirmation (`AskUserQuestion` with multi-select when available) whose options are:

- the base package: exact duplicates, stale or one-shot rules, malformed rules, and rules covered by built-in auto-allow
- the dangerous-rule removals, as their own option so declining them is a visible decision
- each confirmation-only merge candidate (or small groups of closely related ones), one option per candidate family
- `Show suggestions only` / adjust

Do not collapse confirmation-only candidates into a single yes/no write question: a user saying "apply" to the base package must still get to decide each broadening candidate. Do not write unless the user selects at least one concrete option or gives equivalent explicit confirmation.

## Snapshot Drift Prompt

If the file changed between the first analysis and final confirmation, ask a direct question such as:

"`<target>` changed during analysis: `permissions.allow` went from X entries to Y entries. Which version should I use?"

Offer choices:

- `Use current file`
- `Use earlier snapshot`
- `Explain new rules first`
