---
name: package-release
description: Automate package versioning and changelog generation using conventional commit standards.
disable-model-invocation: true
---

# Package Release Skill

Automates the release workflow: analyze commits → bump version → changelog → commit → tag.

Uses [cz-conventional-changelog](https://github.com/commitizen/cz-conventional-changelog) conventions. Two scripts handle all deterministic work:

## Workflow

### Step 1: Get project info

```bash
# Detects current version from project files/tags, reports tag naming pattern
python3 scripts/release_info.py
```

Returns `version`, `source`, `all_sources` (every file containing a version), and `tag_prefix` (defaults to `"v"` when no version tags exist; `"v"` if tags look like `v1.0.0`, `""` for bare `1.0.0`, etc.). If `version` is null, ask the user.

### Step 2: Analyze commits

```bash
# Parses conventional commits, determines bump, generates changelog
python3 scripts/analyze_commits.py <current-version> [since-ref]
```

`since-ref` is optional — auto-detected from latest version tag, falling back to the last `chore(release):` commit. Returns `bump_type` (major/minor/patch or null), `new_version`, `since_ref` (the ref actually used), and `changelog` (ready-to-insert markdown). If `bump_type` is null, no conventional commits were found — ask the user to classify the release.

### Step 3: Confirm with user

Show the analysis from Step 2 via AskUserQuestion: current → new version, bump type, and changelog preview. Let the user accept, adjust bump level, or cancel.

### Step 4: Apply changes

1. **CHANGELOG.md** — **insert a new version section** using the `changelog` field from Step 2. Never edit or overwrite existing version entries. If the file exists, insert the new section right after the `# Changelog` heading, pushing older entries down. If not, create with that heading.
2. **Version files** — update version in every file listed in `all_sources` from Step 1.
3. **Commit** — stage changed files, commit as `chore(release): <version>`. Do not push.
4. **Tag** — create a tag as `<tag_prefix><version>` using `tag_prefix` from Step 1 (defaults to `v`). Do not push.

## Edge cases

- **Uncommitted changes**: warn before proceeding, don't stage unrelated files.
- **Monorepo**: ask which package(s) to release.
- **No conventional commits**: `analyze_commits.py` groups them as "Other Changes" — ask user to pick bump level manually.
