#!/usr/bin/env python3
"""Implicit-invocation check for Claude Code: does Claude load the skill on its own
when the request matches the description, and leave it alone otherwise?

The plugin is loaded with --plugin-dir, the prompt contains no slash command, and
we look for a `Skill` tool call naming senior-plan-review in the event stream.

  python3 trigger_check.py --run-id trig1
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
FIXTURE = HERE / "fixtures" / "ledgerly"

CASES = [
    {"id": "t1-should", "expect": True,
     "prompt": "Here is my plan for fixing the oversell bug in src/services/inventory.ts: wrap the SELECT/UPDATE in a per-product in-memory mutex and add a concurrency unit test. Can you sanity-check this before I approve it? Don't change anything."},
    {"id": "t2-should", "expect": True,
     "prompt": "Before you start: I want to add refresh tokens (30 days, stateless JWT, stored in localStorage). Give me the review you'd want a senior engineer to sign off on, then wait for my approval."},
    {"id": "t3-should", "expect": True,
     "prompt": "I'm about to approve a migration that splits customers.full_name into first_name/last_name and drops the old column in the same release. Explain the risks and whether I should approve. Review only."},
    {"id": "t4-should-not", "expect": False,
     "prompt": "What does the regex in src/routes/webhooks.ts verifySignature do, in one paragraph?"},
    {"id": "t5-should-not", "expect": False,
     "prompt": "List the npm scripts defined in package.json and what each one runs."},
    {"id": "t6-should-not", "expect": False,
     "prompt": "Review this diff for style issues only: in StatusBadge.tsx I changed `fontWeight: 600` to `fontWeight: 700`. Any objections?"},
]


def run_case(case: dict, work: Path, model: str) -> dict:
    cmd = ["claude", "-p", case["prompt"], "--model", model, "--output-format", "stream-json", "--verbose",
           "--no-session-persistence", "--setting-sources", "project", "--permission-mode", "default",
           "--permission-prompts", "none", "--allowedTools", "Read Grep Glob Skill", "--plugin-dir", str(PLUGIN_ROOT)]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=600)
    invoked, final = False, ""
    for line in proc.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant":
            for c in ev["message"].get("content", []):
                if c.get("type") == "tool_use" and c["name"] == "Skill" and "senior-plan-review" in json.dumps(c.get("input", {})):
                    invoked = True
        elif ev.get("type") == "result":
            final = ev.get("result", "")
    return {"id": case["id"], "expected_trigger": case["expect"], "triggered": invoked, "correct": invoked == case["expect"],
            "elapsed_s": round(time.time() - t0, 1), "final_text_head": final[:400]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--model", default="sonnet")
    args = ap.parse_args()
    out_dir = HERE / "results" / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    base = Path(tempfile.mkdtemp(prefix="spr-trigger-"))
    results = []
    for case in CASES:
        work = base / case["id"]
        shutil.copytree(FIXTURE, work)
        r = run_case(case, work, args.model)
        results.append(r)
        print(f"[trigger] {r['id']:16s} expected={r['expected_trigger']!s:5} triggered={r['triggered']!s:5} {'OK' if r['correct'] else 'MISS'} {r['elapsed_s']}s", flush=True)
    shutil.rmtree(base, ignore_errors=True)
    summary = {"model": args.model, "cases": results, "accuracy": f"{sum(r['correct'] for r in results)}/{len(results)}"}
    (out_dir / "trigger_check.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print("accuracy", summary["accuracy"])


if __name__ == "__main__":
    main()
