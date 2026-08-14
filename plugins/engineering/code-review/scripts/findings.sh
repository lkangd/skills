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
#        findings.sh prepare --run-dir DIR [--batch-size N] [--drop 3,7]
#          Validate that every planned review task has a completed receipt, collect the
#          findings, normalize each `file` against the packet's changed-file list, number the
#          candidates, and write out/normalized-candidates.json plus out/verify-input-<n>.json
#          batches. Prints a compact summary and, when candidates cluster on nearby lines of
#          one file, a duplicate report to act on with --drop.
#
#          Re-running is safe and incremental: candidates already numbered keep their index,
#          batches whose verdicts-<n>.json already exists are left alone, and only unverified
#          candidates are re-batched. That is what makes the Step 3.5 sweep (a new candidates
#          file arriving after the first verification wave), a --drop correction, and a resume
#          all work without invalidating verdicts already collected.
#
#        findings.sh build --run-dir DIR
#          Join out/verdicts-*.json onto the normalized candidates, drop REFUTED and
#          unverified ones, order the survivors, and write out/findings.json. Prints the
#          numbers the orchestrator's stats line needs.
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

migrate_legacy_plan() {
  local plan="$RUN_DIR/review-plan.json"
  local tasks='[]' requested angle prompt status='ready' f temp
  requested="$(requested_angles_from_launch)" \
    || die "review-plan.json missing and launch metadata is unavailable"

  while IFS= read -r angle; do
    angle="${angle//[[:space:]]/}"
    [ -n "$angle" ] || continue
    for f in "$OUTDIR/candidates-$angle-"[0-9]*.json; do
      [ -e "$f" ] || continue
      die "legacy sliced checkpoints cannot be migrated safely — resume with the plugin version that created this run"
    done
    prompt="$RUN_DIR/prompts/$angle.md"
    [ -r "$prompt" ] || die "legacy angle prompt missing: $prompt"
    tasks="$(jq -cn --argjson tasks "$tasks" --arg id "$angle" --arg angle "$angle" \
      --arg prompt "$prompt" '$tasks + [{id: $id, angle: $angle, prompt: $prompt}]')" \
      || die "cannot migrate review task $angle"
  done <<EOF
$(printf '%s' "$requested" | jq -r '.[]')
EOF

  if [ -e "$OUTDIR/candidates-sweep.json" ]; then
    [ -r "$RUN_DIR/prompts/sweep.md" ] || die "legacy sweep checkpoint has no prompt: $RUN_DIR/prompts/sweep.md"
    tasks="$(jq -cn --argjson tasks "$tasks" --arg prompt "$RUN_DIR/prompts/sweep.md" \
      '$tasks + [{id: "sweep", angle: "sweep", prompt: $prompt}]')" \
      || die "cannot migrate sweep task"
  fi
  if ! compgen -G "$OUTDIR/candidates-*.json" >/dev/null \
    && [ -r "$RUN_DIR/raw_diff.txt" ] \
    && [ "$(wc -l < "$RUN_DIR/raw_diff.txt" | tr -d ' ')" -gt 1500 ]; then
    status='draft'
  fi
  temp="$plan.tmp"
  jq -n --arg status "$status" --argjson requested_angles "$requested" --argjson tasks "$tasks" \
    '{version: 1, status: $status, requested_angles: $requested_angles, tasks: $tasks}' \
    > "$temp" || die "cannot write migrated review plan"
  mv "$temp" "$plan" || die "cannot install migrated review plan"
}

review_plan_json() {
  local plan="$RUN_DIR/review-plan.json" parsed task_count index task_id angle slice_id prompt expected_prompt
  local prompt_physical expected_physical requested_count requested_index requested_angle matching_ids exact_count
  local launch_requested plan_requested
  local known_angles
  [ -r "$plan" ] || migrate_legacy_plan
  known_angles="$(for prompt in "$PLUGIN_ROOT"/references/angles/*.md; do
    [ -e "$prompt" ] || continue
    basename "$prompt" .md
  done | jq -R . | jq -s .)" || die "cannot enumerate review angles"
  parsed="$(jq -c --argjson known_angles "$known_angles" '
    def known_angle: . as $angle | $known_angles | index($angle) != null;
    if type != "object" or .version != 1
      then error("expected review plan version 1")
    elif (.requested_angles | type) != "array" or (.requested_angles | length) == 0
      then error("expected a non-empty requested_angles array")
    elif ([.requested_angles[]] | length) != ([.requested_angles[]] | unique | length)
      then error("requested angles must be unique")
    elif any(.requested_angles[]; ((type != "string") or . == "sweep" or ((. | known_angle) | not)))
      then error("requested_angles contains an unknown angle")
    elif (.tasks | type) != "array" or (.tasks | length) == 0
      then error("expected a non-empty tasks array")
    elif .status != "ready"
      then error("review plan is not ready — finalize slicing before dispatch")
    elif ([.tasks[].id] | length) != ([.tasks[].id] | unique | length)
      then error("task IDs must be unique")
    elif any(.tasks[]; ((.id | type) != "string") or (((.id | test("^[a-z0-9][a-z0-9-]*$")) | not)))
      then error("task IDs must be lowercase kebab-case")
    elif any(.tasks[]; ((.angle | type) != "string") or ((.prompt | type) != "string"))
      then error("every task needs angle and prompt strings")
    elif any(.tasks[]; ((.angle | known_angle) | not))
      then error("tasks contains an unknown angle")
    else . end' "$plan")" || die "cannot parse $plan"

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

  task_count="$(printf '%s' "$parsed" | jq '.tasks | length')"
  index=0
  while [ "$index" -lt "$task_count" ]; do
    task_id="$(printf '%s' "$parsed" | jq -r ".tasks[$index].id")"
    angle="$(printf '%s' "$parsed" | jq -r ".tasks[$index].angle")"
    prompt="$(printf '%s' "$parsed" | jq -r ".tasks[$index].prompt")"
    if [ "$angle" = "sweep" ]; then
      [ "$task_id" = "sweep" ] || die "sweep task ID must be sweep"
      printf '%s' "$parsed" | jq -e '.requested_angles | index("design") != null' >/dev/null \
        || die "sweep task requires the design angle"
    else
      printf '%s' "$parsed" | jq -e --arg angle "$angle" \
        '.requested_angles | index($angle) != null' >/dev/null \
        || die "review task angle was not requested: $angle"
      if [ "$task_id" != "$angle" ]; then
        case "$task_id" in
          "$angle"-*) slice_id="${task_id#"$angle"-}" ;;
          *) die "review task ID does not match its angle: $task_id -> $angle" ;;
        esac
        case "$slice_id" in ''|*[!0-9]*|0) die "review task ID does not match its angle: $task_id -> $angle" ;; esac
      fi
    fi
    expected_prompt="$RUN_DIR/prompts/$task_id.md"
    [ -r "$prompt" ] || die "review task prompt missing: $prompt"
    prompt_physical="$(cd "$(dirname "$prompt")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$prompt")")" \
      || die "cannot resolve review task prompt: $prompt"
    expected_physical="$(cd "$(dirname "$expected_prompt")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$expected_prompt")")" \
      || die "cannot resolve expected review task prompt: $expected_prompt"
    [ "$prompt_physical" = "$expected_physical" ] \
      || die "review task prompt must match its task ID: $task_id"
    index=$((index + 1))
  done

  requested_count="$(printf '%s' "$parsed" | jq '.requested_angles | length')"
  requested_index=0
  while [ "$requested_index" -lt "$requested_count" ]; do
    requested_angle="$(printf '%s' "$parsed" | jq -r ".requested_angles[$requested_index]")"
    matching_ids="$(printf '%s' "$parsed" | jq -c --arg angle "$requested_angle" \
      '[.tasks[] | select(.angle == $angle) | .id]')"
    [ "$(printf '%s' "$matching_ids" | jq 'length')" -gt 0 ] \
      || die "review plan does not cover requested angle: $requested_angle"
    exact_count="$(printf '%s' "$matching_ids" | jq --arg angle "$requested_angle" \
      '[.[] | select(. == $angle)] | length')"
    [ "$exact_count" = "0" ] || [ "$(printf '%s' "$matching_ids" | jq 'length')" = "1" ] \
      || die "review plan mixes base and sliced tasks for angle: $requested_angle"
    requested_index=$((requested_index + 1))
  done
  printf '%s\n' "$parsed"
}

receipt_findings_json() {
  local file="$1" filter payload first_error
  filter='
    (if type == "array" then .
     elif type == "object" and .status == "completed" and (.findings | type) == "array"
       then .findings
     else error("not a completed review receipt") end) as $findings
    | if any($findings[]; type != "object")
      then error("review findings must be objects")
      else $findings end'
  if first_error="$(jq -c "$filter" "$file" 2>&1)"; then
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
    printf '%s\n' "$payload" | jq -c "$filter"
  else
    printf '%s\n' "$first_error" >&2
    return 1
  fi
}

pending_json() {
  local plan="$1" task_count index task_id receipt pending='[]'
  task_count="$(printf '%s' "$plan" | jq '.tasks | length')"
  index=0
  while [ "$index" -lt "$task_count" ]; do
    task_id="$(printf '%s' "$plan" | jq -r ".tasks[$index].id")"
    receipt="$OUTDIR/candidates-$task_id.json"
    if [ ! -r "$receipt" ] || ! receipt_findings_json "$receipt" >/dev/null 2>&1; then
      pending="$(jq -cn --argjson pending "$pending" --arg task_id "$task_id" \
        '$pending + [$task_id]')" || die "cannot collect pending task $task_id"
    fi
    index=$((index + 1))
  done
  printf '%s\n' "$pending"
}

require_complete_plan() {
  local plan="$1" pending
  pending="$(pending_json "$plan")" || exit 1
  [ "$(printf '%s' "$pending" | jq 'length')" = "0" ] \
    || die "review tasks incomplete: $(printf '%s' "$pending" | jq -r 'join(", ")')"
}

# Collect completed receipts in review-plan order. New checkpoints are
# {"status":"completed","findings":[...]}; legacy bare arrays remain readable so interrupted
# runs created before the receipt protocol can still resume.
collect_json() {
  local plan="$1" task_count index task_id angle receipt items collected='[]' f orphan_id
  for f in "$OUTDIR"/candidates-*.json; do
    [ -e "$f" ] || continue
    orphan_id="$(basename "$f")"
    orphan_id="${orphan_id#candidates-}"
    orphan_id="${orphan_id%.json}"
    printf '%s' "$plan" | jq -e --arg id "$orphan_id" '.tasks | any(.id == $id)' >/dev/null \
      || die "checkpoint is not listed in review-plan.json: $f"
  done
  task_count="$(printf '%s' "$plan" | jq '.tasks | length')"
  index=0
  while [ "$index" -lt "$task_count" ]; do
    task_id="$(printf '%s' "$plan" | jq -r ".tasks[$index].id")"
    angle="$(printf '%s' "$plan" | jq -r ".tasks[$index].angle")"
    receipt="$OUTDIR/candidates-$task_id.json"
    items="$(receipt_findings_json "$receipt")" || die "cannot parse $receipt"
    items="$(printf '%s' "$items" | jq -c --arg angle "$angle" --argjson known "$KNOWN_JSON" '
      map(.angle = $angle
          | .file = (
              (.file // null) as $v
              | if ($v | type) != "string" or $v == "" then $v
                else ($v | sub("^[ \t\r\n]+"; "") | sub("[ \t\r\n]+$"; "") | sub("^[./]+"; "")) as $c
                     | ([ $known[] | . as $k
                          | select($c == $k or ($c | endswith("/" + $k))
                                   or ($k | endswith("/" + $c))) ] | first) // $c
                end)
          )')" || die "cannot normalize $receipt"
    collected="$(jq -cn --argjson collected "$collected" --argjson items "$items" \
      '$collected + $items')" || die "cannot collect $receipt"
    index=$((index + 1))
  done
  printf '%s\n' "$collected"
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
  local plan pending
  plan="$(review_plan_json)" || exit 1
  pending="$(pending_json "$plan")" || exit 1
  printf '%s' "$pending" | jq --indent 1 . || die "cannot print pending tasks"
}

cmd_prepare() {
  KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
  local plan candidates
  plan="$(review_plan_json)" || exit 1
  require_complete_plan "$plan"
  candidates="$(collect_json "$plan")" || exit 1

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
      [ .[] | select(type == "object" and has("index"))
        | {key: ([(.angle // null), (.file // null), lineof, (.title // null)] | tojson),
           index: (.index | tonumber | trunc),
           merged: (.merged_duplicate == true)} ]' "$normalized_file")" \
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
    | ($previous | map(select(.merged) | .index)) as $prev_dropped
    | (($previous | map(.index) | max) // 0) as $maxidx

    # Number: an index already handed out is preserved — a verdicts file collected in an
    # earlier wave refers to it, so renumbering would rebind verdicts to the wrong candidate.
    | [ $raw | to_entries[] | .value + {__pos: .key} ]
    | sort_by(orderkey + [.__pos])
    | reduce .[] as $c ({next: ($maxidx + 1), out: []};
        ([($c.angle // null), ($c.file // null), ($c | lineof), ($c.title // null)] | tojson) as $k
        | ($prev_by_key[$k].index) as $known
        | if $known == null
          then .out += [$c + {index: .next}] | .next += 1
          else .out += [$c + {index: $known}] end)
    | .out
    | sort_by(.index)

    # A --drop decision is recorded in the file, not just applied once: later prepare runs
    # (sweep, resume) must not resurrect a candidate already merged into another.
    | (($dropped + $prev_dropped) | unique) as $dropped_all
    | map(. as $c | if ($dropped_all | index($c.index)) != null
                    then . + {merged_duplicate: true} else . end)
    | map(del(.__pos))
    | . as $all

    | [ $all[] | . as $c | select((($verified | index($c.index)) == null)
                                  and (($dropped_all | index($c.index)) == null)) ] as $pending

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
       already_verified: (([$all[].index] - ([$all[].index] - $verified)) | length),
       to_verify: ($pending | length),
       show_dups: (($dropped_all | length) == 0),
       clusters: [ $pending | group_ordered(.file) | sort_by(.key)[]
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
    "raw=\(.raw) dropped=\(.dropped) already_verified=\(.already_verified) to_verify=\(.to_verify)",
    ("dispatch a verifier for: " +
      (if (.batches | length) > 0
       then ([.batches[] | "out/verify-input-\(.n).json"] | join(", "))
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
    map(del(.index, .merged_duplicate))
    | sort_by([(.angle // ""), (.file // ""), lineof, (.title // "")])' "$@"
}

cmd_build() {
  local plan normalized_file="$OUTDIR/normalized-candidates.json"
  plan="$(review_plan_json)" || exit 1
  require_complete_plan "$plan"
  if [ -f "$normalized_file" ]; then
    KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
    local current_keys normalized_keys current
    current="$(collect_json "$plan")" || exit 1
    current_keys="$(printf '%s' "$current" | fingerprint_candidates)" \
      || die "cannot fingerprint completed review receipts"
    normalized_keys="$(fingerprint_candidates "$normalized_file")" \
      || die "cannot fingerprint $normalized_file"
    [ "$current_keys" = "$normalized_keys" ] \
      || die "out/normalized-candidates.json is stale — run \`findings.sh prepare\` first" 2
  else
    # A round where every completed angle receipt has no findings never runs prepare; an
    # empty report is the correct result for it, not an error.
    KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
    local any
    any="$(collect_json "$plan")" || exit 1
    [ "$(printf '%s' "$any" | jq 'length')" = "0" ] \
      || die "out/normalized-candidates.json missing — run \`findings.sh prepare\` first" 2
    printf '[]\n' > "$OUTDIR/findings.json" || die "cannot write findings.json"
    echo "wrote out/findings.json with 0 finding(s)"
    echo "STATS: 0 raw, 0 verified, 0 refuted"
    echo "BY CLASS: bug-angle 0 raw/0 refuted; cleanup 0 raw/0 refuted"
    return 0
  fi

  local f found=0
  for f in "$OUTDIR"/verdicts-*.json; do [ -e "$f" ] && found=1 && break; done
  [ "$found" = "1" ] || die "no out/verdicts-*.json — verification has not run" 2

  local verdicts
  verdicts="$({ for f in "$OUTDIR"/verdicts-*.json; do
                  [ -e "$f" ] || continue
                  jq -c 'if type != "array" then error("not a JSON array") else . end
                         | [ .[] | select(type == "object" and has("index")) ]' "$f" \
                    || die "cannot parse $f"
                done; } | jq -s 'add // [] | map({(.index | tonumber | trunc | tostring): .}) | add // {}')"

  local result; result="$(jq -n "$JQ_LIB"'
    ($candidates | map(select(type == "object" and has("index")))) as $all
    | [ $all[] | select(.merged_duplicate != true) ] as $live
    | (($all | length) - ($live | length)) as $merged
    | [ $live[] | select($verdicts[(.index | tostring)] == null) ] as $unverified
    | [ $live[] | select($verdicts[(.index | tostring)].verdict == "REFUTED") ] as $refuted
    | [ $live[] | . as $c | $verdicts[(.index | tostring)] as $v
        | select($v != null and $v.verdict != "REFUTED")
        | {severity: $c.severity, verdict: $v.verdict, angle: $c.angle, title: $c.title,
           file: $c.file, line: $c.line, evidence: $c.evidence, why: $c.why,
           suggestion: $c.suggestion, verdict_evidence: $v.evidence, __pos: $c.index} ]
      | sort_by(orderkey + [.__pos])
      | map(del(.__pos)) as $findings

    | (reduce $live[] as $c ({bug: 0, bugref: 0, cleanup: 0, cleanupref: 0};
         ($verdicts[($c.index | tostring)].verdict == "REFUTED") as $isref
         | if (($c.angle // "") | isbug)
           then .bug += 1 | (if $isref then .bugref += 1 else . end)
           else .cleanup += 1 | (if $isref then .cleanupref += 1 else . end) end)) as $class

    | {findings: $findings, raw: ($all | length), verified: ($findings | length),
       refuted: ($refuted | length), merged: $merged, unverified: ($unverified | length),
       class: $class}
    ' --argjson candidates "$(cat "$normalized_file")" \
      --argjson verdicts "$verdicts")" || die "findings assembly failed"

  printf '%s' "$result" | jq --indent 1 '.findings' > "$OUTDIR/findings.json" \
    || die "cannot write findings.json"

  printf '%s' "$result" | jq -r '
    "wrote out/findings.json with \(.verified) finding(s)",
    ("STATS: \(.raw) raw, \(.verified) verified, \(.refuted) refuted"
     + (if .merged > 0 then ", \(.merged) merged as duplicates" else "" end)
     + (if .unverified > 0 then ", \(.unverified) unverified (dropped)" else "" end)),
    "BY CLASS: bug-angle \(.class.bug) raw/\(.class.bugref) refuted; cleanup \(.class.cleanup) raw/\(.class.cleanupref) refuted"'
  return 0
}

# ---------------------------------------------------------------- entry

usage() {
  echo "usage: findings.sh pending --run-dir DIR" >&2
  echo "       findings.sh prepare --run-dir DIR [--batch-size N] [--drop 3,7]" >&2
  echo "       findings.sh build --run-dir DIR" >&2
  exit 1
}

[ $# -ge 1 ] || usage
COMMAND="$1"; shift
RUN_DIR=""
BATCH_SIZE=12
DROP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run-dir) [ $# -ge 2 ] || usage; RUN_DIR="$2"; shift 2 ;;
    --batch-size) [ $# -ge 2 ] || usage; BATCH_SIZE="$2"; shift 2 ;;
    --drop) [ $# -ge 2 ] || usage; DROP="$2"; shift 2 ;;
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
