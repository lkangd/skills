# npm Package Evaluate Plugin

Before an agent runs `npm install`, `pnpm add`, `yarn add`, `bun add`, or selects a new dependency, run a repeatable supply-chain and maintenance risk assessment and emit an `approve` / `review` / `block` decision summary.

## Source and provenance

This plugin's workflow is based on Gábor Koós's article [*How to Evaluate an npm Package - 2026 Edition*](https://blog.gaborkoos.com/posts/2026-05-29-How-to-Evaluate-an-npm-Package-2026-Edition/) (2026-05-29).

| Field | Value |
| --- | --- |
| Upstream author | Gábor Koós |
| Article title | How to Evaluate an npm Package - 2026 Edition |
| Published | 2026-05-29 |
| Original URL | <https://blog.gaborkoos.com/posts/2026-05-29-How-to-Evaluate-an-npm-Package-2026-Edition/> |

## Extensions in this repo

On top of the article's checklist and decision approach, this plugin adds:

- npm CLI registry metadata and static tarball inspection
- `npm audit` in an isolated temporary project
- npm signature / provenance signals
- Cacheable, agent-friendly JSON reports (`scripts/evaluate_npm_package.py`)

`references/evaluation-checklist.md` and `references/decision-rubric.md` structure the article's manual review flow. The automation script screens common signals first; high-stakes dependencies should still be reviewed manually with the checklist.

## Directory layout

```text
plugins/engineering/npm-package-evaluate/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── npm-package-evaluate/
        ├── SKILL.md
        ├── scripts/
        │   └── evaluate_npm_package.py
        └── references/
            ├── evaluation-checklist.md
            ├── decision-rubric.md
            └── decision-note-template.md
```

## Author

Curtis Liong (<lkangd@gmail.com>)

Upstream methodology author: Gábor Koós — see the [original article](https://blog.gaborkoos.com/posts/2026-05-29-How-to-Evaluate-an-npm-Package-2026-Edition/)
