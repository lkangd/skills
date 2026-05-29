#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Sequence

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
FALLBACK_LOG_COUNT = 20


class BumpError(Exception):
    pass


@dataclass(frozen=True)
class Paths:
    repo_root: Path
    plugin_json: Path
    marketplace_json: Path
    changelog: Path


@dataclass(frozen=True)
class VersionState:
    current: str
    target: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bump rocky-pal plugin version, generate changelog, and optionally commit."
    )
    version_group = parser.add_mutually_exclusive_group(required=False)
    version_group.add_argument("--version", help="Target version, e.g. 0.2.5")
    version_group.add_argument(
        "--auto-patch",
        action="store_true",
        help="Auto bump patch version (default when no version arg is provided).",
    )

    parser.add_argument("-m", "--message", help="Extra release note text.")
    parser.add_argument("--dry-run", action="store_true", help="Preview only; write nothing.")
    parser.add_argument(
        "--no-commit", action="store_true", help="Update files but skip git commit."
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Allow running with a dirty working tree.",
    )
    return parser.parse_args()


def get_paths() -> Paths:
    repo_root = Path(__file__).resolve().parents[1]
    return Paths(
        repo_root=repo_root,
        plugin_json=repo_root / ".claude-plugin" / "plugin.json",
        marketplace_json=repo_root / ".claude-plugin" / "marketplace.json",
        changelog=repo_root / "CHANGELOG.md",
    )


def run_git(paths: Paths, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=paths.repo_root,
        check=True,
        text=True,
        capture_output=True,
    )


def validate_repo(paths: Paths) -> None:
    if not (paths.repo_root / ".git").exists():
        raise BumpError(f"Not a git repository: {paths.repo_root}")


def read_json(path: Path) -> dict:
    if not path.exists():
        raise BumpError(f"Missing file: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BumpError(f"Invalid JSON in {path}: {exc}") from exc


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_semver(version: str) -> tuple[int, int, int]:
    match = SEMVER_RE.match(version)
    if not match:
        raise BumpError(f"Invalid version '{version}'. Expected X.Y.Z")
    return tuple(int(x) for x in match.groups())


def bump_patch(version: str) -> str:
    major, minor, patch = parse_semver(version)
    return f"{major}.{minor}.{patch + 1}"


def resolve_versions(args: argparse.Namespace, current: str) -> VersionState:
    if args.version is not None:
        parse_semver(args.version)
        target = args.version
    else:
        target = bump_patch(current)

    if target == current:
        raise BumpError(f"Target version equals current version: {current}")

    if parse_semver(target) <= parse_semver(current):
        raise BumpError(
            f"Target version must be greater than current version ({current} -> {target})"
        )

    return VersionState(current=current, target=target)


def load_current_version(paths: Paths) -> tuple[str, dict, dict]:
    plugin_data = read_json(paths.plugin_json)
    marketplace_data = read_json(paths.marketplace_json)

    plugin_version = plugin_data.get("version")
    if not isinstance(plugin_version, str):
        raise BumpError(f"Missing string 'version' in {paths.plugin_json}")

    plugins = marketplace_data.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        raise BumpError(f"Missing non-empty 'plugins' array in {paths.marketplace_json}")

    first_plugin = plugins[0]
    if not isinstance(first_plugin, dict):
        raise BumpError(f"Invalid plugins[0] object in {paths.marketplace_json}")

    market_version = first_plugin.get("version")
    if not isinstance(market_version, str):
        raise BumpError(f"Missing string 'plugins[0].version' in {paths.marketplace_json}")

    if plugin_version != market_version:
        raise BumpError(
            "Version mismatch before bump: "
            f"plugin.json={plugin_version}, marketplace.json={market_version}"
        )

    parse_semver(plugin_version)
    return plugin_version, plugin_data, marketplace_data


def ensure_clean_worktree(paths: Paths, allow_dirty: bool) -> None:
    if allow_dirty:
        return
    result = run_git(paths, ["status", "--porcelain"])
    if result.stdout.strip():
        raise BumpError("Working tree is dirty. Commit/stash first or use --allow-dirty")


def collect_commit_subjects(paths: Paths, old_version: str) -> tuple[list[str], bool]:
    marker = f"v{old_version}"
    log = run_git(paths, ["log", "--format=%H%x00%s"])

    marker_hash = ""
    for line in log.stdout.splitlines():
        if "\x00" not in line:
            continue
        commit_hash, subject = line.split("\x00", 1)
        if marker in subject:
            marker_hash = commit_hash
            break

    if marker_hash:
        since = run_git(paths, ["log", f"{marker_hash}..HEAD", "--format=%s"])
        subjects = [s.strip() for s in since.stdout.splitlines() if s.strip()]
        return subjects, False

    fallback = run_git(paths, ["log", f"-{FALLBACK_LOG_COUNT}", "--format=%s"])
    subjects = [s.strip() for s in fallback.stdout.splitlines() if s.strip()]
    return subjects, True


def build_changelog_section(
    new_version: str,
    old_version: str,
    subjects: list[str],
    is_fallback: bool,
    extra_message: str | None,
) -> str:
    today = date.today().isoformat()
    lines: list[str] = [f"## v{new_version} - {today}"]

    if extra_message:
        lines.append(f"- {extra_message.strip()}")

    lines.append(f"- Version bump: v{old_version} -> v{new_version}")

    if is_fallback:
        lines.append(f"- Note: fallback changelog from latest {FALLBACK_LOG_COUNT} commits")

    features = [s for s in subjects if s.startswith("feat:")]
    fixes = [s for s in subjects if s.startswith("fix:")]
    others = [s for s in subjects if s not in features and s not in fixes]

    def append_group(title: str, items: list[str]) -> None:
        if not items:
            return
        lines.append("")
        lines.append(f"### {title}")
        for item in items:
            lines.append(f"- {item}")

    append_group("Features", features)
    append_group("Fixes", fixes)
    append_group("Others", others)

    if not subjects:
        lines.append("- No commit subjects found since previous version marker")

    return "\n".join(lines).rstrip() + "\n"


def apply_changelog(paths: Paths, section: str, new_version: str) -> str:
    heading = f"## v{new_version} - "
    if paths.changelog.exists():
        existing = paths.changelog.read_text(encoding="utf-8")
    else:
        existing = "# Changelog\n\n"

    if heading in existing:
        raise BumpError(f"CHANGELOG already contains section for v{new_version}")

    if existing.startswith("# Changelog"):
        first_newline = existing.find("\n")
        prefix = existing[: first_newline + 1]
        rest = existing[first_newline + 1 :].lstrip("\n")
        updated = f"{prefix}\n{section}\n{rest}" if rest else f"{prefix}\n{section}"
    else:
        updated = f"# Changelog\n\n{section}\n{existing.lstrip()}"

    return updated.rstrip() + "\n"


def preview(
    state: VersionState,
    section: str,
    paths: Paths,
    message: str | None,
    no_commit: bool,
) -> None:
    print("[dry-run] Rocky-pal version bump preview")
    print(f"- Current version: {state.current}")
    print(f"- Target version:  {state.target}")
    print(f"- Update: {paths.plugin_json} -> version={state.target}")
    print(f"- Update: {paths.marketplace_json} -> plugins[0].version={state.target}")
    if message:
        print(f"- Extra message: {message}")
    print("\n[dry-run] Changelog section:\n")
    print(section.rstrip())
    print("\n[dry-run] Git commands:")
    if no_commit:
        print("- (skip commit due to --no-commit)")
    else:
        print("- git add .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md")
        print(f"- git commit -m 'feat: bump rocky-pal version to v{state.target}'")


def commit_changes(paths: Paths, new_version: str, message: str | None) -> None:
    files = [
        ".claude-plugin/plugin.json",
        ".claude-plugin/marketplace.json",
        "CHANGELOG.md",
    ]
    run_git(paths, ["add", *files])

    subject = f"feat: bump rocky-pal version to v{new_version}"
    commit_args = ["commit", "-m", subject]
    if message:
        commit_args.extend(["-m", message.strip()])
    run_git(paths, commit_args)


def main() -> int:
    args = parse_args()
    paths = get_paths()

    try:
        validate_repo(paths)
        ensure_clean_worktree(paths, allow_dirty=args.allow_dirty)

        current, plugin_data, marketplace_data = load_current_version(paths)
        state = resolve_versions(args, current)

        subjects, is_fallback = collect_commit_subjects(paths, state.current)
        section = build_changelog_section(
            new_version=state.target,
            old_version=state.current,
            subjects=subjects,
            is_fallback=is_fallback,
            extra_message=args.message,
        )
        updated_changelog = apply_changelog(paths, section, state.target)

        if args.dry_run:
            preview(state, section, paths, args.message, args.no_commit)
            return 0

        plugin_data["version"] = state.target
        marketplace_data["plugins"][0]["version"] = state.target

        write_json(paths.plugin_json, plugin_data)
        write_json(paths.marketplace_json, marketplace_data)
        paths.changelog.write_text(updated_changelog, encoding="utf-8")

        # Re-validate after write
        post_current, _, _ = load_current_version(paths)
        if post_current != state.target:
            raise BumpError(
                f"Post-write validation failed: expected {state.target}, got {post_current}"
            )

        if not args.no_commit:
            commit_changes(paths, state.target, args.message)

        print(f"Done. Version bumped: {state.current} -> {state.target}")
        print(f"Updated: {paths.plugin_json}")
        print(f"Updated: {paths.marketplace_json}")
        print(f"Updated: {paths.changelog}")
        if args.no_commit:
            print("Commit skipped (--no-commit).")
        else:
            print("Commit created.")
        return 0
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() if exc.stderr else str(exc)
        print(f"Error: git command failed: {stderr}", file=sys.stderr)
        return 1
    except BumpError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
