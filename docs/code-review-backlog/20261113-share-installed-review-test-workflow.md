---
id: share-installed-review-test-workflow
status: open
severity: minor
found: 2026-11-13
source: /code-review, round 1
target: commits a7e54fc through cf2d28c
---

# Share installed review scenarios between Codex and Pi

## Problem

In [installed_workflows.py](../../plugins/engineering/code-review/evaluation/installed_workflows.py),
`exercise_codex` and `exercise_pi` each assert ordinary review, adversarial follow-up,
cancellation and checkpoint reuse. Updating one sequence can leave the other testing
different behavior.

## Why deferred

The drivers handle different command and cancellation protocols. The shared scenario
needs an interface that preserves the protocol-specific assertions.

## Suggested fix approach

Extract the common sequence and assertions into one helper. Keep installation,
authorization and event handling in the host drivers. Run the shared sequence for
both native scheduling and the external runner.

## Recommended tools

Run `evaluation/installed_workflows.py both` and `evaluation/installed_workflows.py both --external`.
