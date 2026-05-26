# Mole Command Reference

This reference combines Mole README guidance with command help observed from Mole 1.39.1 on macOS. Use current `mo --help` and `mo <subcommand> --help` output as authoritative.

## Core commands

```bash
mo                           # Main menu
mo clean                     # Free up disk space
mo uninstall                 # Remove apps completely
mo optimize                  # Refresh caches and services
mo analyze                   # Explore disk usage
mo status                    # Monitor system health
mo purge                     # Remove old project artifacts
mo installer                 # Find and remove installer files
mo touchid                   # Configure Touch ID for sudo
mo completion                # Setup shell tab completion
mo update                    # Update to latest version
mo remove                    # Remove Mole from system
mo --help                    # Show help
mo --version                 # Show version
```

## Preview and debug flags

```bash
mo clean --dry-run
mo clean --dry-run --debug
mo optimize --dry-run
mo uninstall --dry-run <app-name>
mo purge --dry-run
mo installer --dry-run
mo touchid enable --dry-run
mo completion --dry-run
mo remove --dry-run
```

Most subcommands support `--debug` for detailed operation logs.

## `mo clean`

Observed help:

```text
Usage: mo clean [OPTIONS]

Clean up disk space by removing caches, logs, temporary files, and app leftovers from already-uninstalled apps.

Options:
  --dry-run, -n     Preview cleanup without making changes
  --external PATH   Clean OS metadata from a mounted external volume
  --whitelist       Manage protected paths
  --debug           Show detailed operation logs
  -h, --help        Show this help message
```

Typical categories from the README include user app cache, browser cache, developer tools, system logs/temp files, app-specific cache, Trash, and app leftovers.

## `mo uninstall`

Observed help:

```text
Usage: mo uninstall [OPTIONS] [APP_NAME ...]

Interactively remove applications and their leftover files.
Optionally specify one or more app names to uninstall directly.
For leftovers from apps that are already gone, use mo clean.

Examples:
  mo uninstall                   Open interactive app selector
  mo uninstall slack             Uninstall Slack
  mo uninstall slack zoom        Uninstall Slack and Zoom
  mo uninstall --dry-run slack   Preview Slack uninstallation
  mo uninstall --list            Show installed apps and the names mo uninstall accepts

Options:
  --list            List installed apps with the exact name mo uninstall accepts
  --dry-run         Preview app uninstallation without making changes
  --permanent       Bypass macOS Trash and rm -rf immediately
  --whitelist       Not supported for uninstall (use clean/optimize)
  --debug           Show detailed operation logs
  -h, --help        Show this help message
```

Default behavior sends files to macOS Trash. Treat `--permanent` as irreversible.

## `mo purge`

Observed help:

```text
Usage: mo purge [options]

Options:
  --paths         Edit custom scan directories
  --dry-run       Preview purge actions without making changes
  --include-empty Show zero-size project artifact directories
  --debug         Enable debug logging
  --help          Show this help message
```

Targets old project artifacts such as `node_modules`, `target`, `.build`, `build`, `dist`, and virtual environments. Custom scan paths are usually stored in `~/.config/mole/purge_paths`.

## `mo installer`

Observed help:

```text
Usage: mo installer [OPTIONS]

Find and remove installer files (.dmg, .pkg, .iso, .xip, .zip).

Options:
  --dry-run         Preview installer cleanup without making changes
  --debug           Show detailed operation logs
  -h, --help        Show this help message
```

## `mo optimize`

Observed help:

```text
Usage: mo optimize [OPTIONS]

Refresh system caches and services, repair safe maintenance issues.

Options:
  --dry-run         Preview optimization without making changes
  --whitelist       Manage protected items
  --debug           Show detailed operation logs
  -h, --help        Show this help message
```

README examples include rebuilding system databases, clearing caches, resetting network services, refreshing Finder/Dock, cleaning diagnostics/crash logs, rebuilding Launch Services, and rebuilding Spotlight indexes.

## `mo analyze`

Observed help from the Go analyzer binary:

```text
-json    output analysis as JSON instead of TUI
```

Examples:

```bash
mo analyze
mo analyze ~/Documents
mo analyze /Volumes
mo analyze -json ~/Documents
```

The README notes that external drives under `/Volumes` are skipped by default unless `/Volumes` or a specific mount path is passed.

## `mo status`

Observed help from the Go status binary:

```text
-json                         output metrics as JSON instead of TUI
-proc-cpu-alerts              enable persistent high-CPU process alerts (default true)
-proc-cpu-threshold float     alert when a process stays above this CPU percent (default 100)
-proc-cpu-window duration     continuous duration a process must exceed the CPU threshold (default 5m0s)
```

Examples:

```bash
mo status
mo status -json
mo status -proc-cpu-threshold 150
mo status -proc-cpu-window 2m
mo status -proc-cpu-alerts=false
```

README examples may show `--json`; observed Mole 1.39.1 uses Go-style `-json`.

## README/version drift notes

The official README may mention commands or aliases not present in the installed version. For example, README summaries can mention `mo history`, but Mole 1.39.1 help did not expose that command. Verify less common commands before use.
