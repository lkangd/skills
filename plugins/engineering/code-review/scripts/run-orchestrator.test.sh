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
# Record the launch flags and environment so the test can check how agent definitions and
# runtime switches reach the session.
[ -z "${CODE_REVIEW_TEST_ARGS_FILE:-}" ] || printf '%s\n' "$@" > "$CODE_REVIEW_TEST_ARGS_FILE"
[ -z "${CODE_REVIEW_TEST_ARGS_FILE:-}" ] \
  || printf 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=%s\n' "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-unset}" \
       > "$CODE_REVIEW_TEST_ARGS_FILE.env"
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
      CODE_REVIEW_TEST_ARGS_FILE="$run_dir/runner-args.txt" \
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

# Reviewer/verifier definitions are agent files that embed the packet verbatim in their system
# prompt (one shared, cacheable prefix per tier) and reach the session via --add-dir; the angle
# prompts must therefore steer reviewers to the addendum instead of re-reading packet.md.
for agent in reviewer-deep:opus:20 reviewer:sonnet:20 verifier:sonnet:15; do
  name="${agent%%:*}"
  rest="${agent#*:}"
  model="${rest%%:*}"
  turns="${rest##*:}"
  file="$SMALL_RUN/agents/.claude/agents/$name.md"
  [ -r "$file" ] || fail "launcher did not write agent definition: $file"
  [ "$(sed -n '1p' "$file")" = "---" ] || fail "agent file has no leading frontmatter: $file"
  grep -q "^name: $name\$" "$file" || fail "agent file lacks name $name: $file"
  grep -q "^model: $model\$" "$file" || fail "agent file lacks model $model: $file"
  # The turn budget is structural (frontmatter) and stated to the agent in the same number.
  grep -q "^maxTurns: $turns\$" "$file" || fail "agent file lacks maxTurns $turns: $file"
  grep -Fq "HARD cap of $turns turns" "$file" || fail "agent prompt does not state its turn budget: $file"
  ! grep -Fq 'TURN_BUDGET' "$file" || fail "agent prompt kept the raw TURN_BUDGET placeholder: $file"
  grep -q '^tools: Read, Grep, Glob, Bash$' "$file" || fail "agent file lost its tool allowlist: $file"
  grep -Fq 'small change' "$file" || fail "agent file does not embed the packet diff: $file"
  grep -Fq '# Review Packet' "$file" || fail "agent file lacks the packet heading: $file"
done
# Subagents must run in the foreground: a backgrounded reviewer returns async_launched to the
# harvester and its result never reaches a checkpoint.
grep -Fxq 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1' "$SMALL_RUN/runner-args.txt.env" \
  || fail "runner was not launched with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1"
# The diff spec is persisted so findings.sh build can detect files edited under the review.
assert_json "$SMALL_RUN/launch-params.json" '.version == 1 and .diff_args == "HEAD^..HEAD"'
# The addendum is built by the launcher, not the orchestrator; with no convention documents in
# the repo and a committed-range target it says so in both sections.
[ -r "$SMALL_RUN/packet-addendum.md" ] || fail "launcher did not pre-build the packet addendum"
grep -Fq 'No project convention documents' "$SMALL_RUN/packet-addendum.md" \
  || fail "addendum does not state that no convention documents exist"
grep -Fq 'Not applicable: the target is a committed range' "$SMALL_RUN/packet-addendum.md" \
  || fail "addendum does not state that untracked files do not apply to a committed range"
grep -Fq 'is ALSO pre-built' "$SMALL_RUN/orchestrator-prompt.md" \
  || fail "orchestrator prompt does not tell the orchestrator the addendum is pre-built"
grep -Fxq -- "--add-dir" "$SMALL_RUN/runner-args.txt" \
  || fail "runner was not launched with --add-dir"
grep -Fxq -- "$SMALL_RUN/agents" "$SMALL_RUN/runner-args.txt" \
  || fail "runner --add-dir does not point at the agent directory"
! grep -Fxq -- "--agents" "$SMALL_RUN/runner-args.txt" \
  || fail "runner still receives inline --agents JSON"
for prompt in "$SMALL_RUN"/prompts/*.md; do
  grep -Fq "$SMALL_RUN/packet-addendum.md" "$prompt" \
    || fail "concretized prompt does not name the packet addendum: $prompt"
  grep -Fq 'already in your system prompt' "$prompt" \
    || fail "concretized prompt does not tell reviewers the packet is in their system prompt: $prompt"
done

# Resuming a run dir that predates the agent files rebuilds them from its packet.md.
LEGACY_RESUME_RUN="$TMP_ROOT/legacy-resume-run"
run_launcher "$LEGACY_RESUME_RUN"
rm -rf "$LEGACY_RESUME_RUN/agents" "$LEGACY_RESUME_RUN/out/orchestrator.exit" \
  "$LEGACY_RESUME_RUN/out/orchestrator.out"
(
  cd "$REPO"
  CODE_REVIEW_TEST_ARGS_FILE="$LEGACY_RESUME_RUN/runner-args.txt" \
    bash "$LAUNCHER" --resume --runner "$FAKE_RUNNER" --run-dir "$LEGACY_RESUME_RUN" >/dev/null
)
[ -r "$LEGACY_RESUME_RUN/agents/.claude/agents/reviewer.md" ] \
  || fail "resume did not rebuild missing agent definitions"
grep -Fq 'small change' "$LEGACY_RESUME_RUN/agents/.claude/agents/reviewer.md" \
  || fail "rebuilt agent definition does not embed the packet"
# A run whose agent files predate turn budgets (present but without maxTurns) is upgraded on
# resume rather than dispatching unbounded agents again.
sed -i.bak '/^maxTurns:/d' "$LEGACY_RESUME_RUN"/agents/.claude/agents/*.md
rm -f "$LEGACY_RESUME_RUN"/agents/.claude/agents/*.bak \
  "$LEGACY_RESUME_RUN/out/orchestrator.exit" "$LEGACY_RESUME_RUN/out/orchestrator.out"
(
  cd "$REPO"
  CODE_REVIEW_TEST_ARGS_FILE="$LEGACY_RESUME_RUN/runner-args.txt" \
    bash "$LAUNCHER" --resume --runner "$FAKE_RUNNER" --run-dir "$LEGACY_RESUME_RUN" >/dev/null
)
grep -q '^maxTurns: 15$' "$LEGACY_RESUME_RUN/agents/.claude/agents/verifier.md" \
  || fail "resume kept a legacy agent definition without maxTurns"

# Turn-budget overrides must be positive: maxTurns 0 would be a reviewer that can do nothing.
ZERO_BUDGET_RUN="$TMP_ROOT/zero-budget-run"
if (cd "$REPO" && CODE_REVIEW_VERIFIER_MAX_TURNS=0 bash "$LAUNCHER" --runner "$FAKE_RUNNER" \
    --run-dir "$ZERO_BUDGET_RUN" --target t --diff-args "HEAD^..HEAD" --angles correctness \
    >/dev/null 2> "$TMP_ROOT/zero-budget.err"); then
  fail "launcher accepted a zero turn budget"
fi
grep -q 'must be positive integers' "$TMP_ROOT/zero-budget.err" \
  || fail "zero turn budget rejection did not explain itself"

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

# A working-tree target's untracked files land in the addendum at launch; a small one no longer
# forces a draft plan the orchestrator has to finalize by hand.
WORKTREE_RUN="$TMP_ROOT/worktree-run"
printf '%s\n' 'untracked content' > "$REPO/untracked.txt"
printf '%s\n' 'tracked edit' >> "$REPO/example.txt"
run_launcher "$WORKTREE_RUN" "HEAD" "correctness"
assert_json "$WORKTREE_RUN/review-plan.json" '.status == "ready"'
grep -Fq '### untracked.txt (1 lines)' "$WORKTREE_RUN/packet-addendum.md" \
  || fail "addendum does not list the untracked file"
grep -Fq 'untracked content' "$WORKTREE_RUN/packet-addendum.md" \
  || fail "addendum does not embed the untracked file content"
# Untracked files are in no diff; their launch-time checksums let build detect later edits.
grep -q "^untracked.txt	$(cksum < "$REPO/untracked.txt" | cut -d' ' -f1)\$" "$WORKTREE_RUN/untracked-sums.txt" \
  || fail "launcher did not record the untracked file checksum"
rm "$REPO/untracked.txt"
git -C "$REPO" checkout -q -- example.txt

# An untracked symlink is described, never dereferenced: it can point outside the repo and the
# addendum leaves the machine.
SYMLINK_RUN="$TMP_ROOT/symlink-run"
printf '%s\n' 'SECRET-OUTSIDE-REPO' > "$TMP_ROOT/outside.txt"
ln -s "$TMP_ROOT/outside.txt" "$REPO/link.txt"
run_launcher "$SYMLINK_RUN" "HEAD" "correctness"
grep -Fq 'symbolic link to' "$SYMLINK_RUN/packet-addendum.md" \
  || fail "addendum does not describe the untracked symlink"
! grep -Fq 'SECRET-OUTSIDE-REPO' "$SYMLINK_RUN/packet-addendum.md" \
  || fail "addendum embedded the content behind an untracked symlink"
rm "$REPO/link.txt"

# Path-local conventions are found along untracked paths too, and a nested document alone is
# enough to keep the conventions angle.
UNTRACKED_CONVENTIONS_RUN="$TMP_ROOT/untracked-conventions-run"
mkdir -p "$REPO/pkg"
printf '%s\n' 'Pkg rules: no globals' > "$REPO/pkg/AGENTS.md"
git -C "$REPO" add pkg/AGENTS.md
git -C "$REPO" commit -qm "pkg rules"
printf '%s\n' 'new module' > "$REPO/pkg/new.js"
run_launcher "$UNTRACKED_CONVENTIONS_RUN" "HEAD" "correctness, conventions"
grep -Fq '### pkg/AGENTS.md' "$UNTRACKED_CONVENTIONS_RUN/packet-addendum.md" \
  || fail "addendum misses the AGENTS.md along an untracked file's path"
assert_json "$UNTRACKED_CONVENTIONS_RUN/review-plan.json" '
  .requested_angles == ["correctness", "conventions"]'
rm "$REPO/pkg/new.js"
git -C "$REPO" rm -q pkg/AGENTS.md
git -C "$REPO" commit -qm "drop pkg rules"

# A large untracked file still tips a working-tree target into a draft plan.
BIG_UNTRACKED_RUN="$TMP_ROOT/big-untracked-run"
: > "$REPO/big-untracked.txt"
line=1
while [ "$line" -le 1600 ]; do
  printf 'line %s\n' "$line" >> "$REPO/big-untracked.txt"
  line=$((line + 1))
done
run_launcher "$BIG_UNTRACKED_RUN" "HEAD" "correctness"
assert_json "$BIG_UNTRACKED_RUN/review-plan.json" '.status == "draft"'
grep -Fq '### big-untracked.txt (1600 lines, first 400 shown)' "$BIG_UNTRACKED_RUN/packet-addendum.md" \
  || fail "addendum does not cap and label a long untracked file"
rm "$REPO/big-untracked.txt"

# The conventions angle only runs when there is a convention document to cite. Without one the
# launcher drops it (and says so); with one it stays and the document travels in the addendum.
NO_CONVENTIONS_RUN="$TMP_ROOT/no-conventions-run"
run_launcher "$NO_CONVENTIONS_RUN" "HEAD^..HEAD" "correctness, conventions" 2> "$TMP_ROOT/no-conventions.err"
assert_json "$NO_CONVENTIONS_RUN/review-plan.json" '
  .requested_angles == ["correctness"] and [.tasks[].id] == ["correctness"]'
assert_json "$NO_CONVENTIONS_RUN/launch-params.json" '.requested_angles == ["correctness"]'
grep -q "angle 'conventions' skipped" "$TMP_ROOT/no-conventions.err" \
  || fail "launcher did not explain the skipped conventions angle"
grep -Fq 'conventions' "$NO_CONVENTIONS_RUN/orchestrator-prompt.md" \
  && grep -Fq 'dropped by the launcher' "$NO_CONVENTIONS_RUN/orchestrator-prompt.md" \
  || fail "orchestrator prompt does not note the dropped conventions angle"
[ ! -e "$NO_CONVENTIONS_RUN/prompts/conventions.md" ] \
  || fail "launcher concretized a prompt for the dropped conventions angle"

# Requested alone, conventions is kept even without documents: the user asked for exactly that.
ONLY_CONVENTIONS_RUN="$TMP_ROOT/only-conventions-run"
run_launcher "$ONLY_CONVENTIONS_RUN" "HEAD^..HEAD" "conventions"
assert_json "$ONLY_CONVENTIONS_RUN/review-plan.json" '.requested_angles == ["conventions"]'

WITH_CONVENTIONS_RUN="$TMP_ROOT/with-conventions-run"
printf '%s\n' '# Project rules' 'Always use tabs.' > "$REPO/CLAUDE.md"
mkdir -p "$REPO/sub"
printf '%s\n' 'Sub rules: no console.log' > "$REPO/sub/AGENTS.md"
printf '%s\n' 'inner' > "$REPO/sub/inner.txt"
git -C "$REPO" add CLAUDE.md sub/AGENTS.md sub/inner.txt
git -C "$REPO" commit -qm conventions
run_launcher "$WITH_CONVENTIONS_RUN" "HEAD^..HEAD" "correctness, conventions"
assert_json "$WITH_CONVENTIONS_RUN/review-plan.json" '
  .requested_angles == ["correctness", "conventions"]'
grep -Fq '### CLAUDE.md' "$WITH_CONVENTIONS_RUN/packet-addendum.md" \
  || fail "addendum does not include the root CLAUDE.md"
grep -Fq 'Always use tabs.' "$WITH_CONVENTIONS_RUN/packet-addendum.md" \
  || fail "addendum does not embed the CLAUDE.md content"
grep -Fq '### sub/AGENTS.md' "$WITH_CONVENTIONS_RUN/packet-addendum.md" \
  || fail "addendum does not include the AGENTS.md along a changed path"
git -C "$REPO" rm -q CLAUDE.md sub/AGENTS.md sub/inner.txt
git -C "$REPO" commit -qm "drop conventions"

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
