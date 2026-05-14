# Command patterns

Use these patterns when the main `SKILL.md` points you here for concrete command construction.

## Accounts and folders

Always discover names instead of assuming them.

```bash
himalaya account list -o json
himalaya folder list -a <acc> -o json
```

Do not assume aliases like `Archive`, `Sent`, or `Trash` exist.

## List and search messages

Start with envelopes. They are cheaper and safer than full-message reads.

```bash
himalaya envelope list -a <acc> -o json --page-size 20
himalaya envelope list -a <acc> -o json 'not flag seen order by date desc'
himalaya envelope list -a <acc> -o json 'from "github.com"'
himalaya envelope list -a <acc> -o json 'subject "invoice"'
himalaya envelope list -a <acc> -o json 'from "boss" and after 2026-05-01 and not flag seen'
himalaya envelope list -a <acc> -o json -f Drafts --page-size 50
```

### Query pieces

- `before <yyyy-mm-dd>` / `after <yyyy-mm-dd>`
- `from <pattern>` / `to <pattern>`
- `subject <pattern>` / `body <pattern>`
- `flag <seen|answered|flagged|deleted|draft>`
- `not`, `and`, `or`
- `order by date|from|to|subject asc|desc`

For large mailboxes, start with `--page-size 20` and narrow before reading bodies.

If you want a stable compact table from envelope JSON, pipe it through the bundled formatter:

```bash
himalaya envelope list -a <acc> -o json 'not flag seen order by date desc' \
  | python3 scripts/normalize_envelopes.py
```

## Read messages and threads

```bash
himalaya message read -a <acc> --preview <ID>
himalaya message read -a <acc> --preview --no-headers <ID>
himalaya message read -a <acc> --preview <ID1> <ID2> <ID3>
himalaya envelope thread -a <acc> -o json -i <ID>
himalaya message thread -a <acc> --preview <ID>
```

Use `--preview` by default. Only use plain `message read` when the user wants the message marked read or that state change is acceptable.

## Attachments

```bash
himalaya attachment download -a <acc> -f INBOX <ID>
himalaya attachment download -a <acc> -d /tmp/att <ID1> <ID2>
```

If the user wants attachment inspection, download to a known directory and then read the file with the appropriate tool.

## Flags, move, archive, delete

```bash
himalaya flag add -a <acc> seen <ID>
himalaya flag remove -a <acc> seen <ID>
himalaya message copy -a <acc> Archive <ID>
himalaya message move -a <acc> Archive <ID>
himalaya message delete -a <acc> <ID>
himalaya folder expunge -a <acc> -f Trash
himalaya folder purge -a <acc> -f Junk
```

Notes:

- `message delete` is typically a move to Trash, not permanent deletion.
- `expunge`, `purge`, and folder deletion are high-risk and always require confirmation.
- For bulk actions, list matching IDs first and then ask.

## Send, reply, and forward

Never trigger an editor. Always prepare the outgoing message and pipe it in.

```bash
himalaya message send -a <acc> <<'EOF'
From: me@example.com
To: alice@example.com
Subject: Test

Body here.
EOF
```

Preferred reply/forward flow:

```bash
himalaya template reply -a <acc> -f INBOX <ID> -o plain > /tmp/reply.eml
himalaya template forward -a <acc> <ID> -o plain > /tmp/forward.eml
cat /tmp/reply.eml | himalaya template send -a <acc>
```

For attachments in `template send`, use MML:

```text
<#part filename=/abs/path/file.pdf><#/part>
```
