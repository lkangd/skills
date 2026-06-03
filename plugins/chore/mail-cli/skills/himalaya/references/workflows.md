# Workflows

Use these examples when the main `SKILL.md` points you here for a specific task shape.

## Summarize unread mail

1. Discover the account and folders.
2. List unread envelopes without changing state.
3. Read only the relevant IDs with `--preview`.
4. Summarize for the user.

Example:

```bash
himalaya envelope list -a <acc> -o json --page-size 50 'not flag seen and after 2026-05-14'
himalaya message read -a <acc> --preview --no-headers <IDs...>
```

## Search by sender, date, or keyword

1. Build the narrowest `envelope list` query you can.
2. Show the hits as a compact list with IDs.
3. Read only the IDs the user cares about or the obvious top results.
4. If a search fails or times out, report it honestly and retry only with a safer narrower or broader query.

## Archive or move old mail

### Bulk or unseen mail (confirmation required)

Use when the user asks to archive many messages, a date range, a search result, or IDs you have not previewed for them in this conversation.

1. Do a dry-run list first.
2. Show exact IDs and destination folder.
3. Ask for confirmation.
4. Move in batches of at most 50 IDs.

### Post-read single archive (no extra confirmation)

Use when the user already asked you to expand/read specific message(s) in this conversation, you showed the preview or body with visible ID(s), and they now unambiguously ask to archive or move **only those** message(s) (e.g. "归档", "archive this", "把这封移走").

1. Recap briefly: account, source folder, destination folder, and the exact ID(s) — one line is enough.
2. Run the move immediately. Do not use `templates/destructive-action-confirmation.md` or wait for `confirm`.
3. Report success or failure from command output.

Still ask for confirmation if the target is unclear, multiple unrelated IDs are involved, or the user might mean a bulk rule instead of the message(s) they just read.

## Reply to a message

1. Read the message or thread in preview mode.
2. Draft the reply content.
3. Show the full outgoing email.
4. Ask the user to confirm recipients, subject, and body.
5. Only then send.
6. If no source message exists, stop and say so explicitly instead of inventing a draft.

## How to present results

### Envelope lists

Default to a compact table:

`# | Date | From | Subject | Flags | Att`

Keep the original message ID visible so the user can ask for follow-up actions.

### Message summaries

Use three layers:

- **Facts**: concrete excerpts or directly supported details
- **Key points**: distilled summary
- **Suggested actions**: clearly labeled recommendations

For more than 10 emails, cluster by sender or topic instead of giving one long flat list.
