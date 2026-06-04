# macos-cleanup Plugin

Safe workflows for macOS cleanup, disk space recovery, and system health checks in Claude Code.

This plugin is built around the [Mole](https://github.com/tw93/mole) `mo` CLI so Claude can handle requests like "Mac disk is full," "System Data is huge," "uninstall app leftovers," or "clean node_modules / build artifacts" via preview-first, confirm-before-action, recoverable paths.

## Plugin goals

This plugin is not meant to let Claude delete files automatically. Instead, Claude should:

1. Recognize macOS cleanup requests and route them through `mo`;
2. Run dry-run / preview first;
3. Summarize candidates, space estimates, and risks;
4. Wait for explicit confirmation before cleanup, uninstall, purge, optimization, or config changes;
5. Avoid irreversible deletion by default.

In short: **macos-cleanup is a safe operations guide for Mac cleanup tasks, not an auto-wipe tool.**

## Prerequisites

Mole must be installed locally:

```bash
brew install mole
```

Verify after install:

```bash
mo --version
mo --help
```

The plugin does not install Mole automatically. The skill only suggests installation when `mo` is missing; do not run install commands unless the user explicitly asks.

## Current implementation

The plugin consists of one skill and several reference files:

```text
plugins/chore/macos-cleanup/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── mole/
        ├── SKILL.md
        └── references/
            ├── commands.md
            ├── troubleshooting.md
            └── workflows.md
```

### `skills/mole/SKILL.md`

Main entry point. It:

- Defines trigger scenarios
- Keeps core safety rules
- Separates destructive cleanup from system/config-changing commands
- Defines session checks
- Routes user intent to specific workflows
- Defines preview and completion report formats
- Points to reference files only when needed

`SKILL.md` stays intentionally lean so full `mo` subcommand details are not loaded into the main context every time.

### `skills/mole/references/workflows.md`

Detailed workflows, including:

- Free disk space: `mo clean --dry-run` → `mo clean`
- Full app uninstall: `mo uninstall --dry-run <app>` → `mo uninstall <app>`
- Clean old project artifacts: `mo purge --dry-run` → `mo purge`
- Clean installers: `mo installer --dry-run` → `mo installer`
- Analyze disk usage: `mo analyze`
- Check system health: `mo status`
- Optimize macOS services: `mo optimize --dry-run` → `mo optimize`
- Manage whitelist / purge paths / setup maintenance commands

### `skills/mole/references/commands.md`

Command reference and version notes, including:

- Actual help output for Mole 1.39.1
- Common flags for `clean` / `uninstall` / `purge` / `installer` / `optimize` / `analyze` / `status`
- Places where README may differ from the installed version
- Version quirks such as `-json` vs `--json`

### `skills/mole/references/troubleshooting.md`

Troubleshooting for:

- Missing `mo`
- Command syntax differing from README
- macOS permissions / Full Disk Access / sudo
- Touch ID sudo
- Operation logs
- Whitelist and protected paths
- `mo purge --paths`
- Permanent deletion risk
- Privacy rules for path summaries

## Trigger scenarios

The `mole` skill fits requests such as:

- "Help me clean my Mac"
- "Disk full / disk full"
- "System Data is huge"
- "Mac is slow, check resource usage"
- "Uninstall an app and clean leftovers"
- "Find large files / directories"
- "Clean old node_modules / build / dist / target"
- "Clean dmg/pkg/zip installers"
- "Optimize Finder / Dock / Spotlight / Launch Services"

## Safety boundaries

The skill defaults to:

1. **Preview first**: prefer `--dry-run` or read-only analysis commands.
2. **Then summarize**: only aggregate necessary paths; avoid exposing unrelated personal file names, project names, or app names.
3. **Then confirm**: require explicit confirmation before delete, uninstall, purge, optimize, update, or config changes.
4. **Prefer recoverable actions**: rely on Mole's Trash behavior by default; do not use `--permanent` proactively.
5. **Do not bypass safeguards**: do not substitute `rm -rf` for Mole or force past permissions or interactive confirmation.

High-risk commands include:

```bash
mo clean
mo uninstall
mo purge
mo installer
mo remove
```

System or configuration-changing commands include:

```bash
mo optimize
mo touchid enable
mo completion
mo update
mo purge --paths
```

## Progressive disclosure

This plugin uses three layers on purpose:

1. **metadata**: `name` + `description` for skill triggering.
2. **SKILL.md**: core safety rules, routing, and report format after load.
3. **references/**: read only when a specific workflow, flag, or troubleshooting step is needed.

This avoids stuffing the full command manual into context on every trigger while keeping high-risk safety rules visible.

## Maintenance

When changing this plugin:

- New trigger scenarios: update `SKILL.md` frontmatter `description` first.
- New hard safety constraints: put them in `SKILL.md`, not only in references.
- New command flags: put them in `references/commands.md`.
- New operational steps: put them in `references/workflows.md`.
- New troubleshooting notes: put them in `references/troubleshooting.md`.
- If README disagrees with local `mo --help`, trust local help.

## Verification

After changes, check:

```bash
mo --version
mo --help
```

And verify plugin layout:

```bash
find plugins/chore/macos-cleanup -maxdepth 5 -type f | sort
```

If using a plugin validator, confirm:

- `.claude-plugin/plugin.json` exists
- `skills/mole/SKILL.md` frontmatter has `name` and `description`
- All reference files linked from `SKILL.md` exist
- No destructive workflow is reachable without confirmation
