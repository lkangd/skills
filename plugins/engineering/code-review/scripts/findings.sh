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
# usage: findings.sh prepare --run-dir DIR [--batch-size N] [--drop 3,7]
#          Collect out/candidates-*.json, normalize each `file` against the packet's
#          changed-file list, number the candidates, and write out/normalized-candidates.json
#          plus out/verify-input-<n>.json batches. Prints a compact summary and, when
#          candidates cluster on nearby lines of one file, a duplicate report to act on with
#          --drop.
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

# Every candidates-*.json as one array, in filename order, each item tagged with the angle
# its filename encodes (candidates-<angle>[-<slice>].json).
collect_json() {
  local f base angle
  { for f in "$OUTDIR"/candidates-*.json; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"; base="${base#candidates-}"; base="${base%.json}"
      angle="$(printf '%s' "$base" | sed -E 's/-[0-9]+$//')"
      jq -c --arg angle "$angle" --argjson known "$KNOWN_JSON" '
        if type != "array" then error("not a JSON array") else . end
        | map(select(type == "object")
              | (if has("angle") then . else . + {angle: $angle} end)
              | .file = (
                  (.file // null) as $v
                  | if ($v | type) != "string" or $v == "" then $v
                    else ($v | sub("^[ \t\r\n]+"; "") | sub("[ \t\r\n]+$"; "") | sub("^[./]+"; "")) as $c
                         | ([ $known[] | . as $k
                              | select($c == $k or ($c | endswith("/" + $k))
                                       or ($k | endswith("/" + $c))) ] | first) // $c
                    end)
              )' "$f" || die "cannot parse $f"
    done; } | jq -s 'add // []'
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

# ---------------------------------------------------------------- prepare

cmd_prepare() {
  KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
  local candidates; candidates="$(collect_json)" || exit 1

  if [ "$(printf '%s' "$candidates" | jq 'length')" = "0" ]; then
    # Exit 0 on purpose: an all-empty round is a valid outcome, and a non-zero exit here
    # reads as a tool failure and invites the orchestrator to retry the step.
    echo "no candidates found — every angle returned an empty array; skip to Step 4"
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

cmd_build() {
  local normalized_file="$OUTDIR/normalized-candidates.json"
  if [ ! -f "$normalized_file" ]; then
    # A round where every angle returned [] never runs prepare; an empty report is the
    # correct result for it, not an error.
    KNOWN_JSON="$(changed_files_json)" || die "cannot read diff-stat.txt"
    local any; any="$(collect_json)" || exit 1
    [ "$(printf '%s' "$any" | jq 'length')" = "0" ] \
      || die "out/normalized-candidates.json missing — run \`findings.sh prepare\` first"
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
  echo "usage: findings.sh prepare --run-dir DIR [--batch-size N] [--drop 3,7]" >&2
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
RUN_DIR="$(cd "$RUN_DIR" 2>/dev/null && pwd)" || die "no such run dir: $RUN_DIR_ARG"
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
  prepare) cmd_prepare ;;
  build) cmd_build ;;
  *) usage ;;
esac
