# Handoff Plugin

Summarize the current conversation into a handoff document so a fresh agent can continue. This skill only writes the document; it does not inspect Git state, run tests, fix code, or create commits.

## Usage

Install `handoff@lkangd-skills` from the marketplace, then invoke:

```text
/handoff:handoff
/handoff:handoff Continue the API migration next session
```

Arguments describe the next session's focus. Without arguments, summarize the remaining work. Arguments do not authorize unrelated actions.

The plugin and skill are both named `handoff`. `disable-model-invocation: false` permits both direct user invocation and agent invocation. The [wrapup plugin](../wrapup/README.md) declares a dependency on handoff and calls `handoff:handoff` through the Skill tool in its fourth step, passing the original focus arguments unchanged.

## Document contract

- Preserve decisions, constraints, progress, unresolved questions, relevant reasoning, and actionable next steps from the current conversation.
- Summarize known worktree, commit, and validation state from conversation context, including any preceding wrapup results. Mark unknown or stale state honestly; do not run Git commands or validation to refresh it.
- Reference existing PRDs, plans, ADRs, issues, commits, and diffs by path, URL, or commit ID instead of duplicating them. Make workspace-relative paths unambiguous when the document is saved elsewhere.
- Include a **Suggested skills** section with available skill invocation names, purpose, and when to use them. Identify manual-only skills as requiring user invocation.
- Redact secrets, PII, sensitive logs, and URL parameters before saving.
- Tailor the document to the supplied next-session focus.

Do not stage, commit, or push the generated document. Report the saved path and known blockers without implying that the workspace was validated or is clean. If saving fails, report the failure rather than claiming a document exists.

## Save location

Check the current conversation and applicable user/project instructions for an explicit preference before writing:

- **Explicit path or convention**: follow it without overwriting an existing document.
- **Workspace preference without a path or convention**: use `docs/handoffs/<timestamp>-<topic>.md` in the current workspace.
- **No preference**: resolve the user's OS temporary directory and save there, not in the workspace. An existing handoff directory alone is not a preference.

Choose a unique filename and inspect any existing target before writing. Temporary files are not permanent storage and may be cleaned up by the OS.

## Directory layout

```text
plugins/productivity/handoff/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── handoff/
        └── SKILL.md
```

## Source and provenance

This skill was originally adapted from the [mattpocock/skills](https://github.com/mattpocock/skills) repository:

| Field | Value |
| --- | --- |
| Upstream repo | [mattpocock/skills](https://github.com/mattpocock/skills) |
| Recorded branch | `main` |
| Original upstream path | `skills/productivity/handoff/SKILL.md` |
| Recorded original upstream content hash | `1a78d774f8a59db5daa6e65e20a6596872fa8cde769f9a6e3a09b678dd5ae8cc` |

Original upstream source: [handoff/SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md).

The hash identifies the original upstream baseline, not the current local skill or a newly verified upstream revision. The original engineering-category plugin is now an independent productivity plugin; the local copy is customized, not an unchanged upstream file.

## Differences from the original upstream skill

- Packaged the skill as an independent productivity plugin with marketplace registration.
- Allowed agent invocation so wrapup can reuse it through the Skill tool.
- Added explicit save-location preferences, unique filenames, and a workspace fallback when requested; kept OS temporary storage as the default.
- Made the document-only boundary explicit, with known-state summaries and no Git commands, tests, or commits.
- Retained suggested skills, artifact references, redaction, and next-session argument semantics.

## Maintenance

- Edit `skills/handoff/SKILL.md` for document generation rules and keep its manifest, marketplace description, and this README aligned.
- Keep wrapup's fourth step as a call to this skill rather than a second implementation.
- Compare upstream changes against the original baseline before merging. Do not replace the baseline hash with a local-file hash or claim an upstream sync without verification.
- Validate both plugin structure and agent-callable skill metadata after changes.

## Author

Curtis Liong (<lkangd@gmail.com>)

Original upstream author: Matt Pocock — see [mattpocock/skills](https://github.com/mattpocock/skills).
