#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
HARVESTER="$SCRIPT_DIR/harvest-checkpoints.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/code-review-harvester.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

RUN_DIR="$TMP_ROOT/run"
TRANSCRIPT_ROOT="$TMP_ROOT/projects"
SESSION_ID="11111111-2222-3333-4444-555555555555"
TRANSCRIPT="$TRANSCRIPT_ROOT/project/$SESSION_ID.jsonl"
mkdir -p "$RUN_DIR/out" "$RUN_DIR/prompts" "$(dirname "$TRANSCRIPT")"
RUN_DIR="$(cd "$RUN_DIR" && pwd -P)"
: > "$RUN_DIR/prompts/correctness.md"
: > "$RUN_DIR/prompts/reuse.md"
printf '%s\n' '[{"index":1}]' > "$RUN_DIR/out/verify-input-1.json"
jq -n '{
  version: 2,
  status: "ready",
  requested_angles: ["correctness", "reuse"],
  late_waves: [],
  tasks: [
    {id: "correctness", angle: "correctness", wave: 1},
    {id: "reuse", angle: "reuse", wave: 1}
  ]
}' > "$RUN_DIR/review-plan.json"
printf '%s\n' '{"status":"completed","findings":[1]}' \
  > "$RUN_DIR/out/candidates-correctness.json"
printf '%s\n' '[{"index":99,"verdict":"CONFIRMED","evidence":"stale"}]' \
  > "$RUN_DIR/out/verdicts-1.json"

jq -cn --arg prompt "Read and execute the instructions in $RUN_DIR/prompts/correctness.md." '{
  type: "assistant",
  message: {content: [{type: "tool_use", id: "call-review", name: "Agent",
                       input: {description: "review correctness", prompt: $prompt}}]}
}' > "$TRANSCRIPT"
jq -cn --arg prompt "Verify $RUN_DIR/out/verify-input-1.json against the packet." '{
  type: "assistant",
  message: {content: [{type: "tool_use", id: "call-verifier", name: "Agent",
                       input: {description: "verify batch", prompt: $prompt}}]}
}' >> "$TRANSCRIPT"
jq -cn --arg prompt "Read and execute the instructions in $RUN_DIR/prompts/reuse.md." '{
  type: "assistant",
  message: {content: [{type: "tool_use", id: "call-failed", name: "Agent",
                       input: {description: "review reuse", prompt: $prompt}}]}
}' >> "$TRANSCRIPT"

sleep 2 &
PARENT_PID=$!
CODE_REVIEW_TRANSCRIPT_ROOT="$TRANSCRIPT_ROOT" \
  bash "$HARVESTER" --watch --parent-pid "$PARENT_PID" \
    --session-id "$SESSION_ID" --run-dir "$RUN_DIR" &
HARVESTER_PID=$!

jq -cn --arg text '```json
{"status":"completed","findings":[]}
```
<usage>done</usage>' '{
  type: "user",
  message: {content: [{type: "tool_result", tool_use_id: "call-review",
                       content: [{type: "text", text: $text}]}]}
}' >> "$TRANSCRIPT"
jq -cn --arg text '```json
[{"index":1,"verdict":"CONFIRMED","evidence":"verified"}]
```' '{
  type: "user",
  message: {content: [{type: "tool_result", tool_use_id: "call-verifier",
                       content: [{type: "text", text: $text}]}]}
}' >> "$TRANSCRIPT"
jq -cn '{
  type: "user",
  message: {content: [{type: "tool_result", tool_use_id: "call-failed",
                       content: "Agent terminated early due to an API error"}]}
}' >> "$TRANSCRIPT"

attempt=0
while [ "$attempt" -lt 30 ]; do
  if jq -e '.status == "completed" and .findings == []' \
      "$RUN_DIR/out/candidates-correctness.json" >/dev/null 2>&1 \
    && jq -e 'length == 1 and .[0].index == 1 and .[0].verdict == "CONFIRMED"' \
      "$RUN_DIR/out/verdicts-1.json" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
  attempt=$((attempt + 1))
done
kill "$PARENT_PID" 2>/dev/null || true
wait "$PARENT_PID" 2>/dev/null || true
wait "$HARVESTER_PID"

jq -e '.status == "completed" and .findings == []' \
  "$RUN_DIR/out/candidates-correctness.json" >/dev/null \
  || fail "completed reviewer result was not checkpointed"
jq -e 'length == 1 and .[0].index == 1 and .[0].verdict == "CONFIRMED"' \
  "$RUN_DIR/out/verdicts-1.json" >/dev/null \
  || fail "completed verifier result was not checkpointed"
[ ! -e "$RUN_DIR/out/candidates-reuse.json" ] \
  || fail "failed reviewer result was checkpointed"

printf 'ok - transcript harvester checkpoints completed agents independently\n'
