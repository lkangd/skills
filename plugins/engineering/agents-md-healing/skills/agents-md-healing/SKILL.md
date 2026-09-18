---
name: agents-md-healing
description: Use when a repo's AGENTS.md / CLAUDE.md has grown past a screen, mixes commands, gates, architecture and workflow in one file, or the user asks to "slim down", "refactor", "apply progressive disclosure to" the agent instructions file. Also use when two agent-facing docs in the same repo give different answers to the same question.
when_to_use: Trigger on "refactor AGENTS.md", "CLAUDE.md is too long", "progressive disclosure", "把 AGENTS.md 压一压", "精简 CLAUDE.md", "规则拆到单独文件".
allowed-tools: Read Glob Grep Write Edit AskUserQuestion Bash(ls *) Bash(cat *) Bash(readlink *) Bash(wc *) Bash(rg *) Bash(git log *) Bash(git status *)
---

# AGENTS.md healing

Turn one sprawling root instructions file into a legible root plus disclosed files. The root keeps only what fires on every task; everything else moves behind a **context pointer** whose leading words name the branch that should reach it. Background vocabulary (pointer, single source of truth, cache of the environment, no-op) is the `writing-for-agents` skill; read it if it is available.

Contradictions are resolved by the user, before any file is written. Writing first and asking later means rewriting.

## Step 1. Inventory every layer, not just the root

The root file is one layer of a stack. Read all of them before judging any line:

- Root `AGENTS.md` / `CLAUDE.md`. Check `readlink` — one is often a symlink to the other.
- Already-disclosed layers: `.claude/rules/*.md` (note which have `paths:` frontmatter and which are always loaded), `.cursor/rules/`, `docs/agents/`, any doc the root links to.
- **Environment sources of truth the root restates**: `Makefile` / `package.json` scripts, `README.md` command sections, CI config, and — most important — **enforcement hooks** (`.claude/settings.json` → hook scripts). A Stop hook that runs tests encodes a gate in code; the prose must match what the script actually does.
- `.gitignore`, when the root lists which doc directories are untracked.

Completion: a list of every file that carries agent-facing instructions, with a note on when each one loads.

## Step 2. Find contradictions and ask, one question per conflict

Compare across layers. The recurring shapes:

| Shape | Example |
| --- | --- |
| Same rule, different scope | root says "run App tests + related UI suites"; hook script maps App → App tests only |
| Two commands for one action | `osascript quit` in root, `pkill -f` in Makefile |
| Two canonical homes for one artifact | root lists `docs/specs/`; tracker doc says `docs/scratch/<feature>/spec.md` |
| Same rule in two files, different wording | Chinese one-liner in root, English always-loaded rule file with extra nuance |

For each, present the versions labeled by **source file**, and let the user pick. Use a structured multi-choice question (`AskUserQuestion` or equivalent); if the answer implies editing a non-doc file (hook comment, Makefile), offer that in the option label. Vague bounds ("大改时跑全量") are not contradictions: sharpen them yourself to a checkable predicate (e.g. "cross-target or `Package.swift` changed") and say you did.

Completion: every conflict has a user decision recorded before Step 4 starts.

## Step 3. Sort each root line into one of four bins

1. **Root** — passes the test "does every branch of every task need this?": the one-sentence project description; the package manager if not the default; **non-standard** build/test invocations (keep the `--filter Suite/test` form, drop bare `swift build` / `npm test`); the completion gate as a one-liner + link; rules that apply to every response (language, mandatory doc lookup).
2. **Disclosed** — needed by some branches: full gate table, commands and environment, data/log/debug paths, docs workflow, area constraints.
3. **Pointer already exists** — the root restates a doc that already owns the content (module tree vs `ARCHITECTURE.md` Code Map). Replace with a link.
4. **Delete** — see Step 5.

## Step 4. Write the structure

- **Reuse existing homes** before inventing a tree: `docs/agents/` for process docs, `.claude/rules/` for path-triggered area rules, `docs/knowledges/` / `docs/adr/` for long-lived conclusions. Typical new files: `verification.md` (gate), `dev-commands.md` (commands, deps, runtime paths, debug toggles), `docs-workflow.md` (issue/spec/handoff locations, gitignored dirs).
- Root shape: project sentence → "applies to every task" block (≤ 6 bullets) → pointer table with the **trigger words front-loaded** ("hook server / blocking routes / install scripts → …").
- Pointers are relative markdown links. Agents outside Claude Code do not auto-load `.claude/rules`; the root must link them explicitly and say "auto-loaded by `paths:` in Claude Code; other agents read on touch".
- Preserve the symlink: write to the target, then `readlink` to confirm.
- Moving a line means **deleting its other copies** (rule files, README duplicates) unless the user chose to keep both.
- Update stale back-references: docs that said "see AGENTS.md § X", hook-script comments that cite the old file.
- Verify every relative link resolves (`ls` each target) and report line counts before/after.

Completion: root ≤ ~30 lines, all links resolve, symlink intact, no conflicting copy left in another layer.

## Step 5. Flag for deletion, and report both piles

Delete outright:

- Boilerplate ("This file provides guidance to coding agents…").
- No-ops: instructions the agent obeys by default, symlink notes ("only edit this one" — editing either edits the same file), standard commands.
- Caches of the environment: dependency lists already in README, `make help` text.

Keep but flag (the user decides):

- Negative facts the agent cannot cheaply discover ("no CI / no lint command") — usually worth keeping in the disclosed commands file.
- Duplicates the user chose to keep in Step 2.
- Stale references in **source comments** ("see CLAUDE.md § 数据与日志位置") — out of scope for a docs refactor; list them with paths.
- Example trees in other docs that are now out of date (an ADR list stopping at 0003 when 14 exist).

Final report: contradictions and their resolutions, the resulting tree, the deleted list, the flagged list, and any unrelated working-tree state you noticed but did not touch.

## Common failure modes

- **Judging the root in isolation.** The contradictions live between the root and the hook script / Makefile / rule files. Inventory first.
- **Writing before asking.** Every unresolved conflict becomes a rewrite.
- **Flattening path-triggered rules into the root.** They are already disclosed; link them, do not inline them.
- **Dropping the gate entirely because a hook enforces it.** Agents without that hook (Cursor, other CLIs) still need the one-liner + link.
- **Breaking the symlink** by writing through a tool that unlinks. Check `readlink` after writing.
- **Deleting negative facts** as "obvious". Absence is expensive to prove; keep it disclosed.
