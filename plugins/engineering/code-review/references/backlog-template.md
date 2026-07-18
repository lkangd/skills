# Backlog Entry Template

One file per deferred finding, written to `backlog_dir` (default `docs/code-review-backlog/`).
Filename: `<yyyymmdd>-<kebab-case-slug>.md`. Before creating a file, glob the backlog dir and
grep for the same file/symbol — if the issue is already recorded, update that file (e.g. bump
`severity`, refresh `Problem`) instead of creating a duplicate.

When an entry later gets fixed, flip `status: open` to `status: fixed` and add a `fixed:` date —
do not delete the file.

```markdown
---
id: <kebab-case-slug>
status: open              # open | fixed | wontfix
severity: <critical|major|minor|nit>
found: <yyyy-mm-dd>
source: </code-review or /code-review:adversarial, round N>
target: <one-line description of the review target that surfaced it>
---

# <one-line title>

## Problem

<What is wrong and where — file:line anchors and quoted evidence. Written so an agent with no
prior context can locate the issue from this section alone.>

## Why deferred

<Why it was not fixed in the review round: pre-existing / fix too large relative to the change
/ needs a decision from a human / touches code outside the review target.>

## Suggested fix approach

<A concrete sketch of the fix: which files change, in what direction, known constraints, and
what "done" looks like.>

## Recommended tools

<How to attack it efficiently: grep patterns, code-intelligence queries (e.g. find callers of
X), tests or commands to run to reproduce and to verify the fix.>
```
