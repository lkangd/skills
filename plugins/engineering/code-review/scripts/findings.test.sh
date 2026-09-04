#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FINDINGS="$SCRIPT_DIR/findings.sh"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/code-review-findings.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

new_run() {
  local run_dir="$1"
  mkdir -p "$run_dir/out" "$run_dir/prompts"
  : > "$run_dir/diff-stat.txt"
}

# write_plan RUN_DIR STATUS [<task-id> <angle> <wave>]...
# requested_angles and late_waves are derived from the tasks, so a test states only the tasks.
write_plan() {
  local run_dir="$1"
  run_dir="$(cd "$run_dir" && pwd -P)"
  local status="$2"
  shift 2
  local tasks='[]' task_id angle wave
  while [ $# -gt 0 ]; do
    task_id="$1"
    angle="$2"
    wave="$3"
    shift 3
    : > "$run_dir/prompts/$task_id.md"
    tasks="$(jq -cn --argjson tasks "$tasks" --arg id "$task_id" --arg angle "$angle" \
      --argjson wave "$wave" '$tasks + [{id: $id, angle: $angle, wave: $wave}]')"
  done
  local requested_angles late_waves
  requested_angles="$(printf '%s' "$tasks" | jq -c \
    '[.[] | select(.wave == 1) | .angle] | unique')"
  late_waves="$(printf '%s' "$tasks" | jq -c \
    '[.[] | select(.wave > 1)] | group_by(.wave)
     | map({wave: .[0].wave, angles: ([.[].angle] | unique)})')"
  jq -n --arg status "$status" --argjson requested_angles "$requested_angles" \
    --argjson late_waves "$late_waves" --argjson tasks "$tasks" \
    '{version: 2, status: $status, requested_angles: $requested_angles,
      late_waves: $late_waves, tasks: $tasks}' \
    > "$run_dir/review-plan.json"
}

assert_json() {
  local file="$1"
  local filter="$2"
  jq -e "$filter" "$file" >/dev/null || fail "$file did not satisfy: $filter"
}

assert_json_output() {
  local json="$1"
  local filter="$2"
  local message="$3"
  printf '%s' "$json" | jq -e "$filter" >/dev/null || fail "$message"
}

run_empty_receipt_test() {
  local run_dir="$TMP_ROOT/empty-receipt"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-correctness.json"

  local output
  output="$(bash "$FINDINGS" prepare --run-dir "$run_dir")"
  case "$output" in
    *"every completed angle receipt has an empty findings array"*) ;;
    *) fail "prepare did not recognize an explicit zero-finding completion receipt" ;;
  esac

  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" 'type == "array" and length == 0'
}

run_completed_findings_test() {
  local run_dir="$TMP_ROOT/completed-findings"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  printf '%s\n' ' src/example.js | 1 +' > "$run_dir/diff-stat.txt"
  jq -n '{
    status: "completed",
    findings: [{
      severity: "major",
      title: "Example defect",
      file: "./src/example.js",
      line: 7,
      evidence: "example evidence",
      why: "input -> wrong output",
      suggestion: "fix it"
    }]
  }' > "$run_dir/out/candidates-correctness.json"

  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/normalized-candidates.json" \
    'length == 1 and .[0].angle == "correctness" and .[0].file == "src/example.js"'

  local index
  index="$(jq -r '.[0].index' "$run_dir/out/normalized-candidates.json")"
  jq -n --argjson index "$index" \
    '[{index: $index, verdict: "CONFIRMED", evidence: "verified"}]' \
    > "$run_dir/out/verdicts-1.json"

  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" \
    'length == 1 and .[0].angle == "correctness" and .[0].verdict == "CONFIRMED"'
}

run_legacy_array_test() {
  local run_dir="$TMP_ROOT/legacy-array"
  new_run "$run_dir"
  write_plan "$run_dir" ready callers callers 1
  printf '%s\n' '[]' > "$run_dir/out/candidates-callers.json"

  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" 'type == "array" and length == 0'
}

run_incomplete_receipt_test() {
  local run_dir="$TMP_ROOT/incomplete-receipt"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  printf '%s\n' '{"status":"running","findings":[]}' \
    > "$run_dir/out/candidates-correctness.json"

  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" \
    'length == 1 and .[0] == "correctness"' \
    "pending did not retain a reviewer receipt without completed status"
  if bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "prepare accepted a reviewer receipt without completed status"
  fi
  grep -q 'review tasks incomplete: correctness' "$run_dir/error.log" \
    || fail "prepare did not explain the incomplete review task"
  [ ! -e "$run_dir/out/normalized-candidates.json" ] \
    || fail "prepare checkpointed candidates from an incomplete receipt"
}

run_resume_selection_test() {
  local run_dir="$TMP_ROOT/resume-selection"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness-1 correctness 1 correctness-2 correctness 1 callers callers 1
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-correctness-1.json"
  cat > "$run_dir/out/candidates-callers.json" <<'EOF'
```json
{"status":"completed","findings":[]}
```
EOF

  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" \
    'length == 1 and .[0] == "correctness-2"' \
    "resume selection re-dispatched completed empty tasks or skipped the missing slice"

  if bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "build created a clean result with a missing planned slice"
  fi
  grep -q 'review tasks incomplete: correctness-2' "$run_dir/error.log" \
    || fail "build did not explain the missing planned slice"

  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-correctness-2.json"
  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" \
    'length == 0' \
    "resume selection did not clear after every planned task completed"
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" 'type == "array" and length == 0'
}

run_draft_plan_test() {
  local run_dir="$TMP_ROOT/draft-plan"
  new_run "$run_dir"
  write_plan "$run_dir" draft correctness correctness 1

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "pending accepted a draft review plan"
  fi
  grep -q 'review plan is not ready' "$run_dir/error.log" \
    || fail "pending did not require slice-plan finalization"
}

run_symlinked_run_dir_test() {
  local physical_run="$TMP_ROOT/symlink-physical"
  local linked_run="$TMP_ROOT/symlink-run"
  new_run "$physical_run"
  ln -s "$physical_run" "$linked_run"
  mkdir -p "$linked_run/prompts"
  : > "$linked_run/prompts/correctness.md"
  jq -n --arg prompt "$linked_run/prompts/correctness.md" '{
    version: 1,
    status: "ready",
    requested_angles: ["correctness"],
    tasks: [{id: "correctness", angle: "correctness", prompt: $prompt}]
  }' > "$linked_run/review-plan.json"
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$linked_run/out/candidates-correctness.json"

  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$physical_run")" \
    'length == 0' \
    "physical run-dir spelling rejected an equivalent symlinked plan prompt"
}

# A version 1 plan is upgraded in place: its per-task prompt paths are verified once and then
# dropped, and the sweep — the only task version 1 allowed outside requested_angles — becomes
# an ordinary task on a declared late wave.
run_v1_plan_upgrade_test() {
  local run_dir="$TMP_ROOT/v1-upgrade"
  new_run "$run_dir"
  run_dir="$(cd "$run_dir" && pwd -P)"
  : > "$run_dir/prompts/design.md"
  : > "$run_dir/prompts/sweep.md"
  jq -n --arg dir "$run_dir" '{
    version: 1,
    status: "ready",
    requested_angles: ["design"],
    tasks: [{id: "design", angle: "design", prompt: ($dir + "/prompts/design.md")},
            {id: "sweep", angle: "sweep", prompt: ($dir + "/prompts/sweep.md")}]
  }' > "$run_dir/review-plan.json"
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-design.json"

  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" \
    'length == 1 and .[0] == "sweep"' \
    "version 1 upgrade changed which tasks are still pending"
  assert_json "$run_dir/review-plan.json" '
    .version == 2
    and .requested_angles == ["design"]
    and .late_waves == [{wave: 2, angles: ["sweep"]}]
    and [.tasks[] | {id, angle, wave}] == .tasks
    and [.tasks[] | select(.wave == 1) | .id] == ["design"]
    and [.tasks[] | select(.wave == 2) | .id] == ["sweep"]'
}

run_v1_prompt_mismatch_test() {
  local run_dir="$TMP_ROOT/v1-prompt-mismatch"
  new_run "$run_dir"
  run_dir="$(cd "$run_dir" && pwd -P)"
  : > "$run_dir/prompts/correctness.md"
  : > "$run_dir/prompts/callers.md"
  jq -n --arg dir "$run_dir" '{
    version: 1,
    status: "ready",
    requested_angles: ["correctness"],
    tasks: [{id: "correctness", angle: "correctness", prompt: ($dir + "/prompts/callers.md")}]
  }' > "$run_dir/review-plan.json"

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "version 1 upgrade dropped a prompt path pointing at another task's prompt"
  fi
  grep -q 'review task prompt must match its task ID: correctness' "$run_dir/error.log" \
    || fail "version 1 upgrade did not explain the mismatched prompt path"
}

# The sweep is no longer a name findings.sh knows: a late-wave task is legal exactly when the
# plan declares that wave, which is what lets another late phase be added without new cases.
run_undeclared_late_wave_test() {
  local run_dir="$TMP_ROOT/undeclared-late-wave"
  new_run "$run_dir"
  write_plan "$run_dir" ready design design 1 sweep sweep 2
  jq '.late_waves = []' "$run_dir/review-plan.json" > "$run_dir/review-plan.tmp"
  mv "$run_dir/review-plan.tmp" "$run_dir/review-plan.json"

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "pending accepted a late-wave task the plan never declared"
  fi
  grep -q 'review task angle is not declared for wave 2: sweep' "$run_dir/error.log" \
    || fail "plan validation did not explain the undeclared late wave"
}

# A declared late wave with no task yet is the normal state before Step 3.5 dispatches: only
# wave 1 has to be complete for the plan to be dispatchable.
run_pending_late_wave_test() {
  local run_dir="$TMP_ROOT/pending-late-wave"
  new_run "$run_dir"
  write_plan "$run_dir" ready design design 1
  jq '.late_waves = [{wave: 2, angles: ["sweep"]}]' "$run_dir/review-plan.json" \
    > "$run_dir/review-plan.tmp"
  mv "$run_dir/review-plan.tmp" "$run_dir/review-plan.json"
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-design.json"

  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" 'length == 0' \
    "a declared but undispatched late wave blocked the first wave from completing"

  # Appending the wave-2 task is the one plan change allowed after the plan is ready.
  : > "$run_dir/prompts/sweep.md"
  jq '.tasks += [{id: "sweep", angle: "sweep", wave: 2}]' "$run_dir/review-plan.json" \
    > "$run_dir/review-plan.tmp"
  mv "$run_dir/review-plan.tmp" "$run_dir/review-plan.json"
  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" \
    'length == 1 and .[0] == "sweep"' \
    "an appended late-wave task was not dispatched"
}

run_missing_prompt_test() {
  local run_dir="$TMP_ROOT/missing-prompt"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  rm "$run_dir/prompts/correctness.md"

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "pending dispatched a task whose derived prompt does not exist"
  fi
  grep -q 'review task prompt missing: .*prompts/correctness.md' "$run_dir/error.log" \
    || fail "plan validation did not explain the missing derived prompt"
}

run_plan_coverage_test() {
  local run_dir="$TMP_ROOT/plan-coverage"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  jq '.requested_angles += ["callers"]' "$run_dir/review-plan.json" \
    > "$run_dir/review-plan.tmp"
  mv "$run_dir/review-plan.tmp" "$run_dir/review-plan.json"
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-correctness.json"

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "pending accepted a plan that omitted a requested angle"
  fi
  grep -q 'review plan does not cover requested angle: callers' "$run_dir/error.log" \
    || fail "plan validation did not explain the omitted requested angle"
}

run_launch_angle_integrity_test() {
  local run_dir="$TMP_ROOT/launch-angle-integrity"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  printf '%s\n' '- Angles this round: correctness,callers' \
    > "$run_dir/orchestrator-prompt.md"
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-correctness.json"

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "pending accepted coordinated removal from requested_angles and tasks"
  fi
  grep -q 'requested_angles do not match the persisted launch angles' "$run_dir/error.log" \
    || fail "plan validation did not compare requested_angles with launch metadata"
}

run_plan_relabel_test() {
  local run_dir="$TMP_ROOT/plan-relabel"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness-1 reuse 1
  jq '.requested_angles = ["correctness"]' "$run_dir/review-plan.json" \
    > "$run_dir/review-plan.tmp"
  mv "$run_dir/review-plan.tmp" "$run_dir/review-plan.json"
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-correctness-1.json"

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "pending accepted a task relabeled to a different angle"
  fi
  grep -Eq 'review task angle was not requested|review task ID does not match its angle' \
    "$run_dir/error.log" \
    || fail "plan validation did not explain the relabeled task"
}

run_legacy_migration_test() {
  local run_dir="$TMP_ROOT/legacy-migration"
  new_run "$run_dir"
  printf '%s\n' '- Angles this round: correctness,callers' \
    > "$run_dir/orchestrator-prompt.md"
  : > "$run_dir/prompts/correctness.md"
  : > "$run_dir/prompts/callers.md"
  printf '%s\n' '[]' > "$run_dir/out/candidates-correctness.json"
  printf '%s\n' '[]' > "$run_dir/out/candidates-callers.json"

  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" \
    'length == 0' \
    "legacy bare-array checkpoints were not migrated as completed work"
  assert_json "$run_dir/review-plan.json" '
    .version == 2
    and .status == "ready"
    and .requested_angles == ["correctness", "callers"]
    and .late_waves == []
    and [.tasks[] | {id, angle, wave}] == .tasks
    and [.tasks[].id] == ["correctness", "callers"]
    and all(.tasks[]; .wave == 1)'
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" 'type == "array" and length == 0'
}

# A pre-plan run that already produced a sweep checkpoint migrates it as the late wave it was,
# not as a first-wave angle nobody requested.
run_legacy_sweep_migration_test() {
  local run_dir="$TMP_ROOT/legacy-sweep"
  new_run "$run_dir"
  printf '%s\n' '- Angles this round: design' > "$run_dir/orchestrator-prompt.md"
  : > "$run_dir/prompts/design.md"
  : > "$run_dir/prompts/sweep.md"
  printf '%s\n' '[]' > "$run_dir/out/candidates-design.json"
  printf '%s\n' '[]' > "$run_dir/out/candidates-sweep.json"

  assert_json_output "$(bash "$FINDINGS" pending --run-dir "$run_dir")" 'length == 0' \
    "legacy sweep checkpoint was not migrated as completed work"
  assert_json "$run_dir/review-plan.json" '
    .version == 2
    and .requested_angles == ["design"]
    and .late_waves == [{wave: 2, angles: ["sweep"]}]
    and [.tasks[] | select(.wave == 2) | .id] == ["sweep"]'
}

run_legacy_large_diff_migration_test() {
  local run_dir="$TMP_ROOT/legacy-large-diff"
  new_run "$run_dir"
  printf '%s\n' '- Angles this round: correctness' \
    > "$run_dir/orchestrator-prompt.md"
  : > "$run_dir/prompts/correctness.md"
  : > "$run_dir/raw_diff.txt"
  local line=1
  while [ "$line" -le 1501 ]; do
    printf 'line %s\n' "$line" >> "$run_dir/raw_diff.txt"
    line=$((line + 1))
  done

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "legacy migration dispatched an unsliced large diff"
  fi
  grep -q 'review plan is not ready' "$run_dir/error.log" \
    || fail "legacy large-diff migration did not require slicing"
  assert_json "$run_dir/review-plan.json" '.status == "draft"'
}

run_orphan_checkpoint_test() {
  local run_dir="$TMP_ROOT/orphan-checkpoint"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-correctness.json"
  printf '%s\n' '{"status":"completed","findings":[]}' \
    > "$run_dir/out/candidates-sweep.json"

  if bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "prepare silently ignored an unplanned checkpoint"
  fi
  grep -q 'checkpoint is not listed in review-plan.json' "$run_dir/error.log" \
    || fail "prepare did not explain the unplanned checkpoint"
}

run_build_before_prepare_exit_test() {
  local run_dir="$TMP_ROOT/build-before-prepare"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  jq -n '{
    status: "completed",
    findings: [{severity: "major", title: "Example", file: "src/example.js", line: 1,
      evidence: "evidence", why: "trigger", suggestion: "fix"}]
  }' > "$run_dir/out/candidates-correctness.json"

  local code=0
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log" || code=$?
  [ "$code" = "2" ] || fail "build-before-prepare exited $code instead of 2"
}

run_stale_normalized_test() {
  local run_dir="$TMP_ROOT/stale-normalized"
  new_run "$run_dir"
  write_plan "$run_dir" ready design design 1
  jq -n '{
    status: "completed",
    findings: [{
      severity: "major",
      title: "Initial finding",
      file: "src/example.js",
      line: 7,
      evidence: "initial evidence",
      why: "input -> wrong output",
      suggestion: "fix initial issue"
    }]
  }' > "$run_dir/out/candidates-design.json"
  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  local index
  index="$(jq -r '.[0].index' "$run_dir/out/normalized-candidates.json")"
  jq -n --argjson index "$index" \
    '[{index: $index, verdict: "CONFIRMED", evidence: "verified"}]' \
    > "$run_dir/out/verdicts-1.json"
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null

  write_plan "$run_dir" ready design design 1 sweep sweep 2
  jq -n '{
    status: "completed",
    findings: [{
      severity: "major",
      title: "Late sweep finding",
      file: "src/example.js",
      line: 9,
      evidence: "late evidence",
      why: "state -> wrong output",
      suggestion: "fix late issue"
    }]
  }' > "$run_dir/out/candidates-sweep.json"

  if bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "build reused normalized candidates after a planned sweep added findings"
  fi
  grep -q 'normalized-candidates.json is stale' "$run_dir/error.log" \
    || fail "build did not require prepare after a planned sweep added findings"
}

finding_json() { # severity title file line
  jq -cn --arg severity "$1" --arg title "$2" --arg file "$3" --argjson line "$4" \
    '{severity: $severity, title: $title, file: $file, line: $line,
      evidence: "evidence", why: "cost or trigger", suggestion: "fix"}'
}

# Cleanup-angle candidates skip the verifier by default and reach findings.json marked
# unverified; bug-angle candidates in the same round are still batched and joined normally.
run_cleanup_passthrough_test() {
  local run_dir="$TMP_ROOT/cleanup-passthrough"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1 reuse reuse 1
  printf '%s\n' ' src/a.js | 2 +-' > "$run_dir/diff-stat.txt"
  jq -n --argjson f "$(finding_json major "Null deref" src/a.js 3)" \
    '{status: "completed", findings: [$f]}' > "$run_dir/out/candidates-correctness.json"
  jq -n --argjson f "$(finding_json minor "Duplicated helper" src/a.js 30)" \
    '{status: "completed", findings: [$f]}' > "$run_dir/out/candidates-reuse.json"

  local output
  output="$(bash "$FINDINGS" prepare --run-dir "$run_dir")"
  case "$output" in
    *"to_verify=1 passthrough=1"*) ;;
    *) fail "prepare did not report the cleanup pass-through: $output" ;;
  esac
  assert_json "$run_dir/out/verify-input-1.json" 'length == 1 and .[0].angle == "correctness"'
  [ ! -e "$run_dir/out/verify-input-2.json" ] || fail "prepare batched a cleanup candidate"
  assert_json "$run_dir/out/normalized-candidates.json" \
    '(map(select(.angle == "reuse")) | .[0].unverified_by_policy == true)
     and (map(select(.angle == "correctness")) | .[0] | has("unverified_by_policy") | not)'

  local index
  index="$(jq -r '.[0].index' "$run_dir/out/verify-input-1.json")"
  jq -n --argjson index "$index" \
    '[{index: $index, verdict: "CONFIRMED", evidence: "verified"}]' > "$run_dir/out/verdicts-1.json"
  output="$(bash "$FINDINGS" build --run-dir "$run_dir")"
  case "$output" in
    *"STATS: 2 raw, 1 verified, 0 refuted, 1 cleanup passed through unverified"*) ;;
    *) fail "build stats did not account for the pass-through: $output" ;;
  esac
  case "$output" in
    *"cleanup 1 raw/0 refuted/1 passed through"*) ;;
    *) fail "build class line did not account for the pass-through: $output" ;;
  esac
  assert_json "$run_dir/out/findings.json" '
    length == 2
    and .[0].angle == "correctness" and .[0].verdict == "CONFIRMED" and (.[0] | has("unverified") | not)
    and .[1].angle == "reuse" and .[1].verdict == "PLAUSIBLE" and .[1].unverified == true
    and (.[1].verdict_evidence | startswith("UNVERIFIED"))'

  # --verify-all restores the old behaviour: the cleanup candidate joins a batch.
  rm -f "$run_dir/out/verdicts-1.json"
  bash "$FINDINGS" prepare --run-dir "$run_dir" --verify-all >/dev/null
  assert_json "$run_dir/out/verify-input-1.json" 'length == 2'
  assert_json "$run_dir/out/normalized-candidates.json" \
    'all(.[]; has("unverified_by_policy") | not)'
}

# A round whose only candidates are cleanup pass-throughs needs no verifier at all.
run_all_passthrough_test() {
  local run_dir="$TMP_ROOT/all-passthrough"
  new_run "$run_dir"
  write_plan "$run_dir" ready simplification simplification 1
  jq -n --argjson f "$(finding_json nit "Deep nesting" src/b.js 8)" \
    '{status: "completed", findings: [$f]}' > "$run_dir/out/candidates-simplification.json"

  local output
  output="$(bash "$FINDINGS" prepare --run-dir "$run_dir")"
  case "$output" in
    *"go straight to Step 4"*) ;;
    *) fail "prepare did not tell the orchestrator to skip verification: $output" ;;
  esac
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null \
    || fail "build refused a round of pure cleanup pass-throughs"
  assert_json "$run_dir/out/findings.json" 'length == 1 and .[0].unverified == true'
}

# Literal repeats (same file, line and title up to case/punctuation) merge without --drop;
# a candidate that already holds a verdict is the one that survives.
run_auto_duplicate_test() {
  local run_dir="$TMP_ROOT/auto-duplicate"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1 callers callers 1
  jq -n --argjson f "$(finding_json major "Unchecked return value" src/a.js 12)" \
    '{status: "completed", findings: [$f]}' > "$run_dir/out/candidates-correctness.json"
  jq -n --argjson f "$(finding_json minor "unchecked return-value." src/a.js 12)" \
    --argjson g "$(finding_json minor "Caller passes null" src/a.js 40)" \
    '{status: "completed", findings: [$f, $g]}' > "$run_dir/out/candidates-callers.json"

  local output
  output="$(bash "$FINDINGS" prepare --run-dir "$run_dir")"
  case "$output" in
    *"raw=3 dropped=1"*"1 literal repeat(s)"*) ;;
    *) fail "prepare did not merge the literal repeat: $output" ;;
  esac
  assert_json "$run_dir/out/normalized-candidates.json" '
    (map(select(.merged_duplicate == true)) | length == 1 and .[0].severity == "minor"
                                               and .[0].angle == "callers")'
  assert_json "$run_dir/out/verify-input-1.json" 'length == 2'
  # Re-running recomputes the same merge (it is not stored as a manual decision).
  output="$(bash "$FINDINGS" prepare --run-dir "$run_dir")"
  case "$output" in
    *"raw=3 dropped=1"*) ;;
    *) fail "re-running prepare lost the automatic merge: $output" ;;
  esac
  assert_json "$run_dir/out/normalized-candidates.json" '
    (map(select(.merged_duplicate == true)) | .[0].merged_by == "auto")'
}

# Duplicate detection keeps letters of every script: two distinct Chinese titles at one
# location are two findings, not one empty key.
run_unicode_duplicate_test() {
  local run_dir="$TMP_ROOT/unicode-duplicate"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  jq -n --argjson f "$(finding_json major "未校验返回值" src/a.js 12)" \
    --argjson g "$(finding_json major "空指针解引用" src/a.js 12)" \
    '{status: "completed", findings: [$f, $g]}' > "$run_dir/out/candidates-correctness.json"
  local output
  output="$(bash "$FINDINGS" prepare --run-dir "$run_dir")"
  case "$output" in
    *"raw=2 dropped=0"*) ;;
    *) fail "prepare merged two distinct non-ASCII titles: $output" ;;
  esac
}

# One reviewer repeating a finding verbatim: the two copies keep distinct indices across
# prepare runs, so the second run still leaves exactly one survivor.
run_verbatim_repeat_test() {
  local run_dir="$TMP_ROOT/verbatim-repeat"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  jq -n --argjson f "$(finding_json major "Unchecked return value" src/a.js 12)" \
    '{status: "completed", findings: [$f, $f]}' > "$run_dir/out/candidates-correctness.json"
  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/normalized-candidates.json" '
    ([.[].index] | unique | length == 2)
    and (map(select(.merged_duplicate != true)) | length == 1)'
}

# A manually dropped member of a literal-repeat group never becomes the survivor, even when
# it is the one that already holds a verdict — otherwise both copies vanish.
run_manual_drop_survivor_test() {
  local run_dir="$TMP_ROOT/manual-drop-survivor"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1 callers callers 1
  jq -n --argjson f "$(finding_json major "Unchecked return value" src/a.js 12)" \
    '{status: "completed", findings: [$f]}' > "$run_dir/out/candidates-correctness.json"
  jq -n --argjson f "$(finding_json minor "Unchecked return value" src/a.js 12)" \
    '{status: "completed", findings: [$f]}' > "$run_dir/out/candidates-callers.json"
  # First pass: the correctness copy (index 1) survives and gets verified.
  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  jq '[.[] | {index, verdict: "CONFIRMED", evidence: "ok"}]' \
    "$run_dir/out/verify-input-1.json" > "$run_dir/out/verdicts-1.json"
  local verified
  verified="$(jq '.[0].index' "$run_dir/out/verify-input-1.json")"
  # The orchestrator then drops that verified copy by hand; the other one must take over.
  bash "$FINDINGS" prepare --run-dir "$run_dir" --drop "$verified" >/dev/null
  assert_json "$run_dir/out/normalized-candidates.json" "
    (map(select(.merged_duplicate != true)) | length == 1 and .[0].index != $verified)"
}

# Findings whose file changed after the packet was built are marked stale so the main
# session re-checks them before acting.
run_stale_finding_test() {
  command -v git >/dev/null 2>&1 || return 0
  local repo="$TMP_ROOT/stale-repo" run_dir
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
  printf 'a\nb\n' > "$repo/keep.txt"
  printf 'x\ny\n' > "$repo/edit.txt"
  printf '%s\n' 1 2 3 4 5 6 7 8 9 10 11 12 > "$repo/old-name.txt"
  git -C "$repo" add keep.txt edit.txt old-name.txt
  git -C "$repo" commit -qm base
  printf 'a\nb\nc\n' > "$repo/keep.txt"
  printf 'x\ny\nz\n' > "$repo/edit.txt"
  # A staged rename with a small edit: the diff section says `a/old-name.txt b/new-name.txt`.
  git -C "$repo" mv old-name.txt new-name.txt
  printf '%s\n' 13 >> "$repo/new-name.txt"
  git -C "$repo" add new-name.txt
  printf 'fresh\n' > "$repo/untracked.txt"

  run_dir="$repo/.code-review/runs/1/round-1"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  git -C "$repo" diff HEAD --stat=1000,900 > "$run_dir/diff-stat.txt"
  git -C "$repo" diff HEAD > "$run_dir/raw_diff.txt"
  jq -n '{version: 1, requested_angles: ["correctness"], diff_args: "HEAD"}' \
    > "$run_dir/launch-params.json"
  printf 'untracked.txt\t%s\n' "$(cksum < "$repo/untracked.txt" | cut -d' ' -f1)" \
    > "$run_dir/untracked-sums.txt"
  jq -n --argjson f "$(finding_json major "Off by one" keep.txt 3)" \
    --argjson g "$(finding_json major "Wrong branch" edit.txt 3)" \
    --argjson h "$(finding_json minor "Magic number" new-name.txt 13)" \
    --argjson i "$(finding_json minor "Untested" untracked.txt 1)" \
    '{status: "completed", findings: [$f, $g, $h, $i]}' > "$run_dir/out/candidates-correctness.json"
  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  jq '[.[] | {index, verdict: "CONFIRMED", evidence: "ok"}]' \
    "$run_dir/out/verify-input-1.json" > "$run_dir/out/verdicts-1.json"

  # Nothing changed yet: no stale marks.
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" 'all(.[]; has("stale") | not)'

  # The working tree moves on under the review: a tracked edit, an edit to the renamed file
  # (its section is keyed by the new path the finding cites), and an untracked-file edit that
  # no git diff can see.
  printf 'x\ny\nz\nw\n' > "$repo/edit.txt"
  printf '%s\n' 14 >> "$repo/new-name.txt"
  printf 'fresh\nedited\n' > "$repo/untracked.txt"
  local output
  output="$(bash "$FINDINGS" build --run-dir "$run_dir")"
  case "$output" in
    *"STALE: 3 finding(s)"*"edit.txt"*) ;;
    *) fail "build did not report the stale findings: $output" ;;
  esac
  assert_json "$run_dir/out/findings.json" '
    (map(select(.file == "edit.txt")) | .[0].stale == true)
    and (map(select(.file == "new-name.txt")) | .[0].stale == true)
    and (map(select(.file == "untracked.txt")) | .[0].stale == true)
    and (map(select(.file == "keep.txt")) | .[0] | has("stale") | not)'
}

# A verdicts file that rules on other indices than its batch asked for is a warning, not a
# rejected build — the join is by index and still lands correctly.
run_verdict_batch_mismatch_test() {
  local run_dir="$TMP_ROOT/verdict-mismatch"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness 1
  jq -n --argjson f "$(finding_json major "A" src/a.js 1)" \
    --argjson g "$(finding_json major "B" src/a.js 20)" \
    '{status: "completed", findings: [$f, $g]}' > "$run_dir/out/candidates-correctness.json"
  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  jq '[.[0] | {index, verdict: "CONFIRMED", evidence: "ok"}]' \
    "$run_dir/out/verify-input-1.json" > "$run_dir/out/verdicts-1.json"

  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log" \
    || fail "build rejected a verdicts file with a partial batch"
  grep -q 'verdicts-1.json does not match verify-input-1.json' "$run_dir/error.log" \
    || fail "build did not warn about the partial verdicts batch"
  assert_json "$run_dir/out/findings.json" 'length == 1'
}

extract_json_example() {
  local file="$1"
  local line block='' in_block=0
  while IFS= read -r line; do
    if [ "$in_block" = "0" ]; then
      [ "$line" = '```json' ] && in_block=1
      continue
    fi
    [ "$line" = '```' ] && break
    block="$block$line
"
  done < "$file"
  printf '%s' "$block"
}

# The receipt protocol has exactly one home. Every angle prompt takes it by reference, and both
# reviewer definitions — external subagent and in-session agent — must still mandate the same
# final-message shape findings.sh parses.
run_contract_test() {
  local angle example fragment="$PLUGIN_ROOT/references/receipt-contract.md" source
  [ -r "$fragment" ] || fail "the shared receipt contract fragment is missing"
  grep -Fq '{"status":"completed","findings":[]}' "$fragment" \
    || fail "the receipt contract fragment does not state the zero-finding receipt"
  grep -Fq 'exactly one fenced' "$fragment" \
    || fail "the receipt contract fragment does not mandate a single fenced final message"

  for angle in "$PLUGIN_ROOT"/references/angles/*.md; do
    grep -Fq '{{RECEIPT_CONTRACT}}' "$angle" \
      || fail "$(basename "$angle") does not take the receipt contract from the shared fragment"
    grep -Fq '"status": "completed"' "$angle" \
      || fail "$(basename "$angle") does not show a completed receipt schema"
    example="$(extract_json_example "$angle")"
    printf '%s' "$example" | jq -e \
      '.status == "completed" and (.findings | type == "array")' >/dev/null \
      || fail "$(basename "$angle") does not show a valid completed receipt schema"
  done

  for source in "$PLUGIN_ROOT/agents/reviewer.md" "$PLUGIN_ROOT/scripts/run-orchestrator.sh"; do
    grep -Fq '{"status":"completed","findings":[]}' "$source" \
      || fail "$(basename "$source") does not carry the zero-finding receipt contract"
    grep -Fq 'entire final message' "$source" \
      || fail "$(basename "$source") does not mandate the receipt as the entire final message"
  done
}

run_empty_receipt_test
run_completed_findings_test
run_legacy_array_test
run_incomplete_receipt_test
run_resume_selection_test
run_draft_plan_test
run_symlinked_run_dir_test
run_v1_plan_upgrade_test
run_v1_prompt_mismatch_test
run_undeclared_late_wave_test
run_pending_late_wave_test
run_missing_prompt_test
run_plan_coverage_test
run_launch_angle_integrity_test
run_plan_relabel_test
run_legacy_migration_test
run_legacy_sweep_migration_test
run_legacy_large_diff_migration_test
run_orphan_checkpoint_test
run_build_before_prepare_exit_test
run_stale_normalized_test
run_cleanup_passthrough_test
run_all_passthrough_test
run_auto_duplicate_test
run_unicode_duplicate_test
run_verbatim_repeat_test
run_manual_drop_survivor_test
run_stale_finding_test
run_verdict_batch_mismatch_test
run_contract_test

printf 'ok - completion receipts and resume checkpoints\n'
