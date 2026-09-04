#!/usr/bin/env bash
# Mechanical parts of the orchestrator's Step 3 and Step 4.
#
# Normalizing paths, numbering candidates, splitting them into verifier batches and joining
# verdicts back onto candidates is bookkeeping, not judgement — but an orchestrator doing it
# by hand re-emits every candidate object as tool input twice (once to number them, once to
# batch them) and then hand-picks the survivors for findings.json. Measured on a real
# adversarial round: 15 minutes of wall time with no subagent running, a single 5-minute turn
# spent assigning 38 candidates to 7 buckets, and a findings.json truncated to 12 entries
# because the model was writing the merge as a literal index list. This script does the same
# work deterministically and for free.
#
# usage: findings.sh pending --run-dir DIR
#          Compare review-plan.json with out/candidates-*.json and print a JSON array of task
#          IDs that do not yet have a valid completed receipt. An empty findings array still
#          completes a task.
#
#        findings.sh prepare --run-dir DIR [--batch-size N] [--drop 3,7] [--verify-all]
#          Validate that every planned review task has a completed receipt, collect the
#          findings, normalize each `file` against the packet's changed-file list, number the
#          candidates, merge literal repeats (same file, line, title), and write
#          out/normalized-candidates.json plus out/verify-input-<n>.json batches. Candidates
#          from cleanup angles (reuse, simplification, efficiency, altitude, cleanup) are not
#          batched: they pass through to the report marked unverified, unless --verify-all.
#          Prints a compact summary and, when candidates cluster on nearby lines of one file,
#          a duplicate report to act on with --drop.
#
#          Re-running is safe and incremental: candidates already numbered keep their index,
#          batches whose verdicts-<n>.json already exists are left alone, and only unverified
#          candidates are re-batched. That is what makes the Step 3.5 sweep (a new candidates
#          file arriving after the first verification wave), a --drop correction, and a resume
#          all work without invalidating verdicts already collected.
#
#        findings.sh build --run-dir DIR
#          Join out/verdicts-*.json onto the normalized candidates, drop REFUTED and
#          unverified ones, append the cleanup pass-throughs (verdict PLAUSIBLE, `unverified`
#          true), mark findings whose file changed since launch (`stale` true), order the
#          survivors, and write out/findings.json. Prints the numbers the orchestrator's stats
#          line needs.
#
# Exit codes: 0 ok (including a round where nothing was found), 1 usage/IO error, 2 a
# pipeline step was skipped (build before any verdicts exist).
#
# set -e omitted on purpose: the jq pipelines below are checked individually so a failure
# reports which stage broke rather than exiting silently.
set -u

die() { echo "findings.sh: $1" >&2; exit "${2:-1}"; }

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)" || die "cannot resolve plugin root"
# shellcheck source=review-plan.sh
. "$PLUGIN_ROOT/scripts/review-plan.sh" || die "cannot load the review-plan schema helper"

# jq helpers shared by both subcommands. Two things need care against the Python reference
# these were ported from: jq's sort_by breaks ties by comparing the values themselves, where
# Python's sort is stable, so every sort here carries an explicit position tiebreaker; and
# group_by sorts groups by key, where Python dict iteration preserves first-appearance order,
# so grouping is done by hand.
JQ_LIB='
def sevrank: {"critical":0,"major":1,"minor":2,"nit":3}[.] // 9;

def lineof:
  (.line // 0) as $l
  | if ($l|type) == "number" then ($l|trunc)
    elif ($l|type) == "string" and ($l|test("^[+-]?[0-9]+$")) then ($l|tonumber|trunc)
    else 0 end;

def isbug:
  . as $a
  | ["correctness","removed-behavior","callers","pitfalls","wrapper","design","spec","re-review","sweep"]
  | index($a) != null;

# Cleanup angles report a maintenance cost, not a defect, and a verifier can rarely refute a
# cost claim from the code (observed: 7% REFUTED across 458 cleanup candidates, against half of
# all verifier time and tokens). Their candidates skip verification by default and reach the
# report marked as unverified; `prepare --verify-all` restores the old behaviour. conventions
# is deliberately not here: a quoted rule is checkable, and verifiers do catch misquotes.
def iscleanup:
  . as $a
  | ["reuse","simplification","efficiency","altitude","cleanup"]
  | index($a) != null;

# Two candidates are the same report when they name the same file, the same line and the same
# title up to case/punctuation. Different angles seeing the same defect word it differently,
# so this only catches the literal repeats — the judgement call stays with --drop. Letters and
# digits of every script are kept: reviews are often written in Chinese, and an ASCII-only
# class would fold every such title to "" and merge distinct findings.
def dupkey:
  [ ((.file // "") | tostring), lineof,
    ((.title // "") | tostring | ascii_downcase | gsub("[^\\p{L}\\p{N}]+"; "")) ] | tojson;

# Identity used to carry an index across prepare runs. Two receipts from one angle can repeat
# a finding verbatim, so the key carries an occurrence ordinal: the n-th identical candidate
# maps to the n-th index handed out for that key, never to the same index twice.
def idkey: [(.angle // null), (.file // null), lineof, (.title // null)] | tojson;
def with_occurrence:
  reduce .[] as $c ({seen: {}, out: []};
    ($c | idkey) as $k
    | (.seen[$k] // 0) as $n
    | .seen[$k] = $n + 1
    | .out += [$c + {__key: ($k + "#" + ($n | tostring))}])
  | .out;

# Most severe first, bug-hunting angles ahead of cleanup at equal severity, then file/line.
def orderkey:
  [ (.severity // "" | sevrank),
    (if ((.angle // "") | isbug) then 0 else 1 end),
    ((.file // "") | tostring),
    lineof ];

# Group preserving first-appearance order of the keys.
def group_ordered(keyf):
  (reduce .[] as $x ({order: [], m: {}};
     ($x | keyf | tostring) as $k
     | if (.m | has($k)) then (.m[$k] += [$x])
       else (.order += [$k] | .m[$k] = [$x]) end)) as $g
  | [ $g.order[] | {key: ., items: $g.m[.]} ];
'

# ---------------------------------------------------------------- shared collection

# Repo-relative paths from the packet's `git diff --stat` output, longest first. Reviewers
# cite files inconsistently (absolute, repo-relative, bare basename); grouping and the final
# report need one spelling per file, and --stat is the authority on it.
changed_files_json() {
  local stat="$RUN_DIR/diff-stat.txt"
  if [ ! -r "$stat" ]; then echo '[]'; return 0; fi
  # The trailing "N files changed, …" summary has no "|" and is skipped.
  awk -F'|' 'NF > 1 {
    name = $0; sub(/\|[^|]*$/, "", name)
    gsub(/^[ \t]+|[ \t]+$/, "", name)
    if (name ~ /=>/) {
      gsub(/\{[^}]*=>[ \t]*/, "", name); gsub(/\}/, "", name)
      if (name ~ /=>/) { sub(/^.*=>[ \t]*/, "", name); gsub(/^[ \t]+|[ \t]+$/, "", name) }
      gsub(/\/\//, "/", name)
    }
    if (name != "") printf "%d\t%s\n", length(name), name
  }' "$stat" | sort -s -k1,1nr | cut -f2- | jq -R . | jq -s .
}

requested_angles_from_launch() {
  local launch_params="$RUN_DIR/launch-params.json" launch_prompt="$RUN_DIR/orchestrator-prompt.md"
  local angles requested='[]' angle
  if [ -r "$launch_params" ]; then
    jq -ce 'if type == "object" and .version == 1 and (.requested_angles | type) == "array"
        and all(.requested_angles[]; type == "string")
      then .requested_angles else error("invalid launch parameters") end' "$launch_params"
    return
  fi
  [ -r "$launch_prompt" ] || return 1
  angles="$(sed -n 's/^- Angles this round: //p' "$launch_prompt" | head -1)"
  [ -n "$angles" ] || return 1
  IFS=',' read -ra LAUNCH_ANGLES <<< "$angles"
  for angle in "${LAUNCH_ANGLES[@]}"; do
    angle="${angle//[[:space:]]/}"
    [ -n "$angle" ] || continue
    requested="$(jq -cn --argjson angles "$requested" --arg angle "$angle" \
      '$angles + [$angle]')" || return 1
  done
  printf '%s\n' "$requested"
}

known_angles_json() {
  local prompt
  for prompt in "$PLUGIN_ROOT"/references/angles/*.md; do
    [ -e "$prompt" ] || continue
    basename "$prompt" .md
  done | jq -R . | jq -s .
}

# A run that predates review-plan.json: rebuild the plan the launcher would have written from
# the launch metadata it did persist. Sliced runs fail closed — their slice scope only ever
# existed in the dead session's context.
migrate_legacy_plan() {
  local requested tasks late_waves='[]' status='ready' angle f document
  requested="$(requested_angles_from_launch)" \
    || die "review-plan.json missing and launch metadata is unavailable"

  while IFS= read -r angle; do
    [ -n "$angle" ] || continue
    for f in "$OUTDIR/candidates-$angle-"[0-9]*.json; do
      [ -e "$f" ] || continue
      die "legacy sliced checkpoints cannot be migrated safely — resume with the plugin version that created this run"
    done
    [ -r "$RUN_DIR/prompts/$angle.md" ] \
      || die "legacy angle prompt missing: $RUN_DIR/prompts/$angle.md"
  done <<EOF
$(printf '%s' "$requested" | jq -r '.[]')
EOF

  tasks="$(review_plan_tasks "$requested" 1)" || die "cannot migrate review tasks"
  if [ -e "$OUTDIR/candidates-sweep.json" ]; then
    [ -r "$RUN_DIR/prompts/sweep.md" ] || die "legacy sweep checkpoint has no prompt: $RUN_DIR/prompts/sweep.md"
    late_waves='[{"wave":2,"angles":["sweep"]}]'
    tasks="$(jq -cn --argjson tasks "$tasks" --argjson late "$(review_plan_tasks '["sweep"]' 2)" \
      '$tasks + $late')" || die "cannot migrate the late review wave"
  fi
  if ! compgen -G "$OUTDIR/candidates-*.json" >/dev/null \
    && [ -r "$RUN_DIR/raw_diff.txt" ] \
    && [ "$(wc -l < "$RUN_DIR/raw_diff.txt" | tr -d ' ')" -gt 1500 ]; then
    status='draft'
  fi
  document="$(review_plan_document "$status" "$requested" "$late_waves" "$tasks")" \
    || die "cannot write migrated review plan"
  review_plan_install "$document" "$RUN_DIR/review-plan.json" \
    || die "cannot install migrated review plan"
}

# Version 1 stored each task's prompt path and named the post-verification sweep explicitly.
# The path is the one thing version 2 drops, so verify it against the canonical derivation
# once here; after that the plan on disk carries no path to drift.
upgrade_plan_v1() {
  local parsed task_id prompt expected physical expected_physical
  local requested late_angles late_waves='[]' tasks document
  parsed="$(jq -ce '
    if type != "object" or .version != 1 then error("expected review plan version 1")
    elif (.status | type) != "string" then error("expected a plan status")
    elif (.requested_angles | type) != "array" then error("expected a requested_angles array")
    elif (.tasks | type) != "array" then error("expected a tasks array")
    elif any(.tasks[]; ((.id | type) != "string") or ((.angle | type) != "string")
                       or ((.prompt | type) != "string"))
      then error("every version 1 task needs id, angle and prompt strings")
    else . end' "$RUN_DIR/review-plan.json")" || die "cannot parse $RUN_DIR/review-plan.json"

  while IFS=$'\t' read -r task_id prompt; do
    [ -n "$task_id" ] || continue
    expected="$RUN_DIR/prompts/$task_id.md"
    [ "$prompt" != "$expected" ] || continue
    # Same file reached through a symlinked run dir is the same prompt.
    physical="$(cd "$(dirname "$prompt")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$prompt")")" \
      || die "cannot resolve review task prompt: $prompt"
    expected_physical="$(cd "$(dirname "$expected")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$expected")")" \
      || die "cannot resolve expected review task prompt: $expected"
    [ "$physical" = "$expected_physical" ] \
      || die "review task prompt must match its task ID: $task_id"
  done <<EOF
$(printf '%s' "$parsed" | jq -r '.tasks[] | [.id, .prompt] | @tsv')
EOF

  requested="$(printf '%s' "$parsed" | jq -c '.requested_angles')"
  # The sweep was the only version 1 task allowed to sit outside requested_angles, and it only
  # ever ran after the first wave — exactly what wave 2 now means.
  late_angles="$(printf '%s' "$parsed" | jq -c \
    '.requested_angles as $requested
     | [.tasks[].angle | . as $angle | select(($requested | index($angle)) == null)] | unique')" \
    || die "cannot upgrade $RUN_DIR/review-plan.json"
  tasks="$(printf '%s' "$parsed" | jq -c \
    '.requested_angles as $requested
     | [.tasks[] | . as $t
        | {id, angle, wave: (if ($requested | index($t.angle)) == null then 2 else 1 end)}]')" \
    || die "cannot upgrade $RUN_DIR/review-plan.json"
  if [ "$late_angles" != "[]" ]; then
    late_waves="$(jq -cn --argjson angles "$late_angles" '[{wave: 2, angles: $angles}]')" \
      || die "cannot upgrade $RUN_DIR/review-plan.json"
  fi
  document="$(review_plan_document \
    "$(printf '%s' "$parsed" | jq -r '.status')" "$requested" "$late_waves" "$tasks")" \
    || die "cannot write the upgraded review plan"
  review_plan_install "$document" "$RUN_DIR/review-plan.json" \
    || die "cannot install the upgraded review plan"
}

# Everything structural in one jq pass. The version 1 validator walked the plan with a jq call
# per task per field, which made the cost of a check its own argument against adding one.
PLAN_JQ='
def known_angle: . as $angle | $known_angles | index($angle) != null;
# A task either covers its whole angle or is slice N of it. This is the only rule about task
# IDs: the sweep is not a special name here, just a task on a late wave angle.
def task_id_ok($angle):
  . == $angle
  or (startswith($angle + "-") and (.[($angle | length) + 1:] | test("^[1-9][0-9]*$")));

if type != "object" or .version != 2
  then error("expected review plan version 2")
elif (.status | type) != "string"
  then error("expected a plan status")
elif (.requested_angles | type) != "array" or (.requested_angles | length) == 0
  then error("expected a non-empty requested_angles array")
elif (.requested_angles | length) != (.requested_angles | unique | length)
  then error("requested angles must be unique")
elif any(.requested_angles[]; (type != "string") or (known_angle | not))
  then error("requested_angles contains an unknown angle")
elif (.late_waves | type) != "array"
  then error("expected a late_waves array")
elif any(.late_waves[];
      (type != "object")
      or ((.wave | type) != "number") or ((.wave | floor) != .wave) or (.wave < 2)
      or ((.angles | type) != "array") or ((.angles | length) == 0)
      or any(.angles[]; (type != "string") or (known_angle | not)))
  then error("late_waves must declare an integer wave above 1 with known angles")
elif ([.late_waves[].wave] | length) != ([.late_waves[].wave] | unique | length)
  then error("late wave numbers must be unique")
elif (.requested_angles - [.late_waves[].angles[]]) != .requested_angles
  then error("requested_angles must not contain a late-wave angle")
elif (.tasks | type) != "array" or (.tasks | length) == 0
  then error("expected a non-empty tasks array")
elif .status != "ready"
  then error("review plan is not ready — finalize slicing before dispatch")
elif ([.tasks[].id] | length) != ([.tasks[].id] | unique | length)
  then error("task IDs must be unique")
elif any(.tasks[]; ((.id | type) != "string") or ((.id | test("^[a-z0-9][a-z0-9-]*$")) | not))
  then error("task IDs must be lowercase kebab-case")
elif any(.tasks[]; ((.angle | type) != "string") or ((.angle | known_angle) | not))
  then error("tasks contains an unknown angle")
elif any(.tasks[]; ((.wave | type) != "number") or ((.wave | floor) != .wave) or (.wave < 1))
  then error("every task needs an integer wave of 1 or more")
else . end

| . as $plan
| ([$plan.late_waves[] | {key: (.wave | tostring), value: .angles}] | from_entries) as $late
| ([ $plan.tasks[] | . as $t
     | select($t.wave == 1 and (($plan.requested_angles | index($t.angle)) == null)) ] | first) as $unrequested
| if $unrequested != null
  then error("review task angle was not requested: \($unrequested.angle)") else . end
| ([ $plan.tasks[] | . as $t
     | select($t.wave > 1 and ((($late[$t.wave | tostring] // []) | index($t.angle)) == null)) ] | first) as $undeclared
| if $undeclared != null
  then error("review task angle is not declared for wave \($undeclared.wave): \($undeclared.angle)")
  else . end
| ([ $plan.tasks[] | select(. as $t | ($t.id | task_id_ok($t.angle)) | not) ] | first) as $mislabeled
| if $mislabeled != null
  then error("review task ID does not match its angle: \($mislabeled.id) -> \($mislabeled.angle)")
  else . end
# First-wave completeness stands on its own: a late wave has no tasks until its inputs exist.
| ([ $plan.requested_angles[]
     | . as $angle
     | select(([ $plan.tasks[] | select(.wave == 1 and .angle == $angle) ] | length) == 0) ] | first) as $uncovered
| if $uncovered != null
  then error("review plan does not cover requested angle: \($uncovered)") else . end
| ([ $plan.tasks | group_by([.wave, .angle])[] | . as $group
     | select(($group | length) > 1 and (([$group[].id] | index($group[0].angle)) != null))
     | $group[0].angle ] | first) as $mixed
| if $mixed != null
  then error("review plan mixes base and sliced tasks for angle: \($mixed)") else . end
| $plan
'

review_plan_json() {
  local plan="$RUN_DIR/review-plan.json" parsed version task_id
  local launch_requested plan_requested
  [ -r "$plan" ] || migrate_legacy_plan
  version="$(jq -r 'if type == "object" then (.version | tostring) else "unknown" end' "$plan")" \
    || die "cannot parse $plan"
  [ "$version" != "1" ] || upgrade_plan_v1
  parsed="$(jq -c --argjson known_angles "$(known_angles_json)" "$PLAN_JQ" "$plan")" \
    || die "cannot parse $plan"

  if [ -r "$RUN_DIR/launch-params.json" ]; then
    launch_requested="$(requested_angles_from_launch)" \
      || die "cannot parse $RUN_DIR/launch-params.json"
  elif ! launch_requested="$(requested_angles_from_launch)"; then
    launch_requested=""
  fi
  if [ -n "$launch_requested" ]; then
    plan_requested="$(printf '%s' "$parsed" | jq -c '.requested_angles')"
    [ "$plan_requested" = "$launch_requested" ] \
      || die "review plan requested_angles do not match the persisted launch angles"
  fi

  # The one plan fact the filesystem owns: a task's prompt is RUN_DIR/prompts/<id>.md, and a
  # missing one is a corrupt run dir, not work to improvise.
  while IFS= read -r task_id; do
    [ -n "$task_id" ] || continue
    [ -r "$RUN_DIR/prompts/$task_id.md" ] \
      || die "review task prompt missing: $RUN_DIR/prompts/$task_id.md"
  done <<EOF
$(printf '%s' "$parsed" | jq -r '.tasks[].id')
EOF
  printf '%s\n' "$parsed"
}

# One completed receipt, tagged with the angle of the task that produced it. New checkpoints are
# {"status":"completed","findings":[...]}; legacy bare arrays remain readable so interrupted
# runs created before the receipt protocol can still resume.
receipt_payload_json() {
  local file="$1" angle="$2" filter payload first_error
  filter='
    (if type == "array" then .
     elif type == "object" and .status == "completed" and (.findings | type) == "array"
       then .findings
     else error("not a completed review receipt") end) as $findings
    | if any($findings[]; type != "object")
      then error("review findings must be objects")
      else {angle: $angle, findings: $findings} end'
  if first_error="$(jq -c --arg angle "$angle" "$filter" "$file" 2>&1)"; then
    printf '%s\n' "$first_error"
    return 0
  fi

  payload="$(awk '
    BEGIN { inside = 0; seen = 0 }
    /^```json[[:space:]]*$/ && seen == 0 { inside = 1; seen = 1; next }
    /^```[[:space:]]*$/ && inside == 1 { inside = 0; exit }
    inside == 1 { print }
  ' "$file")"
  if [ -n "$payload" ]; then
    printf '%s\n' "$payload" | jq -c --arg angle "$angle" "$filter"
  else
    printf '%s\n' "$first_error" >&2
    return 1
  fi
}

# Walk the plan once and answer both questions every command asks of it: which tasks are still
# pending, and what the finished ones found. Splitting those into separate passes meant parsing
# each receipt twice per command, and left completion checking able to disagree with collection
# about the same file.
PLAN_PENDING='[]'
PLAN_CANDIDATES='[]'
collect_receipts() {
  local plan="$1" task_id angle receipt payload pending='' payloads='' f orphan_id
  for f in "$OUTDIR"/candidates-*.json; do
    [ -e "$f" ] || continue
    orphan_id="$(basename "$f")"
    orphan_id="${orphan_id#candidates-}"
    orphan_id="${orphan_id%.json}"
    printf '%s' "$plan" | jq -e --arg id "$orphan_id" '.tasks | any(.id == $id)' >/dev/null \
      || die "checkpoint is not listed in review-plan.json: $f"
  done

  while IFS=$'\t' read -r task_id angle; do
    [ -n "$task_id" ] || continue
    receipt="$OUTDIR/candidates-$task_id.json"
    if [ -r "$receipt" ] && payload="$(receipt_payload_json "$receipt" "$angle" 2>/dev/null)"; then
      payloads="$payloads$payload
"
    else
      pending="$pending$task_id
"
    fi
  done <<EOF
$(printf '%s' "$plan" | jq -r '.tasks[] | [.id, .angle] | @tsv')
EOF

  PLAN_PENDING="$(printf '%s' "$pending" | jq -R . | jq -s .)" \
    || die "cannot collect pending review tasks"
  # Reviewers cite files inconsistently (absolute, repo-relative, bare basename) and only the
  # packet's --stat list is authoritative, so every collected `file` is normalized here — once
  # for the whole round rather than once per receipt.
  PLAN_CANDIDATES="$(printf '%s' "$payloads" | jq -sc --argjson known "$KNOWN_JSON" '
    [ .[]
      | .angle as $angle
      | .findings[]
      | .angle = $angle
      | .file = (
          (.file // null) as $v
          | if ($v | type) != "string" or $v == "" then $v
            # Only a literal "./" prefix is stripped: "^[./]+" also ate the dot of a dotfile
            # directory (".claude/x" became "claude/x") and the root of absolute paths.
            else ($v | sub("^[ \t\r\n]+"; "") | sub("[ \t\r\n]+$"; "") | sub("^(\\./)+"; "")) as $c
                 | ([ $known[] | . as $k
                      | select($c == $k or ($c | endswith("/" + $k))
                               or ($k | endswith("/" + $c))) ] | first) // $c
            end) ]')" || die "cannot normalize the completed review receipts"
}

require_no_pending() {
  [ "$(printf '%s' "$PLAN_PENDING" | jq 'length')" = "0" ] \
    || die "review tasks incomplete: $(printf '%s' "$PLAN_PENDING" | jq -r 'join(", ")')"
}

# Indices some verdicts-<n>.json already carries a verdict for.
ruled_json() {
  local f
  { for f in "$OUTDIR"/verdicts-*.json; do
      [ -e "$f" ] || continue
      jq -c 'if type != "array" then error("not a JSON array") else . end
             | [ .[] | select(type == "object" and has("index")) | .index | tonumber | trunc ]' \
        "$f" || die "cannot parse $f"
    done; } | jq -s 'add // [] | unique'
}

# ---------------------------------------------------------------- pending / prepare

cmd_pending() {
  KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
  local plan
  plan="$(review_plan_json)" || exit 1
  collect_receipts "$plan"
  printf '%s' "$PLAN_PENDING" | jq --indent 1 . || die "cannot print pending tasks"
}

cmd_prepare() {
  KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
  local plan candidates
  plan="$(review_plan_json)" || exit 1
  collect_receipts "$plan"
  require_no_pending
  candidates="$PLAN_CANDIDATES"

  if [ "$(printf '%s' "$candidates" | jq 'length')" = "0" ]; then
    # Exit 0 on purpose: an all-empty round is a valid outcome, and a non-zero exit here
    # reads as a tool failure and invites the orchestrator to retry the step.
    echo "no candidates found — every completed angle receipt has an empty findings array; skip to Step 4"
    return 0
  fi

  local normalized_file="$OUTDIR/normalized-candidates.json"
  local previous='[]'
  if [ -f "$normalized_file" ]; then
    previous="$(jq -c "$JQ_LIB"'
      [ .[] | select(type == "object" and has("index")) ]
      | sort_by(.index) | with_occurrence
      | map({key: .__key, index: (.index | tonumber | trunc),
             manual: (.merged_duplicate == true and .merged_by != "auto")})' "$normalized_file")" \
      || die "cannot parse $normalized_file"
  fi

  # Batches that already have verdicts are finished work; drop only the stale inputs.
  local f n
  for f in "$OUTDIR"/verify-input-*.json; do
    [ -e "$f" ] || continue
    n="$(basename "$f")"; n="${n#verify-input-}"; n="${n%.json}"
    [ -f "$OUTDIR/verdicts-$n.json" ] || rm -f "$f"
  done
  local taken='[]'
  taken="$({ for f in "$OUTDIR"/verify-input-*.json; do
               [ -e "$f" ] || continue
               n="$(basename "$f")"; n="${n#verify-input-}"; echo "${n%.json}"
             done; } | jq -R . | jq -s .)"

  local verified; verified="$(ruled_json)" || exit 1

  local result; result="$(jq -n "$JQ_LIB"'
    ($candidates) as $raw
    | ($previous | map({(.key): .}) | add // {}) as $prev_by_key
    # Only --drop decisions carry over; automatic merges are recomputed every run (they are a
    # function of the candidates plus the manual drops, and a manual drop must be able to
    # promote the other member of a literal-repeat group).
    | ($previous | map(select(.manual) | .index)) as $prev_dropped
    | (($previous | map(.index) | max) // 0) as $maxidx

    # Number: an index already handed out is preserved — a verdicts file collected in an
    # earlier wave refers to it, so renumbering would rebind verdicts to the wrong candidate.
    | [ $raw | to_entries[] | .value + {__pos: .key} ]
    | sort_by(orderkey + [.__pos])
    | with_occurrence
    | reduce .[] as $c ({next: ($maxidx + 1), out: []};
        ($prev_by_key[$c.__key].index) as $known
        | if $known == null
          then .out += [$c + {index: .next}] | .next += 1
          else .out += [$c + {index: $known}] end)
    | .out
    | map(del(.__key))
    | sort_by(.index)

    # Literal repeats (same file, line and title) are merged mechanically. A manually dropped
    # member never wins (it would take the whole group down with it); among the rest, one that
    # already holds a verdict survives (never throw away collected verification), else the
    # first by report order. Anything less literal than a literal repeat is the orchestrator s
    # call via --drop.
    | (($dropped + $prev_dropped) | unique) as $manual_dropped
    | ([ group_ordered(dupkey)[] | .items
         | sort_by(. as $c
                   | [ (if ($manual_dropped | index($c.index)) != null then 1 else 0 end),
                       (if ($verified | index($c.index)) != null then 0 else 1 end) ]
                     + ($c | orderkey) + [$c.index])
         | .[1:][] | .index ]) as $auto_dropped

    # A --drop decision is recorded in the file, not just applied once: later prepare runs
    # (sweep, resume) must not resurrect a candidate already merged into another.
    | (($manual_dropped + $auto_dropped) | unique) as $dropped_all
    | map(. as $c
          | if ($manual_dropped | index($c.index)) != null
            then . + {merged_duplicate: true, merged_by: "manual"}
            elif ($auto_dropped | index($c.index)) != null
            then . + {merged_duplicate: true, merged_by: "auto"}
            else del(.merged_duplicate, .merged_by) end)
    | map(del(.__pos))

    # Live, unverified candidates split into the ones a verifier will judge and the cleanup
    # ones that pass through unverified (see iscleanup). The flag is recomputed on every run
    # so --verify-all can still pull a previously skipped candidate into a batch.
    | map(. as $c
          | if (($verified | index($c.index)) == null)
               and (($dropped_all | index($c.index)) == null)
               and ($verify_all | not) and (($c.angle // "") | iscleanup)
            then . + {unverified_by_policy: true}
            else del(.unverified_by_policy) end)
    | . as $all

    | [ $all[] | . as $c | select((($verified | index($c.index)) == null)
                                  and (($dropped_all | index($c.index)) == null)) ] as $live_unverified
    | [ $live_unverified[] | select(.unverified_by_policy == true) ] as $passthrough
    | [ $live_unverified[] | select(.unverified_by_policy != true) ] as $pending

    # Keep one file s candidates together where possible: each verifier session re-pays the
    # repo context, so few big batches beat many small ones, and one verifier judging all of
    # a file s near-duplicates judges them coherently. Bigger file groups are packed first;
    # .ord keeps equally sized groups in first-appearance order.
    | ([ $pending | group_ordered(.file) | to_entries[]
         | {ord: .key, items: (.value.items | sort_by(orderkey + [.index]))} ]
       | sort_by([-(.items | length), .ord])
       | reduce .[] as $g ([]; . + [range(0; ($g.items | length); $batchsize)
                                    | $g.items[. : . + $batchsize]])
       | reduce .[] as $chunk ({cur: [], out: []};
           if (.cur | length) > 0 and ((.cur | length) + ($chunk | length)) > $batchsize
           then .out += [.cur] | .cur = $chunk
           else .cur += $chunk end)
       | (if (.cur | length) > 0 then .out + [.cur] else .out end)) as $batches

    # Number new batches around the ones already verified.
    | (reduce $batches[] as $b ({n: 0, taken: $taken, out: []};
         . as $st
         | ($st.n + 1) as $start
         | (0 | until(. as $i | ($st.taken | index((($start + $i) | tostring))) == null;
                      . + 1)) as $off
         | ($start + $off) as $num
         | $st | .n = $num | .taken += [($num | tostring)]
               | .out += [{n: $num, items: $b}])
       | .out) as $numbered

    | {normalized: $all,
       batches: $numbered,
       raw: ($all | length),
       dropped: ($dropped_all | length),
       auto_dropped: ($auto_dropped | length),
       already_verified: (([$all[].index] - ([$all[].index] - $verified)) | length),
       to_verify: ($pending | length),
       passthrough: ($passthrough | length),
       show_dups: (($manual_dropped | length) == 0),
       clusters: [ $live_unverified | group_ordered(.file) | sort_by(.key)[]
                   | .key as $path
                   | (.items | sort_by([lineof, .index]))
                   | reduce .[] as $c ({runs: [], cur: []};
                       if (.cur | length) == 0 then .cur = [$c]
                       elif (($c | lineof) - (.cur[-1] | lineof)) <= 5 then .cur += [$c]
                       else .runs += [.cur] | .cur = [$c] end)
                   | (.runs + [.cur])
                   | map(select(length > 1))
                   | map({path: $path, members: map({index, angle, line: lineof})})
                   | .[] ]}
    ' --argjson candidates "$candidates" \
      --argjson previous "$previous" \
      --argjson dropped "$DROP_JSON" \
      --argjson verified "$verified" \
      --argjson taken "$taken" \
      --argjson verify_all "$VERIFY_ALL_JSON" \
      --argjson batchsize "$BATCH_SIZE")" || die "candidate preparation failed"

  printf '%s' "$result" | jq --indent 1 '.normalized' > "$normalized_file" \
    || die "cannot write $normalized_file"
  local count i num
  count="$(printf '%s' "$result" | jq '.batches | length')"
  i=0
  while [ "$i" -lt "$count" ]; do
    num="$(printf '%s' "$result" | jq -r ".batches[$i].n")"
    printf '%s' "$result" | jq --indent 1 ".batches[$i].items" > "$OUTDIR/verify-input-$num.json" \
      || die "cannot write verify-input-$num.json"
    i=$((i + 1))
  done

  printf '%s' "$result" | jq -r '
    ("raw=\(.raw) dropped=\(.dropped) already_verified=\(.already_verified) to_verify=\(.to_verify)"
     + (if .passthrough > 0 then " passthrough=\(.passthrough)" else "" end)),
    (if .auto_dropped > 0
     then "\(.auto_dropped) literal repeat(s) (same file, line and title) merged automatically"
     else empty end),
    (if .passthrough > 0
     then "\(.passthrough) cleanup-angle candidate(s) skip verification and reach the report marked unverified (use --verify-all to verify them too)"
     else empty end),
    ("dispatch a verifier for: " +
      (if (.batches | length) > 0
       then ([.batches[] | "out/verify-input-\(.n).json"] | join(", "))
       elif .to_verify == 0 and .passthrough > 0 and .already_verified == 0
       then "nothing — every candidate is a cleanup pass-through; go straight to Step 4"
       else "nothing — every candidate already has a verdict" end)),
    (if .show_dups and ((.clusters | length) > 0)
     then ("possible duplicates (same file, within 5 lines) — if any pair is the SAME " +
           "mechanism, re-run prepare with --drop <indices of the weaker ones>, otherwise " +
           "proceed:"),
          (.clusters[] | "  \(.path): " +
            ([.members[] | "#\(.index)(\(.angle),L\(.line))"] | join(" ")))
     else empty end)'
  return 0
}

# ---------------------------------------------------------------- build

fingerprint_candidates() {
  jq -Sc "$JQ_LIB"'
    map(del(.index, .merged_duplicate, .merged_by, .unverified_by_policy))
    | sort_by([(.angle // ""), (.file // ""), lineof, (.title // "")])' "$@"
}

# Per-file checksums of a unified diff: "<path>\t<cksum>" per `diff --git` section, keyed by
# the new-side (b/) path — the spelling findings and the --stat list use, so a renamed file
# still matches. Quoted (escaped) paths are rare enough to ignore.
diff_section_sums() { # diff-file scratch-dir
  local n path
  mkdir -p "$2" || return 1
  : > "$2/index"
  awk -v dir="$2" '
    /^diff --git / {
      n++; out = dir "/" n
      path = $0; sub(/^diff --git a\/.* b\//, "", path)
      print n "\t" path > (dir "/index")
    }
    n > 0 { print > out }
  ' "$1"
  while IFS=$'\t' read -r n path; do
    [ -n "$n" ] || continue
    printf '%s\t%s\n' "$path" "$(cksum < "$2/$n" | cut -d' ' -f1)"
  done < "$2/index"
}

# Files whose diff differs from the one the reviewers saw. A review round takes 15–45 minutes
# and working-tree targets keep being edited underneath it (observed: 2 findings in one round
# void by report time). Prints repo-relative paths; silent when the check cannot run (no diff
# spec persisted, no git, committed range unchanged).
stale_files() {
  local diff_args repo scratch path sum
  [ -r "$RUN_DIR/launch-params.json" ] && [ -r "$RUN_DIR/raw_diff.txt" ] || return 0
  diff_args="$(jq -r '.diff_args // ""' "$RUN_DIR/launch-params.json" 2>/dev/null)" || return 0
  [ -n "$diff_args" ] || return 0
  command -v git >/dev/null 2>&1 || return 0
  repo="$(git -C "$RUN_DIR" rev-parse --show-toplevel 2>/dev/null)" || return 0
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/code-review-stale.XXXXXX")" || return 0
  # shellcheck disable=SC2086
  if ! git -C "$repo" diff $diff_args > "$scratch/current" 2>/dev/null; then
    rm -rf "$scratch"; return 0
  fi
  {
    if ! cmp -s "$scratch/current" "$RUN_DIR/raw_diff.txt"; then
      diff_section_sums "$RUN_DIR/raw_diff.txt" "$scratch/a" > "$scratch/sums-a"
      diff_section_sums "$scratch/current" "$scratch/b" > "$scratch/sums-b"
      # A "path\tsum" line present in exactly one of the two lists is a section that changed,
      # appeared or vanished.
      sort "$scratch/sums-a" "$scratch/sums-b" | uniq -u | cut -f1
    fi
    # Untracked files of a working-tree target are in neither diff; the launcher recorded
    # their checksums at launch. A file edited or deleted since is stale.
    if [ -r "$RUN_DIR/untracked-sums.txt" ]; then
      while IFS=$'\t' read -r path sum; do
        [ -n "$path" ] || continue
        if [ ! -f "$repo/$path" ] || [ "$(cksum < "$repo/$path" | cut -d' ' -f1)" != "$sum" ]; then
          printf '%s\n' "$path"
        fi
      done < "$RUN_DIR/untracked-sums.txt"
    fi
  } | sort -u
  rm -rf "$scratch"
  return 0
}

# Every verdicts-<n>.json should rule on exactly the indices of verify-input-<n>.json. A
# mismatch is not fatal — the join is by index, so the verdicts still land on the right
# candidates — but it means a verifier wandered, and a batch it skipped shows up as unverified.
warn_verdict_batches() {
  local f n mismatch
  for f in "$OUTDIR"/verdicts-*.json; do
    [ -e "$f" ] || continue
    n="$(basename "$f")"; n="${n#verdicts-}"; n="${n%.json}"
    [ -r "$OUTDIR/verify-input-$n.json" ] || continue
    mismatch="$(jq -n --slurpfile v "$f" --slurpfile i "$OUTDIR/verify-input-$n.json" '
      ($v[0] | if type == "array" then [ .[] | select(type == "object" and has("index")) | .index | tonumber | trunc ] else [] end | sort) as $ruled
      | ($i[0] | if type == "array" then [ .[] | select(type == "object" and has("index")) | .index | tonumber | trunc ] else [] end | sort) as $asked
      | if $ruled == $asked then empty
        else "expected \($asked | map(tostring) | join(",")); got \($ruled | map(tostring) | join(","))" end' 2>/dev/null)" || continue
    [ -z "$mismatch" ] || echo "warning: verdicts-$n.json does not match verify-input-$n.json ($mismatch)" >&2
  done
  return 0
}

cmd_build() {
  KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
  local plan normalized_file="$OUTDIR/normalized-candidates.json"
  plan="$(review_plan_json)" || exit 1
  collect_receipts "$plan"
  require_no_pending
  if [ -f "$normalized_file" ]; then
    local current_keys normalized_keys
    current_keys="$(printf '%s' "$PLAN_CANDIDATES" | fingerprint_candidates)" \
      || die "cannot fingerprint completed review receipts"
    normalized_keys="$(fingerprint_candidates "$normalized_file")" \
      || die "cannot fingerprint $normalized_file"
    [ "$current_keys" = "$normalized_keys" ] \
      || die "out/normalized-candidates.json is stale — run \`findings.sh prepare\` first" 2
  else
    # A round where every completed angle receipt has no findings never runs prepare; an
    # empty report is the correct result for it, not an error.
    [ "$(printf '%s' "$PLAN_CANDIDATES" | jq 'length')" = "0" ] \
      || die "out/normalized-candidates.json missing — run \`findings.sh prepare\` first" 2
    printf '[]\n' > "$OUTDIR/findings.json" || die "cannot write findings.json"
    echo "wrote out/findings.json with 0 finding(s)"
    echo "STATS: 0 raw, 0 verified, 0 refuted"
    echo "BY CLASS: bug-angle 0 raw/0 refuted; cleanup 0 raw/0 refuted"
    return 0
  fi

  # Verdicts are required only when prepare scheduled something to verify: a round whose every
  # live candidate is a cleanup pass-through legitimately has none.
  local f found=0 needs_verdicts
  for f in "$OUTDIR"/verdicts-*.json; do [ -e "$f" ] && found=1 && break; done
  needs_verdicts="$(jq -r "$JQ_LIB"'
    any(.[]; type == "object" and .merged_duplicate != true and .unverified_by_policy != true)' \
    "$normalized_file")" || die "cannot read $normalized_file"
  [ "$found" = "1" ] || [ "$needs_verdicts" = "false" ] \
    || die "no out/verdicts-*.json — verification has not run" 2
  warn_verdict_batches

  local verdicts
  verdicts="$({ for f in "$OUTDIR"/verdicts-*.json; do
                  [ -e "$f" ] || continue
                  jq -c 'if type != "array" then error("not a JSON array") else . end
                         | [ .[] | select(type == "object" and has("index")) ]' "$f" \
                    || die "cannot parse $f"
                done; } | jq -s 'add // [] | map({(.index | tonumber | trunc | tostring): .}) | add // {}')"

  local stale_json
  stale_json="$(stale_files | jq -R . | jq -sc .)" || stale_json='[]'

  local result; result="$(jq -n "$JQ_LIB"'
    ($candidates | map(select(type == "object" and has("index")))) as $all
    | [ $all[] | select(.merged_duplicate != true) ] as $live
    | (($all | length) - ($live | length)) as $merged
    | [ $live[] | select($verdicts[(.index | tostring)] == null and .unverified_by_policy != true) ] as $unverified
    | [ $live[] | select($verdicts[(.index | tostring)] == null and .unverified_by_policy == true) ] as $passthrough
    | [ $live[] | select($verdicts[(.index | tostring)].verdict == "REFUTED") ] as $refuted
    | ([ $live[] | . as $c | $verdicts[(.index | tostring)] as $v
         | select($v != null and $v.verdict != "REFUTED")
         | {severity: $c.severity, verdict: $v.verdict, angle: $c.angle, title: $c.title,
            file: $c.file, line: $c.line, evidence: $c.evidence, why: $c.why,
            suggestion: $c.suggestion, verdict_evidence: $v.evidence, __pos: $c.index} ]
       # Pass-through candidates carry the default verdict and say so: the main session must
       # not mistake them for verifier-checked findings.
       + [ $passthrough[] | . as $c
           | {severity: $c.severity, verdict: "PLAUSIBLE", angle: $c.angle, title: $c.title,
              file: $c.file, line: $c.line, evidence: $c.evidence, why: $c.why,
              suggestion: $c.suggestion,
              verdict_evidence: "UNVERIFIED — cleanup-angle candidate passed through without a verifier (policy); check the claimed cost against the code before acting",
              unverified: true, __pos: $c.index} ])
      | sort_by(orderkey + [.__pos])
      | map(. as $f | if (($stale | index($f.file // "")) != null) then . + {stale: true} else . end)
      | map(del(.__pos)) as $findings

    | (reduce $live[] as $c ({bug: 0, bugref: 0, cleanup: 0, cleanupref: 0, cleanuppass: 0};
         ($verdicts[($c.index | tostring)].verdict == "REFUTED") as $isref
         | ($verdicts[($c.index | tostring)] == null and $c.unverified_by_policy == true) as $ispass
         | if (($c.angle // "") | isbug)
           then .bug += 1 | (if $isref then .bugref += 1 else . end)
           else .cleanup += 1 | (if $isref then .cleanupref += 1 else . end)
                | (if $ispass then .cleanuppass += 1 else . end) end)) as $class

    | {findings: $findings, raw: ($all | length),
       verified: ([ $findings[] | select(.unverified != true) ] | length),
       passthrough: ($passthrough | length),
       stale: ([ $findings[] | select(.stale == true) ] | length),
       stale_files: $stale,
       refuted: ($refuted | length), merged: $merged, unverified: ($unverified | length),
       class: $class}
    ' --argjson candidates "$(cat "$normalized_file")" \
      --argjson verdicts "$verdicts" \
      --argjson stale "$stale_json")" || die "findings assembly failed"

  printf '%s' "$result" | jq --indent 1 '.findings' > "$OUTDIR/findings.json" \
    || die "cannot write findings.json"

  printf '%s' "$result" | jq -r '
    "wrote out/findings.json with \(.findings | length) finding(s)",
    ("STATS: \(.raw) raw, \(.verified) verified, \(.refuted) refuted"
     + (if .passthrough > 0 then ", \(.passthrough) cleanup passed through unverified" else "" end)
     + (if .merged > 0 then ", \(.merged) merged as duplicates" else "" end)
     + (if .unverified > 0 then ", \(.unverified) unverified (dropped)" else "" end)),
    ("BY CLASS: bug-angle \(.class.bug) raw/\(.class.bugref) refuted; cleanup \(.class.cleanup) raw/\(.class.cleanupref) refuted"
     + (if .class.cleanuppass > 0 then "/\(.class.cleanuppass) passed through" else "" end)),
    (if .stale > 0
     then "STALE: \(.stale) finding(s) marked stale — their file changed since the packet was built: \(.stale_files | join(", "))"
     else empty end)'
  return 0
}

# ---------------------------------------------------------------- entry

usage() {
  echo "usage: findings.sh pending --run-dir DIR" >&2
  echo "       findings.sh prepare --run-dir DIR [--batch-size N] [--drop 3,7] [--verify-all]" >&2
  echo "       findings.sh build --run-dir DIR" >&2
  exit 1
}

[ $# -ge 1 ] || usage
COMMAND="$1"; shift
RUN_DIR=""
BATCH_SIZE=12
DROP=""
VERIFY_ALL_JSON=false
while [ $# -gt 0 ]; do
  case "$1" in
    --run-dir) [ $# -ge 2 ] || usage; RUN_DIR="$2"; shift 2 ;;
    --batch-size) [ $# -ge 2 ] || usage; BATCH_SIZE="$2"; shift 2 ;;
    --drop) [ $# -ge 2 ] || usage; DROP="$2"; shift 2 ;;
    --verify-all) VERIFY_ALL_JSON=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$RUN_DIR" ] || usage
case "$BATCH_SIZE" in ''|*[!0-9]*) die "--batch-size must be a positive integer" ;; esac
[ "$BATCH_SIZE" -gt 0 ] || die "--batch-size must be a positive integer"

RUN_DIR_ARG="$RUN_DIR"
RUN_DIR="$(cd "$RUN_DIR" 2>/dev/null && pwd -P)" || die "no such run dir: $RUN_DIR_ARG"
OUTDIR="$RUN_DIR/out"
[ -d "$OUTDIR" ] || die "not a run dir (no out/): $RUN_DIR"

# Validated in the shell rather than inside jq: a jq error mid-pipeline leaves the pipeline's
# exit status to the last stage, so a bad index would otherwise be silently dropped and the
# run would proceed having merged the wrong candidates.
DROP_JSON='[]'
if [ -n "$DROP" ]; then
  DROP_ITEMS=""
  while IFS= read -r part; do
    [ -n "$part" ] || continue
    case "$part" in ''|*[!0-9]*) die "--drop takes comma-separated candidate indices (got: $part)" ;; esac
    DROP_ITEMS="$DROP_ITEMS$part
"
  done <<EOF
$(printf '%s' "$DROP" | tr ',' '\n' | tr -d ' \t\r' | sed '/^$/d')
EOF
  if [ -n "$DROP_ITEMS" ]; then
    DROP_JSON="$(printf '%s' "$DROP_ITEMS" | jq -R 'tonumber' | jq -s .)" \
      || die "--drop takes comma-separated candidate indices"
  fi
fi

case "$COMMAND" in
  pending) cmd_pending ;;
  prepare) cmd_prepare ;;
  build) cmd_build ;;
  *) usage ;;
esac
