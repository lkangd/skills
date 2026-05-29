#!/usr/bin/env python3
"""Parse conventional commits, determine bump, and generate changelog in one pass."""

import json
import re
import subprocess
import sys
from datetime import date

CONVENTIONAL_RE = re.compile(r'^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$')
VALID_TYPES = {'feat','fix','docs','style','refactor','perf','test','chore','ci','build','revert'}
BUMP_ORDER = {"feat": "minor", "fix": "patch", "perf": "patch", "refactor": "patch",
              "docs": "patch", "style": "patch", "test": "patch", "chore": "patch",
              "ci": "patch", "build": "patch"}
TYPE_HEADERS = {"feat":"Features","fix":"Bug Fixes","perf":"Performance Improvements",
                "refactor":"Code Refactoring","docs":"Documentation","revert":"Reverts"}
SECTION_ORDER = ["feat","fix","perf","refactor","docs","revert"]


def parse_version(v):
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)', v)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def bump_ver(major, minor, patch, bump_type):
    if bump_type == "major":
        return f"{major+1}.0.0"
    if bump_type == "minor":
        return f"{major}.{minor+1}.0"
    return f"{major}.{minor}.{patch+1}"


def format_entry(c):
    desc = c["description"].rstrip(".")
    if desc and desc[0].isupper():
        desc = desc[0].lower() + desc[1:]
    return f"* **{c['scope']}**: {desc}" if c.get("scope") else f"* {desc}"


def main():
    current_version = sys.argv[1] if len(sys.argv) > 1 else None
    since_ref = sys.argv[2] if len(sys.argv) > 2 else None

    if not current_version:
        print(json.dumps({"error": "usage: analyze_commits.py <version> [since_ref]"}))
        sys.exit(1)

    parsed_ver = parse_version(current_version)
    if not parsed_ver:
        print(json.dumps({"error": f"invalid version: {current_version}"}))
        sys.exit(1)

    # Auto-detect since ref from tags, fall back to last release commit
    if not since_ref:
        tags = subprocess.run(
            ["git", "tag", "--list", "--sort=-version:refname"],
            capture_output=True, text=True
        )
        if tags.returncode == 0:
            semver = re.compile(r'^v?\d+\.\d+\.\d+')
            for line in tags.stdout.strip().splitlines():
                if semver.match(line.strip()):
                    since_ref = line.strip()
                    break
        # Fallback: find last chore(release) commit when no tags exist
        if not since_ref:
            last_release = subprocess.run(
                ["git", "log", "--grep=^chore(release):", "--format=%H", "-1"],
                capture_output=True, text=True
            )
            if last_release.returncode == 0 and last_release.stdout.strip():
                since_ref = last_release.stdout.strip()

    # Get commits
    cmd = ["git", "log", "--format=%H|||%s|||%b|||---END---"]
    if since_ref:
        cmd.append(f"{since_ref}..HEAD")
    r = subprocess.run(cmd, capture_output=True, text=True)

    commits = []
    breaking_commits = []
    has_breaking = False
    bump_type = None
    grouped = {}
    non_conv = []

    if r.returncode == 0 and r.stdout.strip():
        for entry in r.stdout.strip().split("|||---END---\n"):
            parts = entry.split("|||")
            if len(parts) < 2 or not parts[0].strip():
                continue
            h, subject, body = parts[0].strip()[:8], parts[1].strip(), parts[2].strip() if len(parts) > 2 else ""
            m = CONVENTIONAL_RE.match(subject)
            if not m or m.group(1) not in VALID_TYPES:
                non_conv.append({"hash": h, "raw": subject})
                continue
            ctype, scope, bang, desc = m.group(1), m.group(2), m.group(3) is not None, m.group(4).strip()
            breaking = bang or ("BREAKING CHANGE" in body)
            bd = re.search(r'BREAKING CHANGE:\s*(.+)', body).group(1).strip() if breaking and "BREAKING CHANGE" in body else None

            c = {"hash": h, "type": ctype, "scope": scope, "breaking": breaking, "description": desc}
            if bd:
                c["breaking_description"] = bd
            commits.append(c)
            grouped.setdefault(ctype, []).append(c)

            if breaking:
                has_breaking = True
                breaking_commits.append(c)

    # Determine bump
    if has_breaking:
        bump_type = "major"
    elif "feat" in grouped:
        bump_type = "minor"
    elif grouped:
        bump_type = "patch"

    new_version = bump_ver(*parsed_ver, bump_type) if bump_type else None

    # Generate changelog
    lines = [f"## {new_version or current_version} ({date.today().isoformat()})", ""]
    for ct in SECTION_ORDER:
        if ct not in grouped:
            continue
        entries = grouped[ct]
        entries.sort(key=lambda e: (0 if e.get("scope") else 1, e["description"].lower()))
        lines.append(f"### {TYPE_HEADERS.get(ct, ct.title())}")
        lines.extend(format_entry(e) for e in entries)
        lines.append("")
    if non_conv:
        lines.append("### Other Changes")
        for nc in non_conv:
            d = nc["raw"].rstrip(".")
            if d and d[0].isupper():
                d = d[0].lower() + d[1:]
            lines.append(f"* {d}")
        lines.append("")
    if breaking_commits:
        bns = [c["breaking_description"] for c in breaking_commits if c.get("breaking_description")]
        if bns:
            lines.append("### BREAKING CHANGES")
            lines.extend(f"* {n}" for n in bns)
            lines.append("")

    result = {
        "current_version": current_version,
        "new_version": new_version,
        "bump_type": bump_type,
        "since_ref": since_ref,
        "total_commits": len(commits) + len(non_conv),
        "conventional_commits": len(commits),
        "non_conventional_commits": len(non_conv),
        "breaking_count": len(breaking_commits),
        "changelog": "\n".join(lines),
    }
    print(json.dumps(result))
    sys.exit(0 if bump_type else 1)


if __name__ == "__main__":
    main()
