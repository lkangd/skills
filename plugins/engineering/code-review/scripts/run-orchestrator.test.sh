#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/run-orchestrator.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/code-review-launcher.XXXXXX")"
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
  (
    cd "$REPO"
    bash "$LAUNCHER" \
      --runner "$FAKE_RUNNER" \
      --run-dir "$run_dir" \
      --target "test diff" \
      --diff-args "HEAD" \
      --angles "correctness, callers" \
      --concurrency 0 >/dev/null
  )
}

printf '%s\n' 'small change' >> "$REPO/example.txt"
SMALL_RUN="$TMP_ROOT/small-run"
run_launcher "$SMALL_RUN"
assert_json "$SMALL_RUN/review-plan.json" '
  .version == 1 and .status == "ready"
  and .requested_angles == ["correctness", "callers"]
  and [.tasks[].id] == ["correctness", "callers"]
  and all(.tasks[]; (.prompt | startswith("/")) and (.angle | type == "string"))'
while IFS= read -r prompt; do
  [ -r "$prompt" ] || fail "small-diff plan references a missing prompt: $prompt"
done <<EOF
$(jq -r '.tasks[].prompt' "$SMALL_RUN/review-plan.json")
EOF
assert_json "$SMALL_RUN/out/orchestrator.exit" '. == 0'

# Restore the tracked file, then create a diff whose unified form exceeds the split threshold.
git -C "$REPO" checkout -q -- example.txt
: > "$REPO/large.txt"
line=1
while [ "$line" -le 1600 ]; do
  printf 'line %s\n' "$line" >> "$REPO/large.txt"
  line=$((line + 1))
done
git -C "$REPO" add large.txt
LARGE_RUN="$TMP_ROOT/large-run"
run_launcher "$LARGE_RUN"
assert_json "$LARGE_RUN/review-plan.json" '
  .version == 1 and .status == "draft"
  and .requested_angles == ["correctness", "callers"]
  and [.tasks[].id] == ["correctness", "callers"]'
if bash "$SCRIPT_DIR/findings.sh" pending --run-dir "$LARGE_RUN" \
  >/dev/null 2> "$LARGE_RUN/pending.err"; then
  fail "pending accepted the launcher draft plan before slicing"
fi
grep -q 'review plan is not ready' "$LARGE_RUN/pending.err" \
  || fail "draft plan rejection did not explain that slicing must finish"

printf 'ok - launcher persists ready and draft review plans\n'
