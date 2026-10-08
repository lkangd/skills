# Wrapup Plugin

Finish a session with current-worktree checks, full test gates, scoped commits, and a call to the independent handoff skill.

## Usage and dependency

Install `wrapup@lkangd-skills` from the marketplace, then invoke:

```text
/wrapup:wrapup
/wrapup:wrapup Continue with the remaining validation blockers next session
```

The plugin and skill are both named `wrapup`. `disable-model-invocation: true` restricts the skill to explicit user invocation; it does not run automatically.

The plugin declares `"dependencies": ["handoff"]` in its manifest. Claude Code resolves the dependency from the same marketplace and installs and enables it with wrapup. The handoff skill permits agent invocation so wrapup can call it through the Skill tool.

Arguments describe the next session's focus and are passed unchanged to `handoff:handoff`. They do not expand authorization for fixes or commits.

For a document without checks or commits, invoke the independent skill directly:

```text
/handoff:handoff
/handoff:handoff Continue the API migration next session
```

See the [handoff plugin](../handoff/README.md) for document content, save-location preferences, and standalone usage.

## Workflow and boundaries

1. **Inspect the current worktree** — include all staged, unstaged, and untracked work, not just the current issue. Do not inspect other branches or worktrees. List unrelated changes and ask before fixing or committing them unless already authorized.
2. **Run full test gates** — discover the project's applicable tests, lint, type checks, and builds. Fix authorized failures and rerun the gates. Report unavailable or absent checks honestly. Do not weaken checks to obtain a passing result.
3. **Commit in clean, scoped units** — review each commit's diff and stage only its intended changes. Preserve excluded work, including staged changes. Do not amend, bypass hooks, or push automatically.
4. **Invoke `handoff:handoff`** — call the Skill tool in the current conversation with the original next-session focus arguments. The handoff skill owns all document generation and save-location rules; wrapup does not maintain a duplicate implementation.

Verify that the handoff skill is available before starting. If unavailable, stop and report the missing dependency before fixes or commits. If the skill call or document generation later fails, report completed work and the blocker without inventing a replacement or claiming a document was saved.

If a gate cannot be safely resolved, leave the failed scope uncommitted and still invoke handoff with the failure, blocker, and next steps in the conversation. Independently passing scopes may be committed only after their relevant gates are verified, with validation dependencies included in that commit or already committed. If validation relies on excluded or omitted changes, leave the scope uncommitted and record the blocker without disturbing excluded work or using another branch or worktree. Outside a Git repository, report that Git status and commits are unavailable and continue with applicable checks and the handoff.

After handoff completes, report its saved path, commit outcomes, validation results, blockers, and final Git status. Excluded changes or a workspace handoff can leave the worktree dirty.

## Directory layout

```text
plugins/productivity/wrapup/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── wrapup/
        └── SKILL.md
```

The dependency lives separately at `plugins/productivity/handoff/`.

## Source and maintenance

The workflow originally grew from the vendored mattpocock handoff skill. Document generation now lives in the independent handoff plugin; see its [source and provenance](../handoff/README.md#source-and-provenance) for the original upstream path and recorded baseline hash.

- Edit `skills/wrapup/SKILL.md` for worktree inventory, validation, commit behavior, or handoff invocation.
- Edit the handoff skill for document generation rules; do not copy those rules into wrapup.
- Keep the dependency manifest, marketplace registration, descriptions, and this README aligned.
- Validate both plugins and the marketplace after changes.

For local development, load both plugins together:

```sh
claude --plugin-dir ./plugins/productivity/wrapup --plugin-dir ./plugins/productivity/handoff
```

## Author

Curtis Liong (<lkangd@gmail.com>)
