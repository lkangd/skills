#!/usr/bin/env python3
import argparse
import json
import sys
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Normalize Himalaya envelope JSON into a compact table or JSON summary."
    )
    parser.add_argument(
        "--format",
        choices=("table", "json"),
        default="table",
        help="Output format.",
    )
    return parser.parse_args()


def load_input() -> list[dict[str, Any]]:
    raw = sys.stdin.read().strip()
    if not raw:
        return []
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("expected a JSON array of envelopes")
    return data


def render_flags(flags: Any) -> str:
    if not isinstance(flags, list) or not flags:
        return "none"
    return ",".join(str(flag) for flag in flags)


def render_att(value: Any) -> str:
    return "yes" if bool(value) else "no"


def render_from(sender: Any) -> str:
    if not isinstance(sender, dict):
        return ""
    name = str(sender.get("name") or "").strip()
    addr = str(sender.get("addr") or "").strip()
    if name and addr:
        return f"{name} <{addr}>"
    return name or addr


def normalize(envelopes: list[dict[str, Any]]) -> list[dict[str, str]]:
    rows = []
    for item in envelopes:
        rows.append(
            {
                "id": str(item.get("id") or ""),
                "date": str(item.get("date") or ""),
                "from": render_from(item.get("from")),
                "subject": str(item.get("subject") or ""),
                "flags": render_flags(item.get("flags")),
                "att": render_att(item.get("has_attachment")),
            }
        )
    return rows


def to_table(rows: list[dict[str, str]]) -> str:
    headers = ["ID", "Date", "From", "Subject", "Flags", "Att"]
    keys = ["id", "date", "from", "subject", "flags", "att"]
    values = [headers]
    for row in rows:
        values.append([row[key] for key in keys])
    widths = [max(len(str(line[i])) for line in values) for i in range(len(headers))]

    def fmt(line: list[str]) -> str:
        return " | ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(line))

    out = [fmt(headers), "-+-".join("-" * width for width in widths)]
    for row in rows:
        out.append(fmt([row[key] for key in keys]))
    return "\n".join(out)


def main() -> int:
    args = parse_args()
    envelopes = load_input()
    rows = normalize(envelopes)
    if args.format == "json":
        sys.stdout.write(json.dumps(rows, ensure_ascii=False, indent=2))
        sys.stdout.write("\n")
        return 0
    sys.stdout.write(to_table(rows))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
