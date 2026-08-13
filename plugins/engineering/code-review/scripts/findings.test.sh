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

write_plan() {
  local run_dir="$1"
  run_dir="$(cd "$run_dir" && pwd)"
  local status="$2"
  shift 2
  local tasks='[]' task_id angle prompt
  while [ $# -gt 0 ]; do
    task_id="$1"
    angle="$2"
    shift 2
    prompt="$run_dir/prompts/$task_id.md"
    : > "$prompt"
    tasks="$(jq -cn --argjson tasks "$tasks" --arg id "$task_id" --arg angle "$angle" \
      --arg prompt "$prompt" '$tasks + [{id: $id, angle: $angle, prompt: $prompt}]')"
  done
  local requested_angles
  requested_angles="$(printf '%s' "$tasks" | jq -c \
    '[.[].angle | select(. != "sweep")] | unique')"
  jq -n --arg status "$status" --argjson requested_angles "$requested_angles" \
    --argjson tasks "$tasks" \
    '{version: 1, status: $status, requested_angles: $requested_angles, tasks: $tasks}' \
    > "$run_dir/review-plan.json"
}

assert_json() {
  local file="$1"
  local filter="$2"
  jq -e "$filter" "$file" >/dev/null || fail "$file did not satisfy: $filter"
}

run_empty_receipt_test() {
  local run_dir="$TMP_ROOT/empty-receipt"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness
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
  write_plan "$run_dir" ready correctness correctness
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
  write_plan "$run_dir" ready callers callers
  printf '%s\n' '[]' > "$run_dir/out/candidates-callers.json"

  bash "$FINDINGS" prepare --run-dir "$run_dir" >/dev/null
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" 'type == "array" and length == 0'
}

run_incomplete_receipt_test() {
  local run_dir="$TMP_ROOT/incomplete-receipt"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness
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

assert_json_output() {
  local json="$1"
  local filter="$2"
  local message="$3"
  printf '%s' "$json" | jq -e "$filter" >/dev/null || fail "$message"
}

run_resume_selection_test() {
  local run_dir="$TMP_ROOT/resume-selection"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness-1 correctness correctness-2 correctness callers callers
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
  write_plan "$run_dir" draft correctness correctness

  if bash "$FINDINGS" pending --run-dir "$run_dir" >/dev/null 2> "$run_dir/error.log"; then
    fail "pending accepted a draft review plan"
  fi
  grep -q 'review plan is not ready' "$run_dir/error.log" \
    || fail "pending did not require slice-plan finalization"
}

run_plan_coverage_test() {
  local run_dir="$TMP_ROOT/plan-coverage"
  new_run "$run_dir"
  write_plan "$run_dir" ready correctness correctness
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
  write_plan "$run_dir" ready correctness correctness
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
  write_plan "$run_dir" ready correctness-1 reuse
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
    .status == "ready"
    and .requested_angles == ["correctness", "callers"]
    and [.tasks[].id] == ["correctness", "callers"]'
  bash "$FINDINGS" build --run-dir "$run_dir" >/dev/null
  assert_json "$run_dir/out/findings.json" 'type == "array" and length == 0'
}

run_stale_normalized_test() {
  local run_dir="$TMP_ROOT/stale-normalized"
  new_run "$run_dir"
  write_plan "$run_dir" ready design design
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

  write_plan "$run_dir" ready design design sweep sweep
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
  printf '%b' "$block"
}

run_contract_test() {
  local angle example
  for angle in "$PLUGIN_ROOT"/references/angles/*.md; do
    example="$(extract_json_example "$angle")"
    printf '%s' "$example" | jq -e \
      '.status == "completed" and (.findings | type == "array")' >/dev/null \
      || fail "$(basename "$angle") does not show a valid completed receipt schema"
    grep -q '{"status":"completed","findings":\[\]}' "$angle" \
      || fail "$(basename "$angle") does not explicitly report a successful zero-finding review"
  done

}

run_empty_receipt_test
run_completed_findings_test
run_legacy_array_test
run_incomplete_receipt_test
run_resume_selection_test
run_draft_plan_test
run_plan_coverage_test
run_launch_angle_integrity_test
run_plan_relabel_test
run_legacy_migration_test
run_stale_normalized_test
run_contract_test

printf 'ok - completion receipts and resume checkpoints\n'
