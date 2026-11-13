---
id: share-review-conventions-discovery
status: open
severity: minor
found: 2026-11-13
source: /code-review, round 1
target: commits a7e54fc through cf2d28c
---

# Share project convention discovery across review launchers

## Problem

[review_workspace.py](../../plugins/engineering/code-review/scripts/review_workspace.py)
uses `STANDARDS` and `conventions()` to find root and ancestor convention files.
[run-orchestrator.sh](../../plugins/engineering/code-review/scripts/run-orchestrator.sh)
maintains its own list and ancestor search in `convention_docs()`. A new convention
filename or scope change can reach only one launcher.

## Why deferred

This refactor crosses the portable and legacy Claude paths, which use different
excerpt formatting and collect changed paths differently.

## Suggested fix approach

Share the file selection and ancestor traversal. Keep excerpt formatting in each
caller. Verify that both paths select the same files for committed and untracked changes.

## Recommended tools

Use the convention tests in `scripts/run-orchestrator.test.sh` and compare their
fixtures against the portable review packet.
