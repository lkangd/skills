# Personalized Mail Triage

Use this reference when the user asks to review a day's mail broadly and list what is interesting, useful, worth reading, or relevant to them.

## Daily review workflow

1. Read the local preference file if it exists: `.claude/himalaya.local.md` at the current workspace root. If the workspace root is unclear, ask before creating a preference file.
2. Discover account and folders, then list the requested day's candidate envelopes without changing state.
3. Use saved interest patterns to prioritize which messages to preview; still sample unfamiliar senders/topics when the subject suggests possible relevance.
4. Preview candidate messages with `message read --preview` and classify them as likely useful, maybe useful, or low-value.
5. Return a ranked list with message ID, sender, subject, why it may matter to the user, and the evidence pattern that matched.
6. Include a low-value or skipped summary only when it helps explain why obvious-looking messages were not prioritized.
7. Mention if the result depends on sparse or missing preference history, and ask which items the user wants to expand or archive so the pattern file can improve.
8. When the user chooses messages, message groups, or themes to expand/open from a list, enter preference analysis immediately: identify reusable traits, decide whether the signal is durable and privacy-safe, and update the interest pattern record when appropriate.
9. After the user chooses messages to summarize, ignore, or archive unread, update the interest pattern record when the signal is durable enough.

## Preference file

Maintain per-project mail triage preferences at the current workspace root in `.claude/himalaya.local.md` when user behavior reveals durable preferences. Create or update the file with YAML frontmatter and concise markdown notes.

If the file does not exist, use sensible defaults and create it only after the user shows a clear preference signal and explicitly confirms durable storage. Before first creating the file, ask a clear yes/no confirmation and tell the user that only reusable patterns and topic traits will be stored. If the workspace root is unclear, ask where to store the file. After each update, mention the pattern recorded.

Use `templates/interest-patterns.md` when creating the file, replacing `YYYY-MM-DD` with the actual update date.

## Result format

Use this compact structure for broad daily reviews:

```markdown
## Likely useful
- `<ID>` — <sender> — <subject>
  Why it may matter: <reason tied to user preferences or operational importance>
  Matched pattern: <pattern name or "new/unknown but relevant">

## Maybe useful
- `<ID>` — <sender> — <subject>
  Why it may matter: <short reason>

## Low-value or skipped
- <brief category-level note, only if useful>

Preference note: <missing/sparse/updated preference context, if relevant>
```

## Positive signals

Record positive signals when the user:

- asks to expand/open specific messages, message groups, or themes from a list; treat this as a mandatory preference-analysis trigger,
- asks for a deeper summary of certain messages or topics,
- replies, forwards, saves, or asks follow-up questions about a message,
- says a topic, sender type, domain, newsletter, alert, or knowledge area is useful.

## Negative signals

Record negative signals when the user:

- archives, deletes, or marks low-value messages without reading their content,
- skips a whole category after seeing only sender/subject snippets,
- says a sender, topic, digest, promotion, notification, or format is not useful.

Treat archiving or deleting unread messages as a weak low-interest signal. Record shared traits only when the pattern is repeated or the user confirms the reason.

## What to record

Capture patterns rather than raw mail:

- subject/title traits, such as release notes, billing alerts, AI research, product launches, calendar changes, promotional wording, or automated digest formats,
- content traits visible from preview, such as code examples, operational alerts, meeting logistics, vendor marketing, social notifications, or long-form technical analysis,
- sender/domain type, not private addresses unless the user explicitly names them as a preference,
- knowledge domains involved, such as frontend engineering, Claude Code plugins, AI tools, finance, travel, recruiting, or infrastructure,
- the action that produced the signal and the date.

Do not record inferred sensitive personal attributes, including health, religion, politics, sexuality, precise finances, legal matters, or similarly sensitive traits, unless the user explicitly asks to use that category for mail triage.

## How to apply patterns

Treat the record as a ranking aid, not a hard filter. A low-interest pattern should reduce priority but should not hide mail that is time-sensitive, directly addressed, security-related, billing-related, or otherwise operationally important.
