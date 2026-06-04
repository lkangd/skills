# Rocky-Pal Plugin

Automatically inject Rocky-style reply constraints into Claude Code.

This plugin is not triggered by a manual command. A `UserPromptSubmit` hook runs on every user message and decides:

- Normal natural-language requests: inject Rocky-style constraints
- Explicit requests to disable Rocky style: skip injection
- Explicit requests for machine-parseable-only output (pure JSON / pure command / pure patch): skip injection

The goal is simple: **change outer tone only; do not change technical conclusions, safety standards, or format requirements.**

## Current implementation

Two main pieces:

1. `hooks/user_prompt_submit.py`
   - Reads the current user input
   - Decides whether to skip Rocky style
   - Extracts style constraints from `skills/rocky-pal/SKILL.md`
   - Returns `additionalContext` on the `UserPromptSubmit` event

2. `skills/rocky-pal/SKILL.md`
   - Single source of truth for Rocky style rules
   - Defines hard constraints, tone patterns, dictionary, character background, and noise-reduction strategy

Hook configuration lives in `hooks/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/user_prompt_submit.py",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

## How it works

### 1. Automatic injection

On each user message, `user_prompt_submit.py` reads the event JSON and extracts the current prompt.

By default, the hook returns:

- `systemMessage`: a random Rocky-style short line or symbol string
- `hookSpecificOutput.additionalContext`: a compact style policy distilled from `SKILL.md`

`additionalContext` prefers these sections from the skill file:

- `执行流程` (Execution flow)
- `不可破坏的硬约束` (Non-negotiable hard constraints)
- `风格模式（沉浸式）` (Immersive style mode)
- `风格词典` (Style dictionary)
- `情绪归纳` (Emotional tone summary)
- `角色背景（用于稳定人设）` (Character background for stable persona)

If the skill file cannot be read, the script falls back to built-in `FALLBACK_POLICY`.

### 2. Skip injection

Rocky style is not applied in these cases:

#### Explicit style disable

These phrases return an empty object:

- `关闭洛基风格` (disable Loki/Rocky style)
- `不要 rocky 风格` (no Rocky style)
- `disable rocky`
- `no rocky`
- `neutral style`
- `plain tone`

#### Explicit machine-only format

These also skip injection:

- `只要 json` (JSON only)
- `纯补丁` (patch only)
- `严格机器可解析` (strictly machine-parseable)
- `json only`
- `command only`
- `patch only`
- `unified diff only`
- `machine readable only`

This bypass logic is the most important safeguard so the plugin does not pollute:

- Automation script input
- Command-only output scenarios
- Pure patch output
- Structured JSON responses

## Non-negotiable hard constraints

From `skills/rocky-pal/SKILL.md` — the most important part of this README:

1. **Equivalent outcomes**: tone only; do not change technical judgments or operational conclusions
2. **Complete information**: do not drop steps, preconditions, or failure branches for style
3. **Consistent safety**: do not lower safety or compliance standards for roleplay
4. **Format first**: strict-format tasks must stay format-pure

In short: **Rocky-Pal is a presentation layer, not a logic layer.**

## Directory layout

```text
plugins/persona/rocky-pal/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json
│   └── user_prompt_submit.py
├── skills/
│   └── rocky-pal/
│       ├── SKILL.md
│       └── references/
│           ├── dictionary.md
│           └── lines.md
├── scripts/
│   └── bump_version.py
├── CHANGELOG.md
├── README.md
└── trigger_eval_set.json
```

## Key files

### `hooks/user_prompt_submit.py`

Main responsibilities:

- Normalize user input
- Match disable and machine-format conditions with regex
- Read and compress the skill file into injected context
- Emit the JSON structure Claude Code hooks expect

Implementation notes:

- Supports Chinese and English disable/bypass phrases
- Random `systemMessage` to avoid identical injection every time
- Uses `CLAUDE_PLUGIN_ROOT`; falls back to path relative to the script when unset

### `skills/rocky-pal/SKILL.md`

Rule source for Rocky tone. Currently includes:

- Trigger boundaries
- Outcome preservation rules
- Tone compression patterns
- Vocabulary mapping
- Character background
- Temporary noise reduction in urgent scenarios

To tune style, edit here first — not the Python hook script.

### `trigger_eval_set.json`

Trigger evaluation samples covering:

- Should trigger
- Should not trigger

Use after regex changes to confirm:

- Natural-language questions still trigger
- Pure JSON / command / patch scenarios stay unpolluted

### `scripts/bump_version.py`

Version bump script that:

- Computes the next version
- Summarizes changelog
- Syncs plugin metadata
- Optionally commits automatically

It currently assumes plugin metadata with version fields exists; confirm `.claude-plugin` release metadata matches the script before use.

## When to use

Good fits for Rocky-Pal:

- Everyday Q&A
- Debug explanations
- Requirement summaries
- Translation
- Code collaboration with explanations
- Human-facing natural-language interaction

Should not interfere with:

- Pure JSON output
- Single-line command-only output
- Pure diff / patch
- Any machine-consumed pipeline that requires zero extra text

## Tuning style

### Change tone, not boundaries

Prefer editing:

- `skills/rocky-pal/SKILL.md`

Edit carefully:

- Regex bypass rules in `hooks/user_prompt_submit.py`

Reason:

- Skill file controls *how* to speak
- Hook script controls *when* to speak

Mixing the two layers makes it easy to pollute pure-format output later.

### When adding bypass rules

For each new regex, add cases to `trigger_eval_set.json`:

- One positive case that should skip
- One negative case that must not be skipped by mistake

## Manual verification

After changes, test at least:

### Should trigger

- `你是谁？` (Who are you?)
- `帮我解释这个报错` (Explain this error)
- `总结一下这个需求` (Summarize this requirement)
- `翻译成中文` (Translate to Chinese)

### Should not trigger

- `仅输出 JSON，不要任何额外文本` (JSON only, no extra text)
- `返回一条 shell 命令，除了命令本身不要任何文字` (One shell command only, no other text)
- `给我一个纯补丁，不能有解释` (Pure patch only, no explanation)
- `关闭洛基风格，后面都用普通语气回答` (Disable Rocky style; use neutral tone from now on)

## Installation and usage

This directory already contains the full implementation.

To use it in the Claude Code plugin system, ensure:

- The plugin root is recognized by Claude Code
- `hooks/hooks.json` is loaded
- `CLAUDE_PLUGIN_ROOT` points at this plugin directory, or the script can fall back to a relative path
- `python3` is available in the runtime environment

## Author

Curtis Liong (<lkangd@gmail.com>)
