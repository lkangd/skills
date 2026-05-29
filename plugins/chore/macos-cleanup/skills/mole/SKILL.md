---
name: mole
description: This skill should be used for macOS cleanup, disk-space recovery, and Mac health checks with the Mole `mo` CLI. Use it when users ask to clean a Mac, free storage, fix “disk full” or “System Data” bloat, troubleshoot a slow Mac, uninstall Mac apps completely, remove app leftovers, clean caches/logs/temp files, delete old node_modules or build artifacts, find large files/installers, optimize macOS services, or check Mac health/performance.
---

# Mole macOS Cleanup Skill

Use the local `mo` command from [tw93/mole](https://github.com/tw93/mole) to inspect, preview, and safely perform macOS maintenance. Mole cleans disk space, uninstalls apps, analyzes storage, optimizes system services, monitors system health, purges project artifacts, and removes installer files.

## Core safety rules

Mole can delete local files or change macOS configuration. Keep these rules in working memory even when detailed workflows live in references.

1. Verify `mo` exists before relying on it.
2. Prefer dry-run/preview modes before changing files.
3. Dry-run, analysis, and status output can reveal personal paths, app names, project names, and storage locations; summarize only relevant details.
4. Summarize what will be removed and where before running a destructive command.
5. Ask for explicit confirmation before commands that clean, uninstall, purge, remove installers, optimize services, configure Touch ID/completions, update Mole, or remove Mole itself.
6. Prefer defaults that move items to macOS Trash when available; do not use `--permanent` unless the user explicitly asks for irreversible deletion.
7. Treat deletion from the `mo analyze` TUI as destructive; do not guide the user to delete selected files there without explicit confirmation.
8. Do not install Mole or helper dependencies automatically unless the user asks.
9. Do not use `rm -rf` as a shortcut around Mole's prompts or safety checks.
10. If Mole is uncertain, blocked by permissions, or asks for interactive confirmation, surface that state instead of forcing through it.

Destructive cleanup/removal commands:

```bash
mo clean
mo uninstall
mo purge
mo installer
mo remove
```

System/config-changing commands:

```bash
mo optimize
mo touchid enable
mo completion
mo update
mo purge --paths
```

Preview forms are safe enough to run without additional confirmation, while still treating their output as potentially private:

```bash
mo clean --dry-run
mo uninstall --dry-run <app-name>
mo purge --dry-run
mo installer --dry-run
mo optimize --dry-run
mo touchid enable --dry-run
mo completion --dry-run
mo remove --dry-run
```

## Session check

At the start of a Mole task, verify availability:

```bash
mo --version
```

Use `mo --help` or `mo <subcommand> --help` when command syntax, flags, or installed-version behavior matters. Trust observed help output because installed Mole versions can differ from the README.

If `mo` is missing, recommend Homebrew installation but do not install it automatically unless the user asks:

```bash
brew install mole
```

## Workflow routing

Read `references/workflows.md` for the detailed procedure once the user's intent matches a workflow below.

- **Free disk space / clean caches / remove app leftovers:** use `mo clean --dry-run`, then `mo clean` after confirmation.
- **Uninstall installed Mac apps completely:** use `mo uninstall --list` if names are unclear, `mo uninstall --dry-run <app>`, then `mo uninstall <app>` after confirmation.
- **Remove old project artifacts:** use `mo purge --dry-run`, optionally `--include-empty`, then `mo purge` after confirmation.
- **Find and remove installer files:** use `mo installer --dry-run`, then `mo installer` after confirmation.
- **Analyze disk usage or large folders:** use `mo analyze`, a specific path, or `mo analyze -json <path>` for parseable output.
- **Check Mac health/performance:** use `mo status` for the live dashboard or `mo status -json` for summaries.
- **Optimize macOS services:** use `mo optimize --dry-run`, then `mo optimize` after confirmation; treat it as system-changing, not ordinary cleanup.
- **Protect paths or maintenance targets:** use `mo clean --whitelist` or `mo optimize --whitelist` only after explaining the interactive configuration change.
- **Setup/update/remove Mole:** use `mo touchid`, `mo completion`, `mo update`, or `mo remove` only when explicitly requested.

For exact flags, command examples, and version-specific notes, read `references/commands.md`.

For missing commands, permissions, Full Disk Access, sudo prompts, operation logs, or README/version mismatch, read `references/troubleshooting.md`.

## Reporting format

For preview results, respond with:

```markdown
## Mole preview
- Command: `<command>`
- Scope: <folders/apps/categories inspected>
- Candidates: <short list of important categories or paths>
- Estimated space: <amount if Mole reported it>
- Risk notes: <anything interactive, irreversible, private, or system-changing>

Next step: confirm whether to run `<destructive command>`.
```

For completed cleanup, respond with:

```markdown
## Mole result
- Command run: `<command>`
- Space freed / items removed: <reported result>
- Recoverability: <Trash vs permanent deletion if known>
- Follow-up: <optional next safe preview command>
```

Keep reports concise. The user usually needs the command, scope, recovered space, recoverability, and whether anything risky happened.

## Reference files

- `references/workflows.md` — detailed step-by-step workflows for cleanup, uninstall, purge, installer cleanup, analysis, status, optimization, whitelist, and maintenance tasks.
- `references/commands.md` — command syntax, flags observed from Mole 1.39.1, README notes, and CLI examples.
- `references/troubleshooting.md` — missing installation, permissions, privacy, logs, and version-drift handling.
