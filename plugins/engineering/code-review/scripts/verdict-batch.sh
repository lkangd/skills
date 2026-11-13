# Shared validation for a verifier batch and its checkpoint.
verdict_batch_valid() {
  local batch="$1" verdicts="$2"
  [ -r "$batch" ] && [ -r "$verdicts" ] || return 1
  jq -en --slurpfile v "$verdicts" --slurpfile i "$batch" '
    ($v | length) == 1 and ($i | length) == 1
    and ($v[0] | type) == "array" and ($i[0] | type) == "array"
    and all($i[0][]; type == "object" and (.index | type) == "number")
    and all($v[0][]; type == "object" and (.index | type) == "number"
      and (.verdict == "CONFIRMED" or .verdict == "PLAUSIBLE" or .verdict == "REFUTED")
      and (.evidence | type) == "string" and (.evidence | test("\\S")))
    and ([$v[0][].index] | sort) == ([$i[0][].index] | sort)
  ' >/dev/null 2>&1
}
