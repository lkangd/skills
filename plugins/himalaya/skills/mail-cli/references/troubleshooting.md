# Troubleshooting

## Common warnings and failures

- `WARN imap_codec::response: Rectified missing text` on stderr is usually harmless. Trust stdout and exit code.
- `folder not found` usually means the real server-side folder name differs from your expectation; re-run `folder list`.
- `cannot get secret from command ... exit 127` means the account credential source is broken; report it and do not patch config.
- `cannot exchange code for access and refresh tokens` or `LOGIN failed` on OAuth accounts usually means token repair is needed; suggest `himalaya account doctor <acc> --fix`.
- If output is garbled in table mode, rerun with `-o json`.
- If a command appears to hang, you probably triggered an interactive subcommand; stop and switch to a stdin/template flow.
- If a search query times out, report the timeout honestly and retry only with a safer query shape; do not pretend you found results.

## Setup issues

If `himalaya` is missing, ask the user to install it rather than guessing around it.
If an OAuth account is broken, surface the diagnosis before suggesting repair commands.
