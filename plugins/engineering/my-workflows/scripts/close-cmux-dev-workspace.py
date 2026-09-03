#!/usr/bin/env python3
"""Close the cmux workspace that was created for a dev branch worktree."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys


def warn(message: str) -> None:
    print(f"WARN: {message}")


def parse_json_payload(stdout: str):
    text = stdout.strip()
    if not text:
        return {}
    for index, char in enumerate(text):
        if char in "{[":
            return json.loads(text[index:])
    return {"raw": text}


def find_named_workspace(tree: dict, name: str) -> dict | None:
    for window in tree.get("windows") or []:
        for workspace in window.get("workspaces") or []:
            if workspace.get("title") == name:
                return {
                    "workspace_ref": workspace["ref"],
                    "window_ref": window["ref"],
                }
    return None


def run_cmux(binary: str, args: list[str]):
    env = os.environ.copy()
    env["CMUX_QUIET"] = "1"
    return subprocess.run([binary, *args], capture_output=True, text=True, env=env)


def detail(result) -> str:
    return (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"


def close(name: str) -> None:
    """Warn instead of failing: cleanup must not stop because cmux is unavailable."""
    binary = shutil.which("cmux")
    if not binary:
        warn("cmux CLI not found; no cmux workspace was closed.")
        return

    if run_cmux(binary, ["ping"]).returncode != 0:
        warn("cmux is not running; no cmux workspace was closed.")
        return

    listed = run_cmux(binary, ["--json", "tree", "--all"])
    if listed.returncode != 0:
        warn(f"cmux tree failed: {detail(listed)}")
        return

    try:
        tree = parse_json_payload(listed.stdout)
    except json.JSONDecodeError as error:
        warn(f"cmux tree returned invalid JSON: {error}")
        return
    if not isinstance(tree, dict):
        warn("cmux tree returned an unexpected payload")
        return

    found = find_named_workspace(tree, name)
    if found is None:
        print(f"No cmux workspace named {name}; nothing to close.")
        return

    closed = run_cmux(
        binary,
        [
            "close-workspace",
            "--workspace",
            found["workspace_ref"],
            "--window",
            found["window_ref"],
        ],
    )
    if closed.returncode != 0:
        warn(f"cmux close-workspace failed: {detail(closed)}")
        return

    print(f"Closed cmux workspace: {name} ({found['workspace_ref']})")


def self_test() -> None:
    tree = {
        "windows": [
            {
                "ref": "window:1",
                "workspaces": [
                    {"title": "other-branch", "ref": "workspace:1"},
                    {"title": "dev-f-20260511-demo", "ref": "workspace:2", "id": "abc"},
                ],
            }
        ]
    }
    assert find_named_workspace(tree, "dev-f-20260511-demo") == {
        "workspace_ref": "workspace:2",
        "window_ref": "window:1",
    }
    assert find_named_workspace(tree, "dev-f-20260511-dem") is None
    assert find_named_workspace({}, "dev-f-20260511-demo") is None
    assert parse_json_payload("") == {}
    assert parse_json_payload('cmux note\n{"windows": []}') == {"windows": []}
    print("self-test ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", help="cmux workspace title / branch name")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.name:
        parser.error("--name is required")
    close(args.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
