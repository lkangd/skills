#!/usr/bin/env bash
# Launch read-only headless reviewer processes for the code-review plugin.
#
# usage: run-reviewers.sh --runner '<cmd prefix>' --outdir <dir> [--concurrency N] <prompt-file>...
#
# Each prompt file becomes one reviewer process:
#   CODE_REVIEW_CHILD=1 <runner> -p "<prompt>" --allowedTools ... --disallowedTools ...
# stdout/stderr/exit code land in <outdir>/<name>.out|.err|.exit.
# set -e/pipefail omitted on purpose: a failed reviewer must not abort the batch;
# per-process exit codes are captured below and surfaced via `exit $failed`.
set -u

usage() {
  echo "usage: run-reviewers.sh --runner '<cmd prefix>' --outdir <dir> [--concurrency N] <prompt-file>..." >&2
  exit 2
}

# Recursion guard: a reviewer must never be able to spawn more reviewers.
if [ -n "${CODE_REVIEW_CHILD:-}" ]; then
  echo "refusing to run: CODE_REVIEW_CHILD is set — nested code-review invocation" >&2
  exit 3
fi

RUNNER=""
OUTDIR=""
CONC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --runner) RUNNER="$2"; shift 2 ;;
    --outdir) OUTDIR="$2"; shift 2 ;;
    --concurrency) CONC="$2"; shift 2 ;;
    -h|--help) usage ;;
    --*) echo "unknown flag: $1" >&2; usage ;;
    *) break ;;
  esac
done

[ -n "$RUNNER" ] && [ -n "$OUTDIR" ] && [ $# -ge 1 ] || usage
case "$CONC" in (*[!0-9]*|'') echo "--concurrency must be a non-negative integer" >&2; exit 2 ;; esac

# Hard fan-out cap, independent of what the calling agent asks for.
if [ $# -gt 8 ]; then
  echo "refusing to run: $# reviewer prompts exceeds the hard cap of 8" >&2
  exit 3
fi

for f in "$@"; do
  [ -r "$f" ] || { echo "prompt file not readable: $f" >&2; exit 2; }
done

mkdir -p "$OUTDIR" || exit 1

# Read-only toolset for reviewers: no write tools, no subagents (Task), no skills.
ALLOWED='Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git blame:*),Bash(git status:*),Bash(ls:*),Bash(wc:*),Bash(head:*),Bash(tail:*)'
DISALLOWED='Task,Skill,Write,Edit,NotebookEdit,WebFetch,WebSearch,TodoWrite'

launch() {
  prompt_file="$1"
  name=$(basename "$prompt_file" .md)
  # $RUNNER is intentionally unquoted: it is a command prefix like "ccsp -g gpt claude".
  CODE_REVIEW_CHILD=1 $RUNNER -p "$(cat "$prompt_file")" \
    --allowedTools "$ALLOWED" \
    --disallowedTools "$DISALLOWED" \
    --max-turns 40 \
    > "$OUTDIR/$name.out" 2> "$OUTDIR/$name.err"
  echo $? > "$OUTDIR/$name.exit"
}

# Chunked batching (portable to macOS bash 3.2 — no `wait -n`).
started=0
for f in "$@"; do
  launch "$f" &
  started=$((started + 1))
  if [ "$CONC" -gt 0 ] && [ $((started % CONC)) -eq 0 ]; then
    wait
  fi
done
wait

echo "reviewers finished:"
failed=0
for f in "$@"; do
  name=$(basename "$f" .md)
  code=$(cat "$OUTDIR/$name.exit" 2>/dev/null || echo '?')
  [ "$code" = "0" ] || failed=1
  echo "- $name: exit $code -> $OUTDIR/$name.out"
done
exit $failed
