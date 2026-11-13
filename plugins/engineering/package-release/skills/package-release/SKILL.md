---
name: package-release
description: Prepare a package release from conventional commits, including a version bump, changelog, release commit, and local tag. Use when the user explicitly invokes package-release to release a package.
disable-model-invocation: true
---

# Package Release Skill

Automates the release workflow: analyze commits → bump version → changelog → commit → tag.

Uses [cz-conventional-changelog](https://github.com/commitizen/cz-conventional-changelog) conventions. Two scripts handle all deterministic work:

## Execution context

Requires Git and Python 3; the bundled scripts use only the Python standard library.

Resolve `SKILL_DIR` to the absolute directory containing this loaded `SKILL.md`.
Use the scripts under that directory, including when the skill is installed in a
plugin cache. Do not search a host-specific cache or rely on plugin environment variables.

Run commands with the target project's Git root as the working directory; keep that
directory separate from `SKILL_DIR`. For a monorepo, clarify the package and release
scope before running these repository-wide helpers. Inspect `git status` and preserve
unrelated staged and unstaged changes.

In the examples below, replace `SKILL_DIR` with the resolved absolute path. Do not
change into the skill's directory to run its scripts.

## Workflow

### Step 1: Get project info

```bash
# Detects current version from project files/tags, reports tag naming pattern
python3 "SKILL_DIR/scripts/release_info.py"
```

Returns `version`, `source`, `all_sources` (every file containing a version), and `tag_prefix` (defaults to `"v"` when no version tags exist; `"v"` if tags look like `v1.0.0`, `""` for bare `1.0.0`, etc.). If `version` is null, ask the user.

### Step 2: Analyze commits

```bash
# Parses conventional commits, determines bump, generates changelog
python3 "SKILL_DIR/scripts/analyze_commits.py" <current-version> [since-ref]
```

`since-ref` is optional — auto-detected from latest version tag, falling back to the last `chore(release):` commit. Returns `bump_type` (major/minor/patch or null), `new_version`, `since_ref` (the ref actually used), and `changelog` (ready-to-insert markdown). If `bump_type` is null, no conventional commits were found — ask the user to classify the release.

### Step 3: Confirm with user

Show the analysis from Step 2: current → new version, bump type, changelog preview,
files to update, release commit, and tag name. Use the host's available user-input
mechanism or a normal conversation question. Let the user accept, adjust bump level,
or cancel. Wait for confirmation of this concrete proposal before changing files,
creating the release commit, or tagging. If the bump changes, update the proposed
version and changelog heading consistently.

### Step 4: Apply changes

1. **CHANGELOG.md** — **insert a new version section** using the `changelog` field from Step 2. Never edit or overwrite existing version entries. If the file exists, insert the new section right after the `# Changelog` heading, pushing older entries down. If not, create with that heading.
2. **Version files** — update version in every file listed in `all_sources` from Step 1.
3. **Commit** — review and stage only the approved release changes, then commit as `chore(release): <version>`. Keep unrelated staged changes out of the release commit without discarding them. Do not push.
4. **Tag** — after the release commit succeeds, create a tag as `<tag_prefix><version>` using `tag_prefix` from Step 1 (defaults to `v`). Do not overwrite an existing tag or push.

Report the version, changed files, release commit, tag, and final worktree status.
If a step fails, report what completed and what remains; do not claim the release
finished or retry by bypassing Git hooks.

## Edge cases

- **Uncommitted changes**: warn before proceeding, don't stage unrelated files.
- **Monorepo**: ask which package(s) to release.
- **No conventional commits**: `analyze_commits.py` groups them as "Other Changes" — ask user to pick bump level manually.
