#!/usr/bin/env python3
"""Create or reuse a named cmux workspace and split panes for a worktree."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time


SELECT_SETTLE_SECONDS = 0.25
SPLIT_SETTLE_SECONDS = 0.5
PROMPT_WAIT_SECONDS = 10.0
PROMPT_MARKERS = ("❯", "➜")


def warn(message: str) -> None:
    print(f"WARN: {message}")


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def parse_json_payload(stdout: str):
    text = stdout.strip()
    if not text:
        return {}
    for index, char in enumerate(text):
        if char in "{[":
            return json.loads(text[index:])
    return {"raw": text}


def pick_right_column_targets(panes: list[dict]) -> tuple[dict, dict]:
    if not panes:
        raise ValueError("no panes")

    def frame_x(pane: dict) -> float:
        return float(pane["pixel_frame"]["x"])

    def frame_y(pane: dict) -> float:
        return float(pane["pixel_frame"]["y"])

    max_x = max(frame_x(pane) for pane in panes)
    right_column = [pane for pane in panes if abs(frame_x(pane) - max_x) < 2.0]
    if not right_column:
        right_column = panes
    top = min(right_column, key=frame_y)
    bottom = max(right_column, key=frame_y)
    return top, bottom


def find_named_workspace(tree: dict, name: str) -> dict | None:
    for window in tree.get("windows") or []:
        for workspace in window.get("workspaces") or []:
            if workspace.get("title") == name:
                return {
                    "workspace_ref": workspace["ref"],
                    "workspace_id": workspace.get("id"),
                    "window_ref": window["ref"],
                }
    return None


class Cmux:
    def __init__(self, binary: str) -> None:
        self.binary = binary
        self.env = os.environ.copy()
        self.env["CMUX_QUIET"] = "1"

    def run(self, args: list[str], json_output: bool = True) -> dict | str:
        command = [self.binary]
        if json_output:
            command.append("--json")
        command.extend(args)
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            env=self.env,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
            fail(f"cmux {' '.join(args)} failed: {detail}")
        if not json_output:
            return result.stdout
        try:
            return parse_json_payload(result.stdout)
        except json.JSONDecodeError as error:
            fail(f"cmux {' '.join(args)} returned invalid JSON: {error}: {result.stdout[:500]}")

    def ping(self) -> bool:
        result = subprocess.run(
            [self.binary, "ping"],
            capture_output=True,
            text=True,
            env=self.env,
        )
        return result.returncode == 0


def stacked_layout(worktree: str) -> str:
    return json.dumps(
        {
            "direction": "vertical",
            "split": 0.5,
            "children": [
                {"pane": {"surfaces": [{"type": "terminal", "cwd": worktree}]}},
                {"pane": {"surfaces": [{"type": "terminal", "cwd": worktree}]}},
            ],
        },
        separators=(",", ":"),
    )


def list_panes(cmux: Cmux, workspace_ref: str, window_ref: str) -> list[dict]:
    data = cmux.run(
        ["list-panes", "--workspace", workspace_ref, "--window", window_ref]
    )
    if not isinstance(data, dict):
        fail("cmux list-panes returned an unexpected payload")
    panes = data.get("panes")
    if not isinstance(panes, list):
        fail("cmux list-panes did not return a pane list")
    return panes


def split_pane(
    cmux: Cmux,
    pane: dict,
    direction: str,
    workspace_ref: str,
    window_ref: str,
) -> None:
    surface = pane.get("selected_surface_ref")
    args = [
        "new-split",
        direction,
        "--workspace",
        workspace_ref,
        "--window",
        window_ref,
        "--focus",
        "false",
    ]
    if surface:
        args.extend(["--surface", str(surface)])
    cmux.run(args, json_output=False)


def read_screen(
    cmux: Cmux,
    workspace_ref: str,
    window_ref: str,
    surface: str,
) -> str:
    return str(
        cmux.run(
            [
                "read-screen",
                "--workspace",
                workspace_ref,
                "--window",
                window_ref,
                "--surface",
                surface,
                "--lines",
                "30",
            ],
            json_output=False,
        )
    )


def screen_has_prompt(text: str) -> bool:
    if any(marker in text for marker in PROMPT_MARKERS):
        return True
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return False
    tail = lines[-1].rstrip()
    return tail.endswith(("%", "$", "#"))


def wait_for_shell_prompt(
    cmux: Cmux,
    workspace_ref: str,
    window_ref: str,
    surface: str,
) -> None:
    deadline = time.time() + PROMPT_WAIT_SECONDS
    last = ""
    while time.time() < deadline:
        last = read_screen(cmux, workspace_ref, window_ref, surface)
        if screen_has_prompt(last):
            return
        time.sleep(0.2)
    warn(f"shell prompt not detected on {surface} within {PROMPT_WAIT_SECONDS:.0f}s; sending cd anyway")


def send_cd(
    cmux: Cmux,
    pane: dict,
    worktree: str,
    workspace_ref: str,
    window_ref: str,
) -> None:
    surface = pane.get("selected_surface_ref")
    if not surface:
        fail(f"pane {pane.get('ref')} has no selected surface to send cd")
    wait_for_shell_prompt(cmux, workspace_ref, window_ref, str(surface))
    cmux.run(
        [
            "send",
            "--workspace",
            workspace_ref,
            "--window",
            window_ref,
            "--surface",
            str(surface),
            "--",
            f"cd {shlex.quote(worktree)}",
        ],
        json_output=False,
    )
    cmux.run(
        [
            "send-key",
            "--workspace",
            workspace_ref,
            "--window",
            window_ref,
            "--surface",
            str(surface),
            "enter",
        ],
        json_output=False,
    )


def select_workspace(cmux: Cmux, workspace_ref: str, window_ref: str) -> None:
    cmux.run(
        [
            "select-workspace",
            "--workspace",
            workspace_ref,
            "--window",
            window_ref,
        ],
        json_output=False,
    )
    time.sleep(SELECT_SETTLE_SECONDS)


def add_panes_for_worktree(
    cmux: Cmux,
    workspace_ref: str,
    window_ref: str,
    worktree: str,
) -> str:
    panes = list_panes(cmux, workspace_ref, window_ref)
    if not panes:
        fail("cmux workspace has no panes")

    before_refs = {pane.get("ref") for pane in panes}

    if len(panes) == 1:
        split_pane(cmux, panes[0], "down", workspace_ref, window_ref)
        time.sleep(SPLIT_SETTLE_SECONDS)
        after = list_panes(cmux, workspace_ref, window_ref)
        for pane in after:
            send_cd(cmux, pane, worktree, workspace_ref, window_ref)
        return "split one pane into two stacked panes"

    top, bottom = pick_right_column_targets(panes)
    split_pane(cmux, top, "right", workspace_ref, window_ref)
    if top.get("ref") != bottom.get("ref"):
        split_pane(cmux, bottom, "right", workspace_ref, window_ref)
    else:
        time.sleep(SPLIT_SETTLE_SECONDS)
        mid = list_panes(cmux, workspace_ref, window_ref)
        new_panes = [pane for pane in mid if pane.get("ref") not in before_refs]
        if not new_panes:
            fail("cmux new-split right did not create a pane")
        split_pane(cmux, new_panes[0], "down", workspace_ref, window_ref)

    time.sleep(SPLIT_SETTLE_SECONDS)
    after = list_panes(cmux, workspace_ref, window_ref)
    created = [pane for pane in after if pane.get("ref") not in before_refs]
    if not created:
        fail("cmux split did not create new panes")
    for pane in created:
        send_cd(cmux, pane, worktree, workspace_ref, window_ref)
    return "added two panes on the right"


def setup(name: str, worktree: str, folder_existed: bool) -> int:
    binary = shutil.which("cmux")
    if not binary:
        fail("cmux CLI not found.")

    cmux = Cmux(binary)
    if not cmux.ping():
        fail("cmux is not running.")

    worktree = os.path.abspath(worktree)
    tree = cmux.run(["tree", "--all"])
    if not isinstance(tree, dict):
        fail("cmux tree returned an unexpected payload")
    found = find_named_workspace(tree, name)

    if found is None:
        cmux.run(
            [
                "new-workspace",
                "--name",
                name,
                "--cwd",
                worktree,
                "--layout",
                stacked_layout(worktree),
                "--focus",
                "true",
            ],
            json_output=False,
        )
        tree = cmux.run(["tree", "--all"])
        if not isinstance(tree, dict):
            fail("cmux tree returned an unexpected payload after create")
        found = find_named_workspace(tree, name)
        if found is None:
            fail(f"created cmux workspace {name} but could not find it")
        select_workspace(cmux, found["workspace_ref"], found["window_ref"])
        panes = list_panes(cmux, found["workspace_ref"], found["window_ref"])
        if len(panes) <= 1:
            add_panes_for_worktree(
                cmux,
                found["workspace_ref"],
                found["window_ref"],
                worktree,
            )
        print(f"Created cmux workspace: {name}")
        print(f"Cmux workspace ref: {found['workspace_ref']}")
        return 0

    select_workspace(cmux, found["workspace_ref"], found["window_ref"])
    if folder_existed:
        print(f"Cmux workspace already set up for this worktree; selected {name}.")
        print(f"Cmux workspace ref: {found['workspace_ref']}")
        return 0

    action = add_panes_for_worktree(
        cmux,
        found["workspace_ref"],
        found["window_ref"],
        worktree,
    )
    print(f"Updated cmux workspace {name}: {action}.")
    print(f"Cmux workspace ref: {found['workspace_ref']}")
    return 0


def self_test() -> None:
    stacked = [
        {"ref": "a", "pixel_frame": {"x": 0, "y": 0}},
        {"ref": "b", "pixel_frame": {"x": 0, "y": 100}},
    ]
    top, bottom = pick_right_column_targets(stacked)
    assert top["ref"] == "a" and bottom["ref"] == "b", (top, bottom)

    grid = [
        {"ref": "tl", "pixel_frame": {"x": 0, "y": 0}},
        {"ref": "tr", "pixel_frame": {"x": 100, "y": 0}},
        {"ref": "bl", "pixel_frame": {"x": 0, "y": 100}},
        {"ref": "br", "pixel_frame": {"x": 100, "y": 100}},
    ]
    top, bottom = pick_right_column_targets(grid)
    assert top["ref"] == "tr" and bottom["ref"] == "br", (top, bottom)

    tree = {
        "windows": [
            {
                "ref": "window:1",
                "workspaces": [{"title": "dev-f-20260511-demo", "ref": "workspace:2", "id": "abc"}],
            }
        ]
    }
    found = find_named_workspace(tree, "dev-f-20260511-demo")
    assert found == {
        "workspace_ref": "workspace:2",
        "workspace_id": "abc",
        "window_ref": "window:1",
    }
    assert find_named_workspace(tree, "missing") is None
    assert screen_has_prompt("Welcome to fish\n~/tmp ❯ ")
    assert screen_has_prompt("user@host ~ %")
    assert not screen_has_prompt("Last login: Mon Aug 31\nYou have new mail.")
    print("self-test ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", help="cmux workspace title / branch name")
    parser.add_argument("--worktree", help="absolute worktree path")
    parser.add_argument("--folder-existed", choices=("0", "1"), help="1 if the VS Code workspace already had this folder")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.name or not args.worktree or args.folder_existed is None:
        parser.error("--name, --worktree, and --folder-existed are required")
    return setup(args.name, args.worktree, args.folder_existed == "1")


if __name__ == "__main__":
    sys.exit(main())
