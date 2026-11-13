# Wrapup Plugin

Finish a session with current-worktree checks, full test gates, scoped commits, and a call to the independent handoff skill.

## Usage and dependency

In a Claude Code session, add the marketplace and install wrapup.

```text
/plugin marketplace add lkangd/skills
/plugin install wrapup@lkangd-skills
```

Claude Code also installs and enables `handoff` from the same marketplace.

In Codex, install both plugins.

```sh
codex plugin marketplace add lkangd/skills
codex plugin add handoff@lkangd-skills
codex plugin add wrapup@lkangd-skills
```

In Pi, run `pi install git:github.com/lkangd/skills`. The repository package provides both skills. If a personal or project skill also uses the name `handoff`, ensure Pi discovers the package's copy before running wrapup.

Start a fresh session in the target workspace and explicitly invoke wrapup.

| Host | Invocation with an example focus |
| --- | --- |
| Claude Code | `/wrapup:wrapup Continue with the remaining validation blockers` |
| Codex | `$wrapup:wrapup Continue with the remaining validation blockers` |
| Pi | `/skill:wrapup Continue with the remaining validation blockers` |

Wrapup is explicit-only on all three hosts. Optional arguments pass unchanged to handoff as the next session's focus. The scope of fixes and commits comes from the user's authorization in the conversation.

See the [handoff plugin](../handoff/README.md) for standalone invocation, document content, and save-location preferences.

## Workflow and boundaries

1. **Inspect the current worktree** — include all staged, unstaged, and untracked work, not just the current issue. Do not inspect other branches or worktrees. List unrelated changes and ask before fixing or committing them unless already authorized.
2. **Run full test gates** — discover the project's applicable tests, lint, type checks, and builds. Fix authorized failures and rerun the gates. Report unavailable or absent checks honestly. Do not weaken checks to obtain a passing result.
3. **Commit in clean, scoped units** — review each commit's diff and stage only its intended changes. Preserve excluded work, including staged changes. Do not amend, bypass hooks, or push automatically.
4. **Run handoff in the current conversation** — Claude Code calls the Skill tool. Codex and Pi read the installed handoff skill from its discovered path and apply it in the same session. Handoff supplies all document generation and save-location rules.

Verify that the handoff skill is available before starting. If unavailable, stop and report the missing dependency before fixes or commits. If the skill call or document generation later fails, report completed work and the blocker without inventing a replacement or claiming a document was saved.

If a gate cannot be safely resolved, leave the failed scope uncommitted and still invoke handoff with the failure, blocker, and next steps in the conversation. Independently passing scopes may be committed only after their relevant gates are verified, with validation dependencies included in that commit or already committed. If validation relies on excluded or omitted changes, leave the scope uncommitted and record the blocker without disturbing excluded work or using another branch or worktree. Outside a Git repository, report that Git status and commits are unavailable and continue with applicable checks and the handoff.

After handoff completes, report its saved path, commit outcomes, validation results, blockers, and final Git status. Excluded changes or a workspace handoff can leave the worktree dirty.

## Directory layout

```text
plugins/productivity/wrapup/
├── .claude-plugin/
│   └── plugin.json
├── plugin.json
├── README.md
└── skills/
    └── wrapup/
        ├── SKILL.md
        └── agents/
            └── openai.yaml
```

The dependency lives separately at `plugins/productivity/handoff/`.

## Source and maintenance

The workflow originally grew from the vendored mattpocock handoff skill. Document generation now lives in the independent handoff plugin; see its [source and provenance](../handoff/README.md#source-and-provenance) for the original upstream path and recorded baseline hash.

- Edit `skills/wrapup/SKILL.md` for worktree inventory, validation, commit behavior, or handoff invocation.
- Edit the handoff skill for document generation rules; do not copy those rules into wrapup.
- Keep the Claude dependency, portable manifest, marketplace registration, Pi resource paths, and this README aligned.
- Validate both plugins and the marketplace after changes.

For local development, load both plugins together:

```sh
claude --plugin-dir ./plugins/productivity/wrapup --plugin-dir ./plugins/productivity/handoff
```

## Author

Curtis Liong (<lkangd@gmail.com>)
