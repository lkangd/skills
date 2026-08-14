#!/usr/bin/env bash
# Persist completed reviewer/verifier Agent results directly from a Claude session transcript.
# This runs beside the orchestrator process so one failed tool call cannot strand the other
# completed results behind the parent model's tool-call barrier.
set -u

usage() {
  echo "usage: harvest-checkpoints.sh --run-dir DIR (--session-id ID | --transcript FILE) [--watch --parent-pid PID]" >&2
  exit 2
}

die() { echo "harvest-checkpoints.sh: $1" >&2; exit 1; }

RUN_DIR=""
SESSION_ID=""
TRANSCRIPT=""
WATCH=0
PARENT_PID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run-dir) [ $# -ge 2 ] || usage; RUN_DIR="$2"; shift 2 ;;
    --session-id) [ $# -ge 2 ] || usage; SESSION_ID="$2"; shift 2 ;;
    --transcript) [ $# -ge 2 ] || usage; TRANSCRIPT="$2"; shift 2 ;;
    --watch) WATCH=1; shift ;;
    --parent-pid) [ $# -ge 2 ] || usage; PARENT_PID="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$RUN_DIR" ] || usage
[ -n "$SESSION_ID" ] || [ -n "$TRANSCRIPT" ] || usage
[ "$WATCH" = "0" ] || [ -n "$PARENT_PID" ] || usage
command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

RUN_DIR_ARG="$RUN_DIR"
RUN_DIR="$(cd "$RUN_DIR" 2>/dev/null && pwd -P)" || die "no such run dir: $RUN_DIR_ARG"
OUTDIR="$RUN_DIR/out"
PLAN="$RUN_DIR/review-plan.json"
TRANSCRIPT_ROOT="${CODE_REVIEW_TRANSCRIPT_ROOT:-$HOME/.claude/projects}"
MAP_FILE="$OUTDIR/.checkpoint-tool-map-${SESSION_ID:-manual}.tsv"
NEXT_LINE=1
[ -d "$OUTDIR" ] || die "not a run dir (no out/): $RUN_DIR"
: > "$MAP_FILE" || die "cannot initialize tool map: $MAP_FILE"

find_transcript() {
  local candidate
  [ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ] && return 0
  [ -n "$SESSION_ID" ] || return 1
  candidate="$(find "$TRANSCRIPT_ROOT" -name "$SESSION_ID.jsonl" -type f -print -quit 2>/dev/null)"
  [ -n "$candidate" ] || return 1
  TRANSCRIPT="$candidate"
}

mapping_for_tool() {
  local wanted="$1" tool_id kind key
  while IFS=$'\t' read -r tool_id kind key; do
    if [ "$tool_id" = "$wanted" ]; then
      printf '%s\t%s\n' "$kind" "$key"
      return 0
    fi
  done < "$MAP_FILE"
  return 1
}

remember_dispatches() {
  local line="$1" tool_id prompt suffix key existing
  while IFS=$'\t' read -r tool_id prompt; do
    [ -n "$tool_id" ] && [ -n "$prompt" ] || continue
    if existing="$(mapping_for_tool "$tool_id")"; then
      continue
    fi
    case "$prompt" in
      *"$RUN_DIR/prompts/"*.md*)
        suffix="${prompt#*"$RUN_DIR/prompts/"}"
        key="${suffix%%.md*}"
        case "$key" in ''|*[!a-z0-9-]*) continue ;; esac
        jq -e --arg id "$key" '.tasks | any(.id == $id)' "$PLAN" >/dev/null 2>&1 || continue
        printf '%s\tcandidate\t%s\n' "$tool_id" "$key" >> "$MAP_FILE"
        ;;
      *"$RUN_DIR/out/verify-input-"*.json*)
        suffix="${prompt#*"$RUN_DIR/out/verify-input-"}"
        key="${suffix%%.json*}"
        case "$key" in ''|*[!0-9]*) continue ;; esac
        [ -r "$OUTDIR/verify-input-$key.json" ] || continue
        printf '%s\tverdict\t%s\n' "$tool_id" "$key" >> "$MAP_FILE"
        ;;
    esac
  done <<EOF
$(printf '%s\n' "$line" | jq -r '
  select((.message.content? | type) == "array")
  | .message.content[]
  | select(.type == "tool_use" and .name == "Agent")
  | [ .id, (.input.prompt // "") ] | @tsv
')
EOF
}

payload_from_event() {
  local event="$1"
  printf '%s\n' "$event" | jq -c '
    .text
    | split("\n")
    | reduce .[] as $line ({inside: false, done: false, lines: []};
        if .done then .
        elif (.inside | not) and $line == "```json" then .inside = true
        elif .inside and $line == "```" then .inside = false | .done = true
        elif .inside then .lines += [$line]
        else . end)
    | if .done then (.lines | join("\n") | fromjson?) else empty end
  '
}

checkpoint_is_valid() {
  local destination="$1" kind="$2" key="$3" expected_indices
  [ -r "$destination" ] || return 1
  if [ "$kind" = "candidate" ]; then
    jq -e 'type == "object" and .status == "completed"
           and (.findings | type) == "array"
           and all(.findings[]; type == "object")' \
      "$destination" >/dev/null 2>&1
  else
    expected_indices="$(jq -ce '
      if type == "array" and all(.[]; type == "object" and (.index | type) == "number")
      then [.[].index] | sort
      else error("invalid verifier input") end' "$OUTDIR/verify-input-$key.json" 2>/dev/null)" \
      || return 1
    jq -e --argjson expected_indices "$expected_indices" '
      type == "array"
      and all(.[]; type == "object"
                   and (.index | type) == "number"
                   and (.verdict == "CONFIRMED" or .verdict == "PLAUSIBLE"
                        or .verdict == "REFUTED")
                   and (.evidence | type) == "string")
      and ([.[].index] | sort) == $expected_indices' \
      "$destination" >/dev/null 2>&1
  fi
}

install_payload() {
  local payload="$1" destination="$2" kind="$3" key="$4" temp="$destination.tmp.$$"
  checkpoint_is_valid "$destination" "$kind" "$key" && return 0
  printf '%s\n' "$payload" | jq --indent 1 . > "$temp" \
    || { rm -f "$temp"; return 2; }
  checkpoint_is_valid "$temp" "$kind" "$key" \
    || { rm -f "$temp"; return 2; }
  if checkpoint_is_valid "$destination" "$kind" "$key"; then
    rm -f "$temp"
    return 0
  fi
  [ ! -e "$destination" ] || mv "$destination" "$destination.invalid.$$" || return 1
  mv "$temp" "$destination" || { rm -f "$temp"; return 1; }
  printf 'checkpointed %s %s\n' "$kind" "$(basename "$destination")"
}

harvest_results() {
  local line="$1" event tool_id mapping kind key destination payload install_status
  while IFS= read -r event; do
    [ -n "$event" ] || continue
    tool_id="$(printf '%s\n' "$event" | jq -r '.tool_id')"
    mapping="$(mapping_for_tool "$tool_id")" || continue
    kind="${mapping%%$'\t'*}"
    key="${mapping#*$'\t'}"
    if [ "$kind" = "candidate" ]; then
      destination="$OUTDIR/candidates-$key.json"
    else
      destination="$OUTDIR/verdicts-$key.json"
    fi
    checkpoint_is_valid "$destination" "$kind" "$key" && continue
    payload="$(payload_from_event "$event")"
    [ -n "$payload" ] || continue
    install_payload "$payload" "$destination" "$kind" "$key" || {
      install_status=$?
      [ "$install_status" = "2" ] && continue
      die "cannot install checkpoint: $destination"
    }
  done <<EOF
$(printf '%s\n' "$line" | jq -c '
  def text_content:
    if type == "string" then .
    elif type == "array" then [ .[] | select(.type == "text") | .text ] | join("\n")
    else "" end;
  select((.message.content? | type) == "array")
  | .message.content[]
  | select(.type == "tool_result")
  | {tool_id: .tool_use_id, text: (.content | text_content)}
')
EOF
}

process_line() {
  local line="$1"
  remember_dispatches "$line"
  harvest_results "$line"
}

scan_new_lines() {
  local complete_lines count start
  find_transcript || return 0
  complete_lines="$(wc -l < "$TRANSCRIPT" | tr -d ' ')"
  [ "$complete_lines" -ge "$NEXT_LINE" ] || return 0
  start="$NEXT_LINE"
  count=$((complete_lines - NEXT_LINE + 1))
  NEXT_LINE=$((complete_lines + 1))
  tail -n +"$start" "$TRANSCRIPT" | head -n "$count" \
    | while IFS= read -r line; do process_line "$line"; done
}

if [ "$WATCH" = "0" ]; then
  scan_new_lines || exit 1
  exit 0
fi

while kill -0 "$PARENT_PID" 2>/dev/null; do
  scan_new_lines || exit 1
  sleep 0.2
done
scan_new_lines || exit 1
