#!/usr/bin/env python3
"""Detect current version, all version sources, and git tag naming pattern."""

import json
import os
import re
import subprocess
import sys

SEMVER_RE = re.compile(r'^v?(\d+\.\d+\.\d+)')
TAG_PATTERNS = {
    "v": re.compile(r'^v\d+\.\d+\.\d+'),
    "bare": re.compile(r'^\d+\.\d+\.\d+'),
    "release-": re.compile(r'^release-\d+\.\d+\.\d+'),
}


def run_git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True, text=True)
    return r.stdout.strip().splitlines() if r.returncode == 0 else []


def read_version_field(path):
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    return data.get("version")


def read_toml_version(path):
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        for line in f:
            m = re.match(r'^version\s*=\s*"([^"]+)"', line.strip())
            if m:
                return m.group(1)
    return None


def read_version_file(root):
    for name in ("VERSION", "version.txt"):
        path = os.path.join(root, name)
        if os.path.isfile(path):
            v = open(path).read().strip()
            if v:
                return v, path
    return None, None


def detect(root, tags):
    root = root or "."
    sources = []

    pkg_v = read_version_field(os.path.join(root, "package.json"))
    if pkg_v:
        sources.append({"file": "package.json", "version": pkg_v})

    py_v = read_toml_version(os.path.join(root, "pyproject.toml"))
    if py_v:
        sources.append({"file": "pyproject.toml", "version": py_v})

    cargo_v = read_toml_version(os.path.join(root, "Cargo.toml"))
    if cargo_v:
        sources.append({"file": "Cargo.toml", "version": cargo_v})

    file_v, file_p = read_version_file(root)
    if file_v:
        sources.append({"file": os.path.basename(file_p), "version": file_v})

    # Tag-based version
    tag_version = None
    latest_tag = None
    for t in tags:
        m = SEMVER_RE.match(t.strip())
        if m:
            tag_version = m.group(1)
            latest_tag = t.strip()
            break

    primary = sources[0] if sources else (
        {"file": f"git-tag:{latest_tag}", "version": tag_version} if tag_version else None
    )

    # Tag pattern
    counts = {k: 0 for k in TAG_PATTERNS}
    for t in tags:
        ts = t.strip()
        for name, pat in TAG_PATTERNS.items():
            if pat.match(ts):
                counts[name] += 1
                break
    best = max(counts, key=counts.get)
    has_version_tags = counts[best] > 0
    prefix = "" if best == "bare" else best

    return {
        "version": primary["version"] if primary else None,
        "source": primary["file"] if primary else None,
        "all_sources": sources,
        "tag_version": tag_version,
        "tag_prefix": prefix if has_version_tags else "v",
    }


def main():
    root = (run_git("rev-parse", "--show-toplevel") or [None])[0]
    tags = run_git("tag", "--list", "--sort=-version:refname")
    result = detect(root, tags)
    if not result["version"]:
        result["error"] = "no version found"
    print(json.dumps(result))
    sys.exit(1 if not result["version"] else 0)


if __name__ == "__main__":
    main()
