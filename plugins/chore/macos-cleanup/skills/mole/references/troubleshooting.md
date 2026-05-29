# Mole Troubleshooting

Use this reference when `mo` is missing, a subcommand behaves differently than expected, permissions block cleanup, or the user asks where Mole stores logs/configuration.

## `mo` is missing

Recommend Homebrew installation:

```bash
brew install mole
```

Do not install automatically unless the user asks. After installation, verify:

```bash
mo --version
mo --help
```

## Command syntax differs from docs

Trust the installed binary over the README:

```bash
mo --help
mo <subcommand> --help
```

Mole evolves quickly and some README examples can differ from installed versions. Prefer observed flags when running commands locally.

## Permissions and Full Disk Access

Cleanup and analysis can be blocked by macOS privacy controls. If Mole reports denied folders or incomplete scans:

1. Report the blocked paths or categories.
2. Explain whether Full Disk Access, sudo, or user interaction appears required.
3. Do not change privacy settings automatically.
4. Ask the user to grant permissions manually if they want broader scanning.

Avoid broad permission changes for routine cleanup.

## Sudo and Touch ID

Some maintenance actions may prompt for sudo. Do not attempt to bypass prompts.

For Touch ID sudo setup, preview first when available:

```bash
mo touchid enable --dry-run
```

Run the real setup only when the user explicitly requests it.

## Operation logs

Mole versions that support operation logging may write logs to:

```text
~/Library/Logs/mole/operations.log
```

Use logs only when needed to inspect what happened or why a command failed. Summarize relevant lines instead of dumping personal paths unnecessarily.

The README may mention disabling operation logging with:

```bash
MO_NO_OPLOG=1 mo clean
```

Verify current behavior before relying on it.

## Whitelists and protected paths

Use whitelist commands for protected caches or optimization targets:

```bash
mo clean --whitelist
mo optimize --whitelist
```

These are interactive configuration changes. Explain the effect before running.

## Project purge paths

`mo purge --paths` edits custom scan locations, typically:

```text
~/.config/mole/purge_paths
```

Use it when Mole is scanning the wrong project roots or missing the user's development folders. Confirm before making configuration changes.

## Permanent deletion

`mo uninstall --permanent` bypasses macOS Trash and uses immediate deletion. Avoid it unless the user explicitly asks for permanent removal and acknowledges irreversibility.

## Privacy when reporting output

Dry-run, analyze, and status output can reveal personal information such as app names, document paths, project/client names, mounted volumes, and process names. Reports should include only what helps the user decide the next action.
