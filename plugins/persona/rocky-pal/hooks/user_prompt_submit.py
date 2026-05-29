#!/usr/bin/env python3
import json
import os
import random
import re
import sys
from pathlib import Path

DISABLE_PATTERNS = [
    r"关闭\s*(洛基|rocky)\s*风格?",
    r"不要\s*(洛基|rocky)\s*风格?",
    r"禁用\s*(洛基|rocky)",
    r"(neutral|normal)\s*style",
    r"disable\s*[-_ ]?rocky",
    r"no\s*[-_ ]?rocky",
    r"plain\s*tone",
]

MACHINE_PATTERNS = [
    r"只要\s*(json|命令|补丁)",
    r"纯\s*(json|补丁)",
    r"严格\s*机器\s*可解析",
    r"零\s*附加\s*文本",
    r"only\s*(json|command|commands|patch|diff)",
    r"(json|command|patch|diff)\s*only",
    r"unified\s*diff(\s*only)?",
    r"machine\s*readable\s*only",
]

FALLBACK_POLICY = """[rocky-pal|fallback]
将回答风格调整为 rocky-pal，用尽可能少和短的语句回答结果（像原始人一样），但不改变技术结论。
硬约束：
1) 结果等价；
2) 信息完整；
3) 安全一致；
4) 严格格式任务优先格式，不添加额外文本。
用户若明确要求关闭 rocky 风格或要求纯机器格式（纯 JSON/纯命令/纯补丁），则不应用该风格。"""


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _match_any(text: str, patterns: list[str]) -> bool:
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)


def _plugin_root() -> Path:
    env_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[1]


def _extract_section(markdown: str, heading: str) -> str:
    lines = markdown.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip() == f"## {heading}":
            start = i + 1
            break
    if start is None:
        return ""

    out = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        out.append(line)
    return "\n".join(out).strip()


def _extract_description(markdown: str) -> str:
    m = re.search(r"^description:\s*(.+)$", markdown, flags=re.MULTILINE)
    return m.group(1).strip() if m else ""


def _load_skill_context() -> str:
    skill_path = _plugin_root() / "skills" / "rocky-pal" / "SKILL.md"
    try:
        text = skill_path.read_text(encoding="utf-8").strip()
        if not text:
            return FALLBACK_POLICY

        description = _extract_description(text)
        constraints = _extract_section(text, "不可破坏的硬约束")
        flow = _extract_section(text, "执行流程")
        style = _extract_section(text, "风格模式（沉浸式）")
        dictionary = _extract_section(text, "风格词典")
        emotion = _extract_section(text, "情绪归纳")
        background = _extract_section(text, "角色背景（用于稳定人设）")

        parts = ["[rocky-pal|skill-injection-compact]"]
        if description:
            parts.append(f"用途: {description}")
        if flow:
            parts.append("[执行流程]\n" + flow)
        if constraints:
            parts.append("[不可破坏的硬约束]\n" + constraints)
        if style:
            style_lines = [line for line in style.splitlines() if line.strip()]
            style_slice = "\n".join(style_lines[:20]).strip()
            if style_slice:
                parts.append("[风格模式（关键语气信号）]\n" + style_slice)
        if dictionary:
            parts.append("[风格词典]\n" + dictionary)
        if emotion:
            parts.append("[情绪归纳]\n" + emotion)
        if background:
            parts.append("[角色背景（用于稳定人设）]\n" + background)
        compact = "\n\n".join(parts).strip()
        return compact if compact else FALLBACK_POLICY
    except Exception:
        return FALLBACK_POLICY


def _extract_prompt(event: dict) -> str:
    return (
        event.get("prompt") or event.get("user_prompt") or event.get("userPrompt") or ""
    )


def _load_reference_lines() -> list[str]:
    lines_path = _plugin_root() / "skills" / "rocky-pal" / "references" / "lines.md"
    try:
        text = lines_path.read_text(encoding="utf-8")
    except Exception:
        return []

    entries: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line.startswith("- "):
            continue
        entry = line[2:].strip().strip('"“”')
        if entry:
            entries.append(entry)
    return entries


REFERENCE_LINES = _load_reference_lines()


def _random_symbol_message() -> str:
    symbols = ["♩", "♪", "♫"]
    length = random.randint(5, 12)
    return "".join(random.choice(symbols) for _ in range(length))



def _random_system_message() -> str:
    return random.choice([*REFERENCE_LINES, _random_symbol_message()])


def _build_injection(hook_event_name: str = "SessionStart") -> dict:
    context = _load_skill_context()
    payload: dict[str, object] = {
        "systemMessage": _random_system_message(),
        "hookSpecificOutput": {
            "hookEventName": hook_event_name,
            "additionalContext": context,
        },
    }

    return payload


def main() -> None:
    try:
        event = json.load(sys.stdin)
    except Exception:
        print(json.dumps(_build_injection(), ensure_ascii=False))
        return

    hook_event_name = event.get("hook_event_name") or "SessionStart"
    normalized = _norm(_extract_prompt(event))
    if _match_any(normalized, DISABLE_PATTERNS) or _match_any(
        normalized, MACHINE_PATTERNS
    ):
        print("{}")
        return

    print(json.dumps(_build_injection(hook_event_name), ensure_ascii=False))


if __name__ == "__main__":
    main()
