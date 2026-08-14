#!/usr/bin/env bash
# Single owner of the persisted review-plan.json shape. Sourced, never executed.
#
# Two writers produce this document — a fresh launch in run-orchestrator.sh and the legacy
# migration in findings.sh — and a third reader (findings.sh's validator) rejects anything that
# does not match. Building the document in both writers by hand is how a schema change updates
# one of them and leaves the other emitting a plan the validator refuses to load, on a run dir
# that already cost a full review round. Everything below the angle/task decisions those callers
# own lives here instead.
#
# Schema (version 2):
#
#   {"version": 2,
#    "status": "draft" | "ready",
#    "requested_angles": ["correctness", ...],       # immutable first-wave angle list
#    "late_waves": [{"wave": 2, "angles": ["sweep"]}],
#    "tasks": [{"id": "correctness-1", "angle": "correctness", "wave": 1}]}
#
# `wave` generalizes what version 1 special-cased as "the sweep task": wave 1 is the review
# plan proper and must cover every requested angle, and each later wave is a phase the launcher
# declared up front and the orchestrator appends tasks to once its inputs exist. A ready plan is
# immutable except for appending tasks belonging to a declared late wave.
#
# Task prompt paths are NOT stored. A task's prompt is always RUN_DIR/prompts/<task-id>.md, so
# storing it only created a second spelling of the same path for writers to keep in sync and for
# the validator to re-derive and compare.

REVIEW_PLAN_VERSION=2

# One base task per angle, all in the given wave.
review_plan_tasks() { # angles_json wave -> tasks_json
  jq -ce --argjson wave "$2" 'map({id: ., angle: ., wave: $wave})' <<<"$1"
}

review_plan_document() { # status requested_angles_json late_waves_json tasks_json -> plan_json
  jq -ce -n --argjson version "$REVIEW_PLAN_VERSION" --arg status "$1" \
    --argjson requested_angles "$2" --argjson late_waves "$3" --argjson tasks "$4" \
    '{version: $version, status: $status, requested_angles: $requested_angles,
      late_waves: $late_waves, tasks: $tasks}'
}

# Atomic on purpose: a resume that reads a half-written plan cannot tell it from a corrupt one.
review_plan_install() { # plan_json path
  local temp="$2.tmp.$$"
  printf '%s\n' "$1" | jq --indent 1 . > "$temp" || { rm -f "$temp"; return 1; }
  mv "$temp" "$2" || { rm -f "$temp"; return 1; }
}
