#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/run-orchestrator.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/code-review-launcher.XXXXXX")"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_json() {
  local file="$1"
  local filter="$2"
  jq -e "$filter" "$file" >/dev/null || fail "$file did not satisfy: $filter"
}

FAKE_RUNNER="$TMP_ROOT/fake-runner.sh"
cat > "$FAKE_RUNNER" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '```json' '[]' '```'
EOF
chmod +x "$FAKE_RUNNER"

CHECKPOINT_RUNNER="$TMP_ROOT/checkpoint-runner.sh"
cat > "$CHECKPOINT_RUNNER" <<'EOF'
#!/usr/bin/env bash
set -eu
session_id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) session_id="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$session_id" ] || exit 40
[ -n "${CODE_REVIEW_TEST_RUN_DIR:-}" ] || exit 41
transcript_dir="$CODE_REVIEW_TRANSCRIPT_ROOT/test-project"
transcript="$transcript_dir/$session_id.jsonl"
mkdir -p "$transcript_dir"
jq -cn --arg prompt "$CODE_REVIEW_TEST_RUN_DIR/prompts/correctness.md" '
  {message:{content:[{type:"tool_use",name:"Agent",id:"toolu-review",input:{prompt:$prompt}}]}}' \
  > "$transcript"
jq -cn '
  {message:{content:[{type:"tool_result",tool_use_id:"toolu-review",content:[
    {type:"text",text:"```json\n{\"status\":\"completed\",\"findings\":[]}\n```"}
  ]}]}}' >> "$transcript"

attempt=0
while [ "$attempt" -lt 50 ]; do
  [ -s "$CODE_REVIEW_TEST_RUN_DIR/out/candidates-correctness.json" ] && break
  attempt=$((attempt + 1))
  sleep 0.1
done
[ -s "$CODE_REVIEW_TEST_RUN_DIR/out/candidates-correctness.json" ] || exit 42
printf '%s\n' '```json' '[]' '```'
EOF
chmod +x "$CHECKPOINT_RUNNER"

REPO="$TMP_ROOT/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.name test
git -C "$REPO" config user.email test@example.com
printf '%s\n' 'base' > "$REPO/example.txt"
git -C "$REPO" add example.txt
git -C "$REPO" commit -qm base

run_launcher() {
  local run_dir="$1"
  local diff_args="${2:-HEAD^..HEAD}"
  local angles="${3:-correctness, callers}"
  local runner="${4:-$FAKE_RUNNER}"
  (
    cd "$REPO"
    CODE_REVIEW_TRANSCRIPT_ROOT="$TMP_ROOT/transcripts" \
      CODE_REVIEW_TEST_RUN_DIR="$run_dir" \
      bash "$LAUNCHER" \
      --runner "$runner" \
      --run-dir "$run_dir" \
      --target "test diff" \
      --diff-args "$diff_args" \
      --angles "$angles" \
      --concurrency 0 >/dev/null
  )
}

printf '%s\n' 'small change' >> "$REPO/example.txt"
git -C "$REPO" add example.txt
git -C "$REPO" commit -qm small
SMALL_RUN="$TMP_ROOT/small-run"
run_launcher "$SMALL_RUN"
assert_json "$SMALL_RUN/review-plan.json" '
  .version == 2 and .status == "ready"
  and .requested_angles == ["correctness", "callers"]
  and .late_waves == []
  and [.tasks[].id] == ["correctness", "callers"]
  and all(.tasks[]; (.angle | type == "string") and .wave == 1)
  and all(.tasks[]; has("prompt") | not)'
# The plan stores no prompt path; every task ID must still resolve to a concretized prompt.
while IFS= read -r task_id; do
  [ -r "$SMALL_RUN/prompts/$task_id.md" ] \
    || fail "small-diff plan task has no prompt: $task_id"
done <<EOF
$(jq -r '.tasks[].id' "$SMALL_RUN/review-plan.json")
EOF
# An unresolved placeholder reaches the reviewer as template text — for the receipt contract
# that is a reviewer with no output format and a checkpoint no parser accepts.
for prompt in "$SMALL_RUN"/prompts/*.md; do
  ! grep -q '{{' "$prompt" \
    || fail "concretized prompt kept an unresolved placeholder: $prompt"
  grep -Fq '{"status":"completed","findings":[]}' "$prompt" \
    || fail "concretized prompt lost the shared receipt contract: $prompt"
done
assert_json "$SMALL_RUN/out/orchestrator.exit" '. == 0'

# A round that includes `design` declares the Step 3.5 sweep as a late wave up front, and its
# prompt keeps exactly one runtime placeholder for the orchestrator to fill.
SWEEP_RUN="$TMP_ROOT/sweep-run"
run_launcher "$SWEEP_RUN" "HEAD^..HEAD" "correctness, design"
assert_json "$SWEEP_RUN/review-plan.json" '
  .late_waves == [{wave: 2, angles: ["sweep"]}]
  and all(.tasks[]; .wave == 1)
  and ([.tasks[].angle] | index("sweep")) == null'
[ -r "$SWEEP_RUN/prompts/sweep.md" ] || fail "design round did not pre-build the sweep prompt"
grep -q '{{VERIFIED_FINDINGS}}' "$SWEEP_RUN/prompts/sweep.md" \
  || fail "sweep prompt lost its runtime placeholder"
[ "$(grep -c '{{' "$SWEEP_RUN/prompts/sweep.md")" = "1" ] \
  || fail "sweep prompt has placeholders beyond the runtime one"

CHECKPOINT_RUN="$TMP_ROOT/checkpoint-run"
run_launcher "$CHECKPOINT_RUN" "HEAD^..HEAD" "correctness" "$CHECKPOINT_RUNNER"
assert_json "$CHECKPOINT_RUN/out/candidates-correctness.json" '
  .status == "completed" and .findings == []'
grep -q 'checkpointed candidate candidates-correctness.json' \
  "$CHECKPOINT_RUN/out/checkpoint-harvester.log" \
  || fail "launcher harvester did not report the real-time reviewer checkpoint"

DUPLICATE_RUN="$TMP_ROOT/duplicate-run"
run_launcher "$DUPLICATE_RUN" "HEAD^..HEAD" "correctness, correctness, callers"
assert_json "$DUPLICATE_RUN/review-plan.json" '
  .requested_angles == ["correctness", "callers"]
  and [.tasks[].id] == ["correctness", "callers"]'

UNKNOWN_RUN="$TMP_ROOT/unknown-run"
if run_launcher "$UNKNOWN_RUN" "HEAD^..HEAD" "correctness,missing-angle" \
  2> "$TMP_ROOT/unknown.err"; then
  fail "launcher accepted an unknown angle"
fi
grep -q 'unknown angle (no template): missing-angle' "$TMP_ROOT/unknown.err" \
  || fail "unknown-angle failure did not explain the bad input"
[ ! -e "$UNKNOWN_RUN/review-plan.json" ] \
  || fail "launcher persisted a plan before rejecting the unknown angle"

WORKTREE_RUN="$TMP_ROOT/worktree-run"
printf '%s\n' 'untracked content' > "$REPO/untracked.txt"
run_launcher "$WORKTREE_RUN" "HEAD" "correctness"
assert_json "$WORKTREE_RUN/review-plan.json" '.status == "draft"'
rm "$REPO/untracked.txt"

# Create a committed diff whose unified form exceeds the split threshold.
: > "$REPO/large.txt"
line=1
while [ "$line" -le 1600 ]; do
  printf 'line %s\n' "$line" >> "$REPO/large.txt"
  line=$((line + 1))
done
git -C "$REPO" add large.txt
git -C "$REPO" commit -qm large
LARGE_RUN="$TMP_ROOT/large-run"
run_launcher "$LARGE_RUN"
assert_json "$LARGE_RUN/review-plan.json" '
  .version == 2 and .status == "draft"
  and .requested_angles == ["correctness", "callers"]
  and [.tasks[].id] == ["correctness", "callers"]'
if bash "$SCRIPT_DIR/findings.sh" pending --run-dir "$LARGE_RUN" \
  >/dev/null 2> "$LARGE_RUN/pending.err"; then
  fail "pending accepted the launcher draft plan before slicing"
fi
grep -q 'review plan is not ready' "$LARGE_RUN/pending.err" \
  || fail "draft plan rejection did not explain that slicing must finish"

printf 'ok - launcher persists ready and draft review plans\n'
