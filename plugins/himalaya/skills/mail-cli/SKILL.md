---
name: mail-cli
description: Use the himalaya CLI for email tasks whenever the user asks to check inboxes, unread mail, search mail, summarize emails, read threads, compose new emails, send an email, write an email, draft replies, reply, forward messages, download attachments, or organize email with archive/move/delete actions across IMAP or Maildir accounts. Prefer this skill even when the user says only “mail”, “email”, “inbox”, “unread”, “reply”, “send an email”, “write an email”, or “search my messages”. Always confirm recipients, subject, and body before sending, and confirm exact account/folder/IDs before destructive actions.
---

# Mail CLI Skill (himalaya)

Use `himalaya` in a non-interactive, parseable way so agents can safely inspect and manage the user's email.

## What this skill is for

Use this skill to:

1. discover the real accounts and folders on this machine,
2. read and search mail without accidentally changing state,
3. recap any risky action before running it,
4. send or draft mail only through explicit confirmation.

## Non-negotiable rules

Keep these rules in working memory even if you never open the reference files.

1. **Verify runtime setup before acting.** Account names, default account, folder names, and enabled features differ across machines.
2. **Use JSON whenever agents needs to parse output.**
3. **Pass `-a <account>` explicitly.** Never rely on the default account.
4. **Pass `-f <folder>` explicitly when not using `INBOX`.** Resolve actual folder names first.
5. **Use `message read --preview` for analysis and summaries.** Do not silently mark mail as seen.
6. **Never use interactive composer commands.** Do not run `message write`, `message reply`, `message forward`, or `account configure`.
7. **For new mail, replies, and forwards, use only stdin/template-based send flows.** Do not improvise editor-based compose paths.
8. **Confirm before send.** Show the full outgoing draft and wait for an unambiguous send confirmation.
9. **Confirm before destructive actions.** For delete, move, expunge, purge, flag changes, or folder deletion, recap the exact `account + folder + IDs + action` and ask first.
10. **Operate on one account at a time** unless the user explicitly asks for all mailboxes.
11. **Chunk large actions.** If acting on more than 50 messages, split into batches.
12. **Do not edit config or expose secrets.** Never modify `config.toml`; never put passwords or tokens on the command line.
13. **Do not invent mailbox facts.** If no match exists, say so explicitly instead of inventing results, drafts, or recipients.

## Session-start check

Run these before the first real action in a session:

```bash
himalaya --version
himalaya account list -o json
himalaya folder list -a <account> -o json
```

Verify:

- `himalaya` exists and supports the needed features
- the intended account exists
- the intended folder exists on that account

If `himalaya` is missing or broken, report it and consult `references/troubleshooting.md`.

## Workflow routing

### Summarize unread mail

- Discover account and folders.
- List unread envelopes without changing state.
- Read only relevant messages with `--preview`.
- Summarize with IDs visible.

See `references/workflows.md` for the detailed flow and result format.

### Search mail

- Build the narrowest useful envelope query.
- Show a compact list before opening bodies.
- If a search fails or times out, report it honestly and retry only when justified.

See `references/command-patterns.md` for query patterns and `references/workflows.md` for search behavior.

### Read threads and attachments

- Prefer envelope-first discovery, then preview reads.
- Download attachments to a known directory before inspecting them.

See `references/command-patterns.md`.

### Reply or forward

- Find the source message safely.
- Use the non-interactive template flow.
- Show the full outgoing email.
- Wait for explicit confirmation before sending.
- If no source message exists, stop and say so.

Use `templates/send-confirmation.md` for the exact confirmation block.
See `references/command-patterns.md` and `references/workflows.md` for the command flow.

### Archive, move, delete, expunge, purge, or flag

- Dry-run or list matching IDs first.
- Recap the exact action, account, folder, target, and IDs.
- Ask for confirmation.

Use `templates/destructive-action-confirmation.md` for the exact recap block.
See `references/command-patterns.md` for the command forms.

## Resource map

Open additional files only when needed:

- `references/command-patterns.md` — concrete command forms and query examples
- `references/workflows.md` — task-specific workflows and result presentation guidance
- `references/troubleshooting.md` — setup issues, OAuth failures, timeouts, noisy warnings, and hangs
- `templates/send-confirmation.md` — exact outgoing email confirmation block
- `templates/destructive-action-confirmation.md` — exact destructive-action recap block
- `scripts/normalize_envelopes.py` — deterministic formatter for Himalaya envelope JSON when a stable compact table is useful

## What not to do

- Do not invent account names, folder names, or recipient addresses.
- Do not operate on all accounts unless the user asked for all mailboxes.
- Do not silently mark messages as seen during analysis.
- Do not send email in the same turn you first draft it.
- Do not edit the user's himalaya configuration.
