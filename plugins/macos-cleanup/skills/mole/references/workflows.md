# Mole Workflows

Use these workflows after `SKILL.md` safety rules are active. Prefer preview → summarize → confirm → execute for any cleanup or system-changing action.

## Free disk space safely

Use when the user asks to clean caches, logs, temporary files, app leftovers, Trash, browser caches, developer-tool caches, or generally free Mac storage.

1. Preview the cleanup:
   ```bash
   mo clean --dry-run
   ```
2. If the preview is too terse or the user wants details:
   ```bash
   mo clean --dry-run --debug
   ```
3. Summarize categories, approximate size, and privacy-sensitive paths only when necessary.
4. Ask for confirmation.
5. Run:
   ```bash
   mo clean
   ```

Use `mo clean` for leftovers from apps that are already gone. Use `mo uninstall` for apps still installed.

For an external mounted volume, verify the installed version supports `--external`, then preview first:

```bash
mo clean --external /Volumes/<volume-name> --dry-run
mo clean --external /Volumes/<volume-name>
```

## Uninstall Mac apps completely

Use when the user wants to remove an installed app and related files such as support data, caches, preferences, logs, WebKit storage, cookies, extensions, plugins, or launch daemons.

1. If the exact app name is unclear, list accepted names:
   ```bash
   mo uninstall --list
   ```
2. Preview the app removal:
   ```bash
   mo uninstall --dry-run <app-name>
   ```
3. Summarize the app and related paths.
4. Ask for confirmation.
5. Run:
   ```bash
   mo uninstall <app-name>
   ```

By default, Mole sends uninstalled files to macOS Trash so they can be recovered. Avoid:

```bash
mo uninstall --permanent <app-name>
```

Only use `--permanent` after the user explicitly asks to bypass Trash and acknowledges the deletion is irreversible.

## Remove old project artifacts

Use when the user asks to clean development folders, old `node_modules`, Rust `target`, Swift `.build`, `build`, `dist`, virtualenvs, or other stale project artifacts.

1. Preview:
   ```bash
   mo purge --dry-run
   ```
2. Include empty artifact directories only when the user cares about tidying folder trees:
   ```bash
   mo purge --dry-run --include-empty
   ```
3. If scan locations are wrong or missing, configure them interactively:
   ```bash
   mo purge --paths
   ```
   This edits Mole's custom scan list, typically `~/.config/mole/purge_paths`.
4. Summarize candidates and ask for confirmation.
5. Run:
   ```bash
   mo purge
   ```

Mole's README recommends `fd` for faster project scanning:

```bash
brew install fd
```

Do not install it automatically unless the user asks.

## Find and remove installer files

Use for `.dmg`, `.pkg`, `.iso`, `.xip`, `.zip`, downloaded installers, Desktop installers, Homebrew cached installers, iCloud installers, or Mail-downloaded installers.

1. Preview:
   ```bash
   mo installer --dry-run
   ```
2. Summarize large or suspicious candidates.
3. Ask for confirmation.
4. Run:
   ```bash
   mo installer
   ```

## Analyze disk usage

Use when the user wants to understand what is taking space, inspect large directories, browse a disk tree, or manually choose deletions.

Interactive TUI:

```bash
mo analyze
mo analyze ~/Documents
mo analyze /Volumes
```

Parseable output:

```bash
mo analyze -json ~/Documents
```

Use JSON when summarizing storage programmatically. In the TUI, common keys are:

```text
Arrow keys: navigate
O: open
F: show in Finder
Backspace: delete
L: large files
Q: quit
```

`mo analyze` is useful before deleting because Mole's analyzer can send selected files to Trash through Finder rather than bypassing recovery.

## Check system health

Use when the user asks what is using CPU/memory/disk, why the Mac is slow, or wants a live dashboard.

Interactive dashboard:

```bash
mo status
```

JSON for analysis:

```bash
mo status -json
```

High-CPU alert tuning:

```bash
mo status -proc-cpu-threshold 150
mo status -proc-cpu-window 2m
mo status -proc-cpu-alerts=false
```

Status is read-only, but it is interactive and may keep running until quit.

## Optimize macOS services

Use when the user asks to refresh caches/services, repair safe maintenance issues, refresh Finder/Dock, reset network services, rebuild Launch Services, rebuild Spotlight, or clean diagnostic/crash logs.

1. Preview:
   ```bash
   mo optimize --dry-run
   ```
2. If the user wants to protect specific items, manage the whitelist:
   ```bash
   mo optimize --whitelist
   ```
3. Summarize system-changing actions.
4. Ask for confirmation.
5. Run:
   ```bash
   mo optimize
   ```

This can affect visible system state such as Finder, Dock, network services, caches, and indexing. Do not run it casually as part of ordinary file cleanup.

## Manage protected paths and whitelists

Use whitelist commands when the user wants to protect caches, app data, or optimization targets from cleanup.

```bash
mo clean --whitelist
mo optimize --whitelist
```

Whitelist commands are interactive. Explain that they change Mole's protected-items configuration before running them.

## Setup and maintenance commands

Only use these when the user explicitly asks:

```bash
mo touchid enable --dry-run
mo completion --dry-run
mo update --force
mo update --nightly
mo remove --dry-run
```

Prefer stable updates. `mo update --nightly` installs an unreleased main-branch build and should only be used when the user specifically asks for nightly behavior or a maintainer asks them to test it.
