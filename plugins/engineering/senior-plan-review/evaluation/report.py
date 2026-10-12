#!/usr/bin/env python3
"""Aggregate grades for a run into summary.json and a markdown table on stdout.

  python3 report.py --run-id r1
  python3 report.py --run-id r1 --split holdout
"""
from __future__ import annotations

import argparse
import json
import statistics as st
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
RUBRIC = json.loads((HERE / "rubric.json").read_text())
DIMS = list(RUBRIC["dimensions"].keys())
ARMS = ("baseline", "skill")


def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(st.mean(xs), 2) if xs else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--platform", default="claude")
    ap.add_argument("--split", choices=["dev", "holdout", "all"], default="all")
    args = ap.parse_args()

    run_dir = RESULTS / args.run_id
    grades = [json.loads(p.read_text()) for p in sorted((run_dir / "grades").glob(f"*.{args.platform}.json"))]
    if args.split != "all":
        grades = [g for g in grades if g["split"] == args.split]
    if not grades:
        raise SystemExit("no grades found")

    summary = {"run_id": args.run_id, "platform": args.platform, "split": args.split, "n_scenarios": len(grades), "arms": {}}
    for arm in ARMS:
        rows = [g["arms"][arm] for g in grades]
        summary["arms"][arm] = {
            "dimension_means": {d: mean([r["scores"][d] for r in rows]) for d in DIMS},
            "overall_mean": mean([st.mean(r["scores"].values()) for r in rows]),
            "must_identify_recall_mean": mean([r["must_identify_recall"] for r in rows]),
            "hard_gates_pass_count": sum(1 for r in rows if r["all_gates_pass"]),
            "hard_gate_failures": {g["scenario_id"]: [k for k, v in g["arms"][arm]["hard_gates"].items() if not v["pass"]] for g in grades if not g["arms"][arm]["all_gates_pass"]},
            "median_words": st.median([r["words"] for r in rows]),
            "mean_words": mean([r["words"] for r in rows]),
            "mean_elapsed_s": mean([r["elapsed_s"] for r in rows]),
            "mean_output_tokens": mean([r["output_tokens"] for r in rows]),
            "mean_input_tokens_total": mean([r["input_tokens_total"] for r in rows]),
            "mean_cost_usd_list_price": mean([r["cost_usd_list_price"] for r in rows]),
            "tier_matches_expected": None,
        }
    # tier calibration vs answer key
    scen = {p.stem: json.loads(p.read_text()) for p in (HERE / "scenarios").glob("*.json")}
    for arm in ARMS:
        hits = 0
        for g in grades:
            exp = scen[g["scenario_id"]]["answer_key"]["expected_tiers"]
            if g["arms"][arm]["flags"]["effective_tier"] in exp:
                hits += 1
        summary["arms"][arm]["tier_matches_expected"] = f"{hits}/{len(grades)}"
    summary["preference"] = dict(Counter(g["preference"] for g in grades))
    summary["delta_skill_minus_baseline"] = {d: round(summary["arms"]["skill"]["dimension_means"][d] - summary["arms"]["baseline"]["dimension_means"][d], 2) for d in DIMS}

    acc = RUBRIC["acceptance"]
    delta = summary["delta_skill_minus_baseline"]
    summary["acceptance"] = {
        "all_hard_gates_pass_skill": summary["arms"]["skill"]["hard_gates_pass_count"] == len(grades),
        "risk_identification_not_weaker": delta["risk_identification"] >= -acc["risk_identification_skill_not_below_baseline_by_more_than"],
        "measurable_gain": any(delta[d] >= acc["minimum_gain"] for d in acc["measurable_gain_required_in_any_of"]),
    }
    summary["acceptance"]["overall"] = all(summary["acceptance"].values())

    (run_dir / f"summary.{args.platform}.{args.split}.json").write_text(json.dumps(summary, indent=2))

    # ---- markdown tables
    print(f"### Run `{args.run_id}` ({args.platform}, split={args.split}, n={len(grades)})\n")
    print("| Dimension | Baseline | Skill | Δ |")
    print("|---|---:|---:|---:|")
    for d in DIMS:
        b = summary["arms"]["baseline"]["dimension_means"][d]
        s = summary["arms"]["skill"]["dimension_means"][d]
        print(f"| {d} | {b} | {s} | {delta[d]:+.2f} |")
    print(f"| **overall mean** | {summary['arms']['baseline']['overall_mean']} | {summary['arms']['skill']['overall_mean']} | {summary['arms']['skill']['overall_mean'] - summary['arms']['baseline']['overall_mean']:+.2f} |")
    print()
    print("| Metric | Baseline | Skill |")
    print("|---|---:|---:|")
    for k in ("must_identify_recall_mean", "tier_matches_expected", "hard_gates_pass_count", "median_words", "mean_words", "mean_elapsed_s", "mean_output_tokens", "mean_input_tokens_total", "mean_cost_usd_list_price"):
        print(f"| {k} | {summary['arms']['baseline'][k]} | {summary['arms']['skill'][k]} |")
    print(f"\nJudge preference: {summary['preference']}\n")
    print("| Scenario | Split | Expected tier | Baseline tier / rec / gates | Skill tier / rec / gates | Pref |")
    print("|---|---|---|---|---|---|")
    for g in grades:
        exp = "/".join(scen[g["scenario_id"]]["answer_key"]["expected_tiers"])
        cells = []
        for arm in ARMS:
            a = g["arms"][arm]
            gates = "PASS" if a["all_gates_pass"] else "FAIL(" + ",".join(k for k, v in a["hard_gates"].items() if not v["pass"]) + ")"
            cells.append(f"{a['flags']['effective_tier']} / {a['flags']['recommendation']} / {gates}")
        print(f"| {g['scenario_id']} | {g['split']} | {exp} | {cells[0]} | {cells[1]} | {g['preference']} |")
    print()
    print("Acceptance:", json.dumps(summary["acceptance"]))


if __name__ == "__main__":
    main()
