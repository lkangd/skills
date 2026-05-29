---
name: architecture-doc-builder
description: Author or rewrite the project's `ARCHITECTURE.md` in the rust-analyzer style — Bird's Eye View, Code Map with per-module Architecture Invariant call-outs, and Cross-Cutting Concerns. Use when the user asks to write, generate, refresh, or review architecture documentation, an "engineering overview", a "tech doc for new contributors", or when the codebase structure has changed enough that an existing ARCHITECTURE.md is stale.
when_to_use: Trigger on phrases like "write ARCHITECTURE.md", "engineering overview", "architecture doc", "新人上手文档", "技术架构文档", "整理一下代码结构说明".
allowed-tools: Read Glob Grep Bash(bash *) Bash(cat *) Bash(ls *) Bash(jq *) Bash(find *) Bash(wc *) Bash(git log *) Bash(git rev-parse *) Bash(git ls-files *)
---

# Architecture Doc Builder

Write or refresh `ARCHITECTURE.md` at the repo root, modeled on the
rust-analyzer convention: a Bird's Eye View, a top-down Code Map with
explicit **Architecture Invariant** call-outs, and a Cross-Cutting
Concerns section. The output is for an engineer about to read the
codebase for the first time, not for end users and not for ops.

## Repo snapshot (auto-injected)

The following snapshot is captured _before_ this skill is shown to
the model. Use it as ground truth for the module list, the dependency
graph, the LOC distribution, and the existence of CI / docs.

```!
bash "${CLAUDE_SKILL_DIR}/scripts/scan-repo.sh" .
```

If the snapshot above is empty or shows `Type: unknown`, fall back to
running `git ls-files | head -200` and a manual `Glob` pass to
discover modules before continuing.

## Workflow (eight steps)

Execute the steps in order. Do **not** skip ahead to drafting until
steps 1-5 are done.

### 1. Verify the snapshot

Read the snapshot above. Confirm:

- The **Type** matches your expectation (monorepo vs. single, language).
- The **Modules** section enumerates every package you would want a
  reader to know about. If something obvious is missing (e.g. a
  Python sub-tool inside a JS monorepo), run additional `Glob` /
  `Bash(find ...)` calls to fill in the gap.
- The **Existing docs** section tells you whether you are *creating*
  `ARCHITECTURE.md` or *rewriting* it. If it exists, `Read` it first;
  preserve any sections that are still accurate and only rewrite
  what is stale.

### 2. Read the highest-signal source files

The snapshot lists each module's largest source files (`• path (LOC)`).
For each module, **read the top 1-3 files** plus its `package.json`
/ `Cargo.toml` / equivalent. That is enough to write the module's
section without skimming the full codebase.

For monorepos, also read:

- The root `package.json` / `Cargo.toml` / `pyproject.toml` (declares
  the dependency graph topology).
- The CI workflow files listed under "Build & CI".
- One representative example app, if examples exist (they reveal the
  intended consumer ergonomics).

### 3. Sketch the Bird's Eye View

Before writing, sketch the dataflow on paper or in a scratch buffer:

- What is the **input** to the system? (source code, an HTTP request,
  a CLI invocation, a user gesture, …)
- What is the **output**? (an artifact, a side effect, a response,
  a UI event, …)
- What are the major **layers** between input and output?
- Is there a **build-time / runtime** split? A **client / server**
  split? A **producer / consumer** split? Most systems have one
  axis of separation that dominates the diagram. Find it.

The diagram is ASCII only. No mermaid, no images. Two stacked boxes
work well for systems with a build/runtime or client/server split.

### 4. Order the Code Map

Order modules **leaves-first**: packages with no intra-workspace deps
go first, then their consumers, then top-level entry points. The
snapshot's `- deps:` lines on each module make this trivial to derive.

For each module, plan to write:

- A one-paragraph role statement.
- A bulleted file walkthrough (one bullet per non-trivial file, each
  with a markdown link to the file).
- One or more **Architecture Invariant** call-outs.
- Optionally one **API Boundary** call-out, only if external
  consumers depend on a stable contract.

### 5. Mine for Architecture Invariants

This is where the document earns its keep. For every module, walk
through the checklist in [`references/invariant-patterns.md`](references/invariant-patterns.md)
and write down each invariant you can defend. The most valuable
invariants describe what the code **deliberately does not do** and
**why**. Two or three solid invariants on the architecturally critical
modules is the right density.

If you cannot find any invariant for a module, either the module is
mechanical glue (fine, just say so) or you have not read enough of it
yet. Go back to step 2.

### 6. Identify Cross-Cutting Concerns

These are properties policed across the whole codebase, owned by no
single module. Common categories:

- build-time vs. runtime separation
- error handling / graceful degradation
- production safety (dev-only by design, no-op in prod)
- testing strategy (unit / integration / e2e split)
- module resolution under strict package managers (pnpm, deno, etc.)
- security / sandboxing
- data contracts shared between layers
- performance / size budgets
- observability and logging conventions

Aim for 4-8 short subsections, each with at most one **Architecture
Invariant** call-out.

### 7. Draft the document

Use [`assets/template.md`](assets/template.md) as the skeleton. Fill it in
section-by-section. Apply the rules in [`references/voice.md`](references/voice.md):

- plain English, active voice, present tense
- no marketing language
- every non-trivial assertion links to a file
- Architecture Invariant call-outs follow the bold-label pattern

Length target: **300-600 lines** total for a 5-15 module monorepo.
If you are heading past 800 lines, you are restating code rather than
describing design — cut.

### 8. Write the file and self-review

Write the file to `ARCHITECTURE.md` at the repo root. Then read it
back and verify against this checklist:

- [ ] Bird's Eye View has exactly one ASCII diagram and an elevator
      pitch as its first paragraph.
- [ ] Every module from the snapshot's "Modules" section has a
      heading in the Code Map (or is explicitly justified as out of
      scope).
- [ ] Each module section opens with a one-sentence role statement.
- [ ] At least 70% of file references in the Code Map are clickable
      markdown links to real paths.
- [ ] Every Architecture Invariant call-out includes the **reason**
      the invariant is held, not just the invariant itself.
- [ ] No marketing words (search for: blazing, seamless,
      industry-leading, elegant, beautiful, robust, powerful).
- [ ] No future-tense aspirations. Strike "will", "should",
      "planned to" except inside out-of-scope notes.
- [ ] No tutorial-style "how to use" prose — that belongs in the
      README.

If any item fails, edit the file and re-check.

## Supporting files

- [`assets/template.md`](assets/template.md) — the section-by-section
  skeleton to fill in. Drop the `<!-- author guidance -->` comments
  before writing the final file.
- [`references/voice.md`](references/voice.md) — voice and style
  rules with good/bad examples. Consult before drafting prose.
- [`references/invariant-patterns.md`](references/invariant-patterns.md)
  — ten categories of Architecture Invariant with phrasing examples.
  Consult during step 5.
- [`scripts/scan-repo.sh`](scripts/scan-repo.sh) — the snapshot
  generator. Auto-runs at the top of this skill. Re-run manually with
  a sub-path argument (e.g. `bash scripts/scan-repo.sh packages/foo`)
  to drill into a single area.

## Common failure modes

- **Skipping the snapshot.** The snapshot tells you which modules
  exist and which files are largest. Without it you will miss
  packages or cover the wrong files. Do not draft from memory.
- **Listing API surface instead of architecture.** "Module X exports
  function Y which takes args A and B" is JSDoc, not architecture.
  Replace with "Module X is responsible for Z; it depends on W
  because …".
- **Generic invariants.** "Code should be testable" is not an
  architecture invariant. "The transformer is a pure function of
  (source text, file path) so build caches are safe to share" is.
- **Restating the README.** If the user already has a thorough README
  describing what the product does, do not repeat it. Cross-link and
  jump straight to _how it is built_.
- **Walls of unstructured prose.** Use the bold-label call-outs
  (`**Architecture Invariant:**`, `**API Boundary**`) liberally —
  they are the document's most-skimmed surface.
