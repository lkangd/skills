---
description: Analyze a specified change scope and write an audience-focused test report
argument-hint: <change scope> [--view=e2e|code-review|both] [--output=<path>]
allowed-tools:
  - Bash(printf:*)
  - Bash(git status:*)
  - Bash(git diff:*)
  - Bash(git show:*)
  - Bash(git log:*)
  - Bash(git rev-parse:*)
  - Bash(git merge-base:*)
  - Bash(git ls-files:*)
  - Bash(git ls-tree:*)
  - Bash(git grep:*)
  - Read
  - Grep
  - Glob
  - Write
  - AskUserQuestion
---

## Plugin root

Resolved plugin root: `!`printf "%s\n" "${CLAUDE_PLUGIN_ROOT:-UNRESOLVED}"``

The absolute path printed above is **PLUGIN_ROOT** for this run. Do not use the literal `${CLAUDE_PLUGIN_ROOT}` in later Read or Bash tool calls. If the value is `UNRESOLVED`, stop and explain that the plugin installation could not be located.

## Request

Raw arguments: `$ARGUMENTS`

Analyze the requested Git change scope and write a test-submission report. The report language is Simplified Chinese by default; honor an explicitly requested language.

### Perspective selection

Select report perspectives from explicit flags or natural-language intent:

- No perspective requested: generate **E2E only**.
- Only E2E requested or `--view=e2e`: generate **E2E only**.
- Only Code Review requested or `--view=code-review`: generate **Code Review only**.
- Both requested or `--view=both`: generate both perspectives.

Never add a Code Review section merely because code was inspected. Never add an E2E section when the user explicitly requested Code Review only.

### Accepted change scopes

The change scope is required. If it is empty or ambiguous, ask the user to clarify and stop rather than choosing a default.

Accepted examples include:

- A single commit SHA or ref, such as `abc123` or `HEAD`.
- A commit range, such as `main..feature`, `HEAD~3..HEAD`, or `abc123^..def456`.
- `staged` for staged changes.
- `uncommitted` for staged, unstaged, and non-ignored untracked changes relative to `HEAD`.
- An unambiguous natural-language scope, such as “the last three commits” or “the current branch compared with main”.

Treat view flags, output options, and language instructions as request controls, not as part of the Git scope.

## Procedure

### 1. Load the presentation guide

Read `PLUGIN_ROOT/references/test-report-template.md` using the resolved absolute plugin path and follow it for perspective-specific content, adaptive sections, tables, and readability rules.

### 2. Resolve the Git scope safely

1. Confirm the current directory belongs to a Git repository and resolve its root with `git rev-parse`.
2. Validate every revision with `git rev-parse --verify`. Never interpolate an unvalidated argument into a shell command.
3. Resolve and record the normalized scope, base revision, target revision or working-tree state, and commit list.
4. For a branch comparison that means “changes introduced by this branch”, compare the merge base with the target branch and state both revisions.
5. For a single commit, compare it with its first parent. If it is a root commit or merge commit, state the comparison rule used.
6. Collect the name/status summary, diff stat, commit list, and full diff. For `uncommitted`, also use `git ls-files --others --exclude-standard` and inspect those files as additions because `git diff HEAD` omits them.

Analyze only changes inside the resolved scope. Unchanged callers, routes, tests, types, configuration, and nearby code may be inspected to establish impact, but must not be described as changed.

### 3. Choose the report destination

If the user explicitly supplies an output file or directory, use it after confirming that it exists or that its parent directory exists. If the final file already exists, inspect it and ask before overwriting it.

If no destination is supplied:

1. Use Glob to discover Markdown files under the Git root.
2. Exclude dependency, generated, cache, build, coverage, VCS, and tool-internal trees such as `node_modules`, `vendor`, `dist`, `build`, `coverage`, `.git`, and plugin/cache directories.
3. Group the remaining Markdown files by their direct parent directory and rank directories by file count. Do not count the repository root as an ancestor of every nested file.
4. Inspect the highest-ranked directory's filenames and representative Markdown content.
5. Consider it suitable only when it is an existing, project-relevant documentation or report location and the changed scope belongs to the same project area. A directory devoted to dependencies, generated output, templates, unrelated packages, tool configuration, or a different product area is unsuitable.
6. If the highest-ranked directory is suitable, place the report there. If it is unsuitable, tied without a clear winner, or no meaningful Markdown directory exists, ask the user to choose an output directory. Do not silently create a new documentation convention.

When only a directory is known, derive a concise filename in the form `test-report-<scope-slug>.md`. Use `uncommitted` for working-tree changes and a short validated ref or range slug for commits. If that filename already exists, ask before overwriting or choosing another name.

The only repository mutation allowed by this command is writing the final report file after the destination has been resolved. Do not edit source files, create directories, switch branches, stage files, create commits, or run tests that may rewrite snapshots or generated output.

### 4. Analyze the change

Use repository evidence rather than commit messages alone:

1. Map changed files to product areas or technical modules. Separate generated files, lockfiles, snapshots, and formatting-only changes.
2. Identify the delivery surfaces actually affected, such as pages, routes, APIs, jobs, CLI commands, data models, configuration, permissions, or integrations.
3. Reconstruct behavior before the change from the base revision and behavior after the change from the target revision or working tree.
4. Trace validation, defaults, loading and error states, permissions, feature flags, contracts, side effects, and removed behavior when relevant.
5. Distinguish confirmed impact from plausible regression risk.
6. For frontend E2E scenarios, provide executable steps with prerequisites, an entry point, exact UI actions, input data or state, and observable expected results.
7. For non-frontend changes, use the matching interaction surface and verification method instead of inventing pages or UI steps.
8. Do not invent routes, URLs, accounts, test data, environment details, commands, or expected responses. Mark missing facts clearly in the report's language.
9. Consolidate repeated file changes into human-readable scenarios while retaining concise file and symbol evidence where useful.

### 5. Compose, save, and report

1. Follow the loaded presentation guide and include only the selected perspectives.
2. Include sections only when they describe a real affected surface. Do not render “not applicable” placeholder sections.
3. Prefer tables for comparisons, impact maps, review maps, and step-to-expectation mappings; use prose where a table would make the explanation harder to follow.
4. Write the completed report to the resolved path with Write.
5. Reply with the saved path, normalized change scope, selected perspective or perspectives, and a concise summary. Do not duplicate the full report in the response unless the user asks for inline output.

## Quality gate

Before writing the report, verify that:

1. Every behavioral claim is supported by the diff or inspected repository context.
2. Before-and-after descriptions explain observable or contract-level behavior rather than repeating filenames or commit messages.
3. Every included section is applicable to this project and this change.
4. Code Review content appears only when selected and names concrete review focus and rationale.
5. E2E scenarios contain actionable operations and observable outcomes appropriate to the affected delivery surface.
6. Unknown information is identified explicitly rather than fabricated.
7. The destination decision follows the explicit path or Markdown-directory discovery rules above.
