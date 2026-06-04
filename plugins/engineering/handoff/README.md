# Handoff Plugin

Compress the current conversation into a handoff document so a new agent in the next session can pick up where you left off.

## Source and provenance

This skill comes from the [mattpocock/skills](https://github.com/mattpocock/skills) repository:

| Field | Value |
| --- | --- |
| Upstream repo | [mattpocock/skills](https://github.com/mattpocock/skills) |
| Branch | `main` |
| Upstream path | `skills/productivity/handoff/SKILL.md` |
| Content hash | `1a78d774f8a59db5daa6e65e20a6596872fa8cde769f9a6e3a09b678dd5ae8cc` |

Upstream source file: [handoff/SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md)

## Why it lives in this repo

The upstream skill is distributed as a standalone skill. This repo vendors it as `plugins/engineering/handoff` to:

1. **Fit our workflow** — install, enable, and manage it alongside other engineering plugins in the lkangd-skills marketplace.
2. **Make tuning easier** — adjust handoff document structure, required fields, or suggested-skills strategy in `skills/handoff/SKILL.md` without waiting on upstream releases.
3. **Stay traceable** — upstream path and content hash in this README make it easy to compare with the original and decide when to sync.

When upstream changes, compare the path and hash above before merging into the local copy.

## Plugin goals

Handoff is not a replacement for PRDs, plans, ADRs, or issues. It is a **context bridge between sessions**:

- Summarize decisions, progress, and open questions from the current conversation
- Point to existing artifacts (paths or URLs) instead of copying them again
- Suggest skills the next agent should invoke
- Redact sensitive data such as API keys, passwords, and PII
- Write the handoff document to the **user OS temp directory**, not the current workspace

If the user passes an argument (`argument-hint: "What will the next session be used for?"`), treat it as the focus of the next session and adjust the document accordingly.

## Directory layout

```text
plugins/engineering/handoff/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── handoff/
        └── SKILL.md
```

## Differences from upstream

The current vendored copy matches upstream `1a78d774…` in content; only plugin packaging was added:

- Added `# Handoff` heading to match other skills in this repo
- Added `.claude-plugin/plugin.json` and marketplace registration
- Added this README for source and maintenance notes

Core behavior (save location, suggested skills, artifact references, redaction, argument semantics) is unchanged.

## Maintenance

- **Tune handoff behavior**: edit `skills/handoff/SKILL.md` first
- **Sync upstream**: compare with [upstream SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md), merge, then update the content hash in this README
- **Do not** write handoff documents into the workspace by default unless you intentionally change skill behavior

## Author

Curtis Liong (<lkangd@gmail.com>)

Upstream author: Matt Pocock — see [mattpocock/skills](https://github.com/mattpocock/skills)
