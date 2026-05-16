---
name: mail-cli
description: This skill is for email tasks using the himalaya CLI: checking inbox/unread mail, searching messages, summarizing or reading threads, opening or expanding selected emails, message groups, or topics, handling attachments, composing/replying/forwarding, archiving/moving/deleting/flagging, and reviewing a day's mail for items interesting or useful to the user. Use it for mail, email, inbox, unread messages, replies, sending email, searching messages, requests to open or expand selected emails, message groups, or topics, requests to review today's mail, find useful emails, decide what to read in an inbox, daily mail reviews, useful-content triage, and personalized interest-based email summaries.
---

# Mail CLI Skill (himalaya)

Use `himalaya` in a non-interactive, parseable way so agents can safely inspect and manage the user's email.

## What this skill is for

Use this skill to:

1. discover the real accounts and folders on this machine,
2. read and search mail without accidentally changing state,
3. learn the user's email-interest patterns from their explicit actions,
4. use those patterns to surface useful or interesting mail during broad daily reviews,
5. recap any risky action before running it,
6. send or draft mail only through explicit confirmation.

## Non-negotiable rules

Keep these rules in working memory even if you never open the reference files.

1. **Verify runtime setup before acting.** Account names, default account, folder names, and enabled features differ across machines.
2. **Use JSON whenever the agent needs to parse output.**
3. **Pass `-a <account>` explicitly.** Never rely on the default account.
4. **Pass `-f <folder>` explicitly when not using `INBOX`.** Resolve actual folder names first.
5. **Use `message read --preview` for analysis and summaries.** Do not silently mark mail as seen.
6. **Never use interactive composer commands.** Do not run `message write`, `message reply`, `message forward`, or `account configure`.
7. **For new mail, replies, and forwards, use only stdin/template-based send flows.** Do not improvise editor-based compose paths.
8. **Confirm before send.** Show the full outgoing draft and wait for an unambiguous send confirmation.
9. **Confirm before destructive actions.** For delete, move, expunge, purge, flag changes, or folder deletion, recap the exact `account + folder + IDs + action` and ask first.
10. **Operate on one account at a time** unless the user explicitly asks for all mailboxes.
11. **Run preference analysis when the user asks to expand/open selected emails, message groups, or topics.** Treat requests to expand/open specific messages, message groups, or themes from a list as explicit interest signals; analyze reusable traits and record a durable pattern when privacy-safe.
12. **Record interest signals when the user reveals preferences.** Save durable observations about which mail they open, ask to expand, summarize, explicitly dismiss, or repeatedly archive unread so future broad reviews can be personalized.
13. **Keep interest records local and non-secret.** Store only patterns, categories, title/content traits, and knowledge domains; do not copy full email bodies, credentials, private addresses, or sensitive personal data into preference files.
14. **Chunk large actions.** If acting on more than 50 messages, split into batches.
15. **Do not edit config or expose secrets.** Never modify `config.toml`; never put passwords or tokens on the command line.
16. **Do not invent mailbox facts.** If no match exists, say so explicitly instead of inventing results, drafts, or recipients.

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
- Update interest patterns if the user asks to expand, summarize, ignore, or archive specific kinds of messages.

See `references/workflows.md` for the detailed flow and result format.

### Personalized daily review

Use this flow when the user asks to review a day's mail broadly and list what is interesting, useful, worth reading, or relevant to them.

- Read `.claude/himalaya.local.md` from the current workspace root if it exists; if the workspace root is unclear, ask before creating a preference file.
- List candidate envelopes without changing state, then preview prioritized, sampled, or operationally important candidates with `--preview`.
- Return a ranked list with message IDs, why each item may matter, and which preference pattern matched.
- When the user asks to expand specific items, message groups, or themes, enter preference analysis and update the preference record when privacy-safe.
- Ask which items to expand or archive so the preference record can improve.

See `references/personalized-triage.md` for the detailed workflow, signal rules, privacy guardrails, and preference-file template usage.

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
- If the user archives or deletes messages without opening their content, treat that as a weak low-interest signal; record shared traits only when the pattern is repeated or the user confirms the reason.

Use `templates/destructive-action-confirmation.md` for the exact recap block.
See `references/command-patterns.md` for the command forms.

## Interest pattern memory

When the user asks to expand/open specific messages, message groups, or themes from a list, enter preference analysis before responding: identify reusable traits behind the selection, decide whether the signal is durable and privacy-safe, and maintain `.claude/himalaya.local.md` at the current workspace root when recording is appropriate. Also maintain the file when the user otherwise reveals durable email preferences. Store only reusable patterns, categories, title/content traits, knowledge domains, the user action that revealed the signal, and the date.

Before first creating the file, ask for explicit confirmation and explain what will be stored. If the workspace root is unclear, ask where to store the file. After each update, mention the pattern recorded. Do not copy full email bodies, credentials, private addresses, sensitive personal data, or inferred sensitive personal attributes.

Use interest patterns as ranking aids, not hard filters. Low-interest patterns should not hide time-sensitive, directly addressed, security-related, billing-related, or operationally important mail.

See `references/personalized-triage.md` for signal rules and privacy guardrails. Use `templates/interest-patterns.md` when creating the preference file.

## Resource map

Open additional files only when needed:

- `references/command-patterns.md` — concrete command forms and query examples
- `references/workflows.md` — task-specific workflows and result presentation guidance
- `references/personalized-triage.md` — daily useful-mail review, interest signals, and privacy guardrails
- `references/troubleshooting.md` — setup issues, OAuth failures, timeouts, noisy warnings, and hangs
- `templates/send-confirmation.md` — exact outgoing email confirmation block
- `templates/destructive-action-confirmation.md` — exact destructive-action recap block
- `templates/interest-patterns.md` — starter structure for `.claude/himalaya.local.md`
- `scripts/normalize_envelopes.py` — deterministic formatter for Himalaya envelope JSON when a stable compact table is useful

## What not to do

- Do not invent account names, folder names, or recipient addresses.
- Do not operate on all accounts unless the user asked for all mailboxes.
- Do not silently mark messages as seen during analysis.
- Do not send email in the same turn you first draft it.
- Do not edit the user's himalaya configuration.
- Do not state mailbox state (e.g. "inbox is empty") from memory. Always run the corresponding query command first and report from actual output.
