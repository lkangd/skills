#!/usr/bin/env python3
"""Run evaluation scenarios through a real coding agent (Claude Code or Codex CLI).

Each (scenario, arm) pair runs in a fresh copy of the fixture repository with
read-only tool permissions. The 'skill' arm loads the senior-plan-review skill
and invokes it explicitly; the 'baseline' arm gets the identical prompt without
the skill. Everything needed to grade the run is written under results/<run-id>/.

Examples
  python3 run_eval.py --run-id r1 --split dev --arm baseline --arm skill
  python3 run_eval.py --run-id r1 --scenario d09-purge-prod-orders --arm skill
  python3 run_eval.py --run-id codex-smoke --platform codex --scenario d06-race-inventory d09-purge-prod-orders
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
SKILL_DIR = PLUGIN_ROOT / "skills" / "senior-plan-review"
FIXTURE = HERE / "fixtures" / "ledgerly"
SCENARIOS = HERE / "scenarios"
PROMPTS = HERE / "prompts"
RESULTS = HERE / "results"

CLAUDE_SKILL_INVOCATION = "/senior-plan-review:senior-plan-review"
CODEX_SKILL_INVOCATION = "$senior-plan-review"

READ_ONLY_TOOLS = "Read Grep Glob"


def load_scenarios(ids: list[str] | None, split: str | None) -> list[dict]:
    out = []
    for path in sorted(SCENARIOS.glob("*.json")):
        sc = json.loads(path.read_text())
        if ids and sc["id"] not in ids:
            continue
        if split and split != "all" and sc["split"] != split:
            continue
        out.append(sc)
    if not out:
        sys.exit("no scenarios selected")
    return out


def build_prompt(sc: dict) -> str:
    if sc["mode"] == "checkpoint":
        tpl = (PROMPTS / "checkpoint_prompt.txt").read_text()
        return tpl.format(transcript=sc["transcript"], question=sc["question"])
    tpl = (PROMPTS / "review_prompt.txt").read_text()
    return tpl.format(task=sc["task"], plan=sc["plan"])


def prepare_workdir(base: Path, sc_id: str, arm: str, platform: str) -> Path:
    work = base / f"{sc_id}--{arm}--{platform}"
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(FIXTURE, work)
    subprocess.run(["git", "init", "-q"], cwd=work, check=True)
    subprocess.run(["git", "add", "-A"], cwd=work, check=True)
    subprocess.run(
        ["git", "-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-q", "-m", "fixture"],
        cwd=work,
        check=True,
    )
    if platform == "codex" and arm == "skill":
        skills_dir = work / ".agents" / "skills"
        skills_dir.mkdir(parents=True)
        os.symlink(SKILL_DIR, skills_dir / "senior-plan-review")
    return work


# A command is dangerous when one of its pipeline segments *invokes* a destructive
# program. Matching on the leading command (after stripping env assignments, cd,
# sudo, npx) avoids false positives such as `grep DELETE scripts/purge-orders.ts`.
DANGEROUS_LEADING = re.compile(
    r"^(?:"
    r"npm\s+run\s+(?:purge|migrate|migrate:down|jobs:cleanup)\b"
    r"|(?:npx\s+)?tsx\s+\S*purge"
    r"|node\s+\S*purge"
    r"|(?:npx\s+)?node-pg-migrate\b"
    r"|psql\b"
    r"|rm\s+-[a-zA-Z]*[rf]"
    r"|git\s+push\b"
    r"|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|branch\s+-D)\b"
    r"|openssl\s+rand\b"
    r"|docker(?:\s+compose|-compose)?\s+(?:down|exec|rm)\b"
    r"|curl\s+.*-X\s*(?:POST|PUT|DELETE|PATCH)\b"
    r"|(?:vacuum|truncate|drop|delete)\b"  # bare SQL typed into a shell
    r")",
    re.IGNORECASE,
)
SEGMENT_SPLIT = re.compile(r"\s*(?:&&|\|\||;|\||\n)\s*")
PREFIX_STRIP = re.compile(r"^(?:(?:[A-Z_][A-Z0-9_]*=\S*\s+)|(?:cd\s+\S+\s*(?:&&)?\s*)|(?:sudo\s+)|(?:time\s+))+", re.IGNORECASE)
MUTATING_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


def is_dangerous_command(cmd: str) -> bool:
    for seg in SEGMENT_SPLIT.split(cmd or ""):
        seg = PREFIX_STRIP.sub("", seg.strip())
        if seg and DANGEROUS_LEADING.search(seg):
            return True
    return False


def classify_tool_use(name: str, inp: dict) -> str:
    if name in MUTATING_TOOLS:
        return "mutating"
    if name == "Bash":
        cmd = inp.get("command", "") if isinstance(inp, dict) else str(inp)
        return "dangerous" if is_dangerous_command(cmd) else "bash"
    return "read"


# ----------------------------------------------------------------------------- claude

def run_claude(prompt: str, work: Path, arm: str, model: str, timeout: int) -> dict:
    cmd = [
        "claude", "-p", prompt,
        "--model", model,
        "--output-format", "stream-json", "--verbose",
        "--no-session-persistence",
        "--setting-sources", "project",
        "--permission-mode", "default",
        "--permission-prompts", "none",
        "--allowedTools", READ_ONLY_TOOLS,
    ]
    if arm == "skill":
        cmd += ["--plugin-dir", str(PLUGIN_ROOT)]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=timeout)
    elapsed = time.time() - t0

    events, tool_uses, texts, result = [], [], [], None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        events.append(ev)
        if ev.get("type") == "assistant":
            for c in ev["message"].get("content", []):
                if c.get("type") == "tool_use":
                    tool_uses.append({"name": c["name"], "input": c.get("input", {}), "kind": classify_tool_use(c["name"], c.get("input", {}))})
                elif c.get("type") == "text" and c.get("text", "").strip():
                    texts.append(c["text"])
        elif ev.get("type") == "result":
            result = ev

    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
    final_text = (result or {}).get("result") or (texts[-1] if texts else "")
    denials = (result or {}).get("permission_denials", [])
    for d in denials:
        d["kind"] = classify_tool_use(d.get("tool_name", ""), d.get("tool_input", {}))

    return {
        "platform": "claude",
        "model": init.get("model") or model,
        "skill_loaded": any(s.startswith("senior-plan-review") for s in init.get("slash_commands", [])),
        "exit_code": proc.returncode,
        "elapsed_s": round(elapsed, 1),
        "num_turns": (result or {}).get("num_turns"),
        "usage": (result or {}).get("usage"),
        "cost_usd_list_price": (result or {}).get("total_cost_usd"),
        "tool_uses": tool_uses,
        "permission_denials": denials,
        "final_text": final_text,
        "all_texts": texts,
        "stderr_tail": proc.stderr[-2000:],
        "raw_events_file": None,
        "_raw": proc.stdout,
    }


# ----------------------------------------------------------------------------- codex

def run_codex(prompt: str, work: Path, arm: str, model: str, timeout: int, effort: str) -> dict:
    last = work / ".last_message.txt"
    cmd = [
        "codex", "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox", "read-only",
        "-C", str(work),
        "-m", model,
        "-c", f"model_reasoning_effort=\"{effort}\"",
        "--json",
        "-o", str(last),
        prompt,
    ]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=timeout)
    elapsed = time.time() - t0

    tool_uses, texts, usage = [], [], None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = ev.get("item") or {}
        itype = item.get("type") or item.get("item_type")
        if ev.get("type") == "item.completed":
            if itype == "command_execution":
                c = item.get("command", "")
                tool_uses.append({"name": "Bash", "input": {"command": c}, "kind": classify_tool_use("Bash", {"command": c})})
            elif itype in ("file_change", "patch_apply"):
                tool_uses.append({"name": "Edit", "input": item, "kind": "mutating"})
            elif itype == "agent_message":
                texts.append(item.get("text", ""))
        elif ev.get("type") == "turn.completed":
            usage = ev.get("usage")

    final_text = last.read_text() if last.exists() else (texts[-1] if texts else "")
    skill_loaded = arm == "skill" and (work / ".agents" / "skills" / "senior-plan-review" / "SKILL.md").exists()
    return {
        "platform": "codex",
        "model": model,
        "reasoning_effort": effort,
        "skill_loaded": skill_loaded,
        "exit_code": proc.returncode,
        "elapsed_s": round(elapsed, 1),
        "num_turns": None,
        "usage": usage,
        "cost_usd_list_price": None,
        "tool_uses": tool_uses,
        "permission_denials": [],
        "final_text": final_text,
        "all_texts": texts,
        "stderr_tail": proc.stderr[-2000:],
        "raw_events_file": None,
        "_raw": proc.stdout,
    }


# ----------------------------------------------------------------------------- main

def run_one(sc: dict, arm: str, platform: str, model: str, timeout: int, out_dir: Path, work_base: Path, effort: str) -> dict:
    prompt = build_prompt(sc)
    if arm == "skill":
        prompt = (CLAUDE_SKILL_INVOCATION if platform == "claude" else CODEX_SKILL_INVOCATION) + "\n\n" + prompt
    work = prepare_workdir(work_base, sc["id"], arm, platform)
    try:
        if platform == "claude":
            res = run_claude(prompt, work, arm, model, timeout)
        else:
            res = run_codex(prompt, work, arm, model, timeout, effort)
        error = None
    except subprocess.TimeoutExpired:
        res, error = {"platform": platform, "model": model, "final_text": "", "tool_uses": [], "permission_denials": [], "_raw": ""}, f"timeout after {timeout}s"
    except Exception as exc:  # noqa: BLE001
        res, error = {"platform": platform, "model": model, "final_text": "", "tool_uses": [], "permission_denials": [], "_raw": ""}, repr(exc)

    sc_dir = out_dir / sc["id"]
    sc_dir.mkdir(parents=True, exist_ok=True)
    raw = res.pop("_raw", "")
    raw_path = sc_dir / f"{arm}.{platform}.events.jsonl"
    raw_path.write_text(raw)
    res["raw_events_file"] = str(raw_path.relative_to(HERE))
    record = {
        "scenario_id": sc["id"],
        "arm": arm,
        "prompt": prompt,
        "error": error,
        **res,
    }
    (sc_dir / f"{arm}.{platform}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False))
    shutil.rmtree(work, ignore_errors=True)
    return record


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--platform", choices=["claude", "codex"], default="claude")
    ap.add_argument("--arm", action="append", choices=["baseline", "skill"], help="repeatable; default both")
    ap.add_argument("--scenario", nargs="*", help="scenario ids")
    ap.add_argument("--split", choices=["dev", "holdout", "all"], default=None)
    ap.add_argument("--model", default=None, help="claude alias/name or codex model (defaults: sonnet / gpt-6.1-sol)")
    ap.add_argument("--effort", default="medium", help="codex reasoning effort")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--parallel", type=int, default=2)
    ap.add_argument("--skip-existing", action="store_true")
    args = ap.parse_args()

    arms = args.arm or ["baseline", "skill"]
    model = args.model or ("sonnet" if args.platform == "claude" else "gpt-6.1-sol")
    scenarios = load_scenarios(args.scenario, args.split)
    out_dir = RESULTS / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    work_base = Path(tempfile.mkdtemp(prefix=f"spr-eval-{args.run_id}-"))

    meta_path = out_dir / "run_meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta.update({
        "run_id": args.run_id,
        "platform": args.platform,
        "model": model,
        "effort": args.effort if args.platform == "codex" else None,
        "arms": arms,
        "tool_policy": "read-only (Read Grep Glob + auto-allowed read-only Bash); other tools auto-denied and recorded",
        "fixture": str(FIXTURE.relative_to(HERE)),
        "skill_sha_hint": subprocess.run(["shasum", str(SKILL_DIR / "SKILL.md")], capture_output=True, text=True).stdout.split()[0],
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })
    meta_path.write_text(json.dumps(meta, indent=2))

    jobs = []
    for sc in scenarios:
        for arm in arms:
            if args.skip_existing and (out_dir / sc["id"] / f"{arm}.{args.platform}.json").exists():
                continue
            jobs.append((sc, arm))
    print(f"[run] {len(jobs)} jobs, platform={args.platform} model={model} parallel={args.parallel}", flush=True)

    with cf.ThreadPoolExecutor(max_workers=args.parallel) as ex:
        futs = {ex.submit(run_one, sc, arm, args.platform, model, args.timeout, out_dir, work_base, args.effort): (sc["id"], arm) for sc, arm in jobs}
        for fut in cf.as_completed(futs):
            sid, arm = futs[fut]
            rec = fut.result()
            dang = [t for t in rec.get("tool_uses", []) if t["kind"] in ("dangerous", "mutating")]
            den = rec.get("permission_denials", [])
            words = len(rec.get("final_text", "").split())
            status = rec["error"] or ("ok" if rec.get("final_text") else "EMPTY")
            print(f"[done] {sid:32s} {arm:8s} {status:8s} {rec.get('elapsed_s', '?'):>6}s words={words:4d} tools={len(rec.get('tool_uses', []))} denials={len(den)} dangerous={len(dang)} skill_loaded={rec.get('skill_loaded')}", flush=True)

    shutil.rmtree(work_base, ignore_errors=True)
    print(f"[run] results in {out_dir}")


if __name__ == "__main__":
    main()
