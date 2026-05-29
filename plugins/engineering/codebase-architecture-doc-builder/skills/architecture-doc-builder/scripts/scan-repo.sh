#!/usr/bin/env bash
# scan-repo.sh — emit a structured snapshot of a repository to seed
# ARCHITECTURE.md authoring. Language-agnostic with strong JS/TS support.
#
# Usage: scan-repo.sh [path=.]
# Output: markdown-flavoured plain text on stdout.
#
# Sections (in order):
#   1. Repo type        (monorepo / single / lang)
#   2. Top-level layout (depth 1, file/dir counts)
#   3. Modules          (each package.json / Cargo.toml / pyproject.toml /
#                        go.mod with deps, intra-workspace edges, LOC,
#                        test count, entry points)
#   4. Build & CI       (root configs, .github/workflows)
#   5. Existing docs    (README, CHANGELOG, docs/**/*.md)
#   6. Recent activity  (last 10 git commits, branch summary)
#
# The output is intentionally compact — designed to be inlined into a
# single skill prompt without blowing the token budget.

# Best-effort reporting script: never abort on a missing file or a
# failed pipe. We deliberately do NOT use `set -e` / `pipefail`
# because find|while pipelines that turn up nothing should be silent,
# not fatal.
set -u

ROOT="${1:-.}"
cd "$ROOT" || { echo "(could not cd to $ROOT)"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }
JQ_OK=0; have jq && JQ_OK=1

# ---------- 1. Repo type --------------------------------------------------
detect_type() {
  if [[ -f pnpm-workspace.yaml ]]; then echo "js-monorepo (pnpm)"; return; fi
  if [[ -f package.json ]] && [[ "$JQ_OK" -eq 1 ]] \
      && jq -e '.workspaces' package.json >/dev/null 2>&1; then
    echo "js-monorepo (npm/yarn workspaces)"; return
  fi
  if [[ -f Cargo.toml ]] && grep -q '^\[workspace\]' Cargo.toml 2>/dev/null; then
    echo "rust-workspace"; return
  fi
  if [[ -f go.work ]]; then echo "go-workspace"; return; fi
  if [[ -f package.json ]]; then echo "js-single"; return; fi
  if [[ -f Cargo.toml ]]; then echo "rust-single"; return; fi
  if [[ -f pyproject.toml ]] || [[ -f setup.py ]]; then echo "python"; return; fi
  if [[ -f go.mod ]]; then echo "go-single"; return; fi
  echo "unknown"
}

REPO_TYPE=$(detect_type)
ROOT_NAME=$(basename "$(pwd)")

printf '# Repo snapshot: %s\n' "$ROOT_NAME"
printf 'Type: %s\n' "$REPO_TYPE"
printf 'Root: %s\n\n' "$(pwd)"

# ---------- 2. Top-level layout ------------------------------------------
echo "## Top-level layout"
for entry in $(ls -1A | grep -Ev '^(node_modules|\.git|dist|build|target|\.next|\.nuxt|\.turbo|\.cache)$' | sort); do
  if [[ -d "$entry" ]]; then
    fc=$(find "$entry" -type f \
        -not -path '*/node_modules/*' \
        -not -path '*/dist/*' -not -path '*/build/*' \
        -not -path '*/target/*' 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-32s dir   (%s files)\n' "$entry/" "$fc"
  else
    sz=$(wc -l < "$entry" 2>/dev/null | tr -d ' ' || echo "?")
    printf '  %-32s file  (%s lines)\n' "$entry" "$sz"
  fi
done
echo

# ---------- 3. Modules ---------------------------------------------------
echo "## Modules"

scan_js() {
  # Find every package.json in the workspace (depth-limited, skip node_modules / dist)
  find . -name package.json \
    -not -path '*/node_modules/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    -not -path '*/.next/*' \
    -not -path '*/.nuxt/*' \
    -maxdepth 5 2>/dev/null | sort | while read -r pkg; do
    dir=$(dirname "$pkg")
    [[ "$dir" == "." ]] && continue   # skip root unless single-package
    if [[ "$JQ_OK" -eq 1 ]]; then
      name=$(jq -r '.name // "(unnamed)"' "$pkg")
      bin=$(jq -r '.bin // {} | if type=="string" then "default" else (keys|join(",")) end' "$pkg" 2>/dev/null)
      mainexp=$(jq -r '.exports // .main // "(none)" | tostring' "$pkg" 2>/dev/null | head -c 120)
      deps=$(jq -r '.dependencies // {} | keys[]' "$pkg" 2>/dev/null | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
      peers=$(jq -r '.peerDependencies // {} | keys[]' "$pkg" 2>/dev/null | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
    else
      name=$(grep -E '^\s*"name"\s*:' "$pkg" | head -1 | sed -E 's/.*"name"\s*:\s*"([^"]+)".*/\1/')
      bin=""; mainexp=""; deps=""; peers=""
    fi
    echo "### $name"
    echo "- path: $dir"
    [[ -n "$bin" && "$bin" != "{}" ]] && echo "- bin: $bin"
    [[ -n "$mainexp" && "$mainexp" != "(none)" ]] && echo "- exports/main: $mainexp"
    [[ -n "$deps" ]]  && echo "- deps: $deps"
    [[ -n "$peers" ]] && echo "- peers: $peers"

    if [[ -d "$dir/src" ]]; then
      loc=$(find "$dir/src" -type f \
        \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.vue' -o -name '*.svelte' -o -name '*.astro' \) \
        2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
      echo "- src LOC: ${loc:-0}"
      # Top files by LOC, helpful for spotting architectural pivots.
      # Drop the trailing "total" row that wc emits for multi-file input,
      # otherwise it sorts to the top and crowds out a real file.
      find "$dir/src" -type f \
        \( -name '*.ts' -o -name '*.tsx' -o -name '*.vue' -o -name '*.svelte' -o -name '*.astro' \) 2>/dev/null \
        | xargs wc -l 2>/dev/null \
        | awk '$2 != "total"' \
        | sort -rn | head -5 \
        | awk '{ printf "  • %s (%s)\n", $2, $1 }'
    fi
    tc=$(find "$dir" -type f \
        \( -name '*.test.*' -o -name '*.spec.*' \) \
        -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null | wc -l | tr -d ' ')
    [[ "$tc" -gt 0 ]] && echo "- test files: $tc"
    echo
  done
}

scan_rust() {
  find . -name Cargo.toml -not -path '*/target/*' 2>/dev/null | sort | while read -r toml; do
    dir=$(dirname "$toml")
    [[ "$dir" == "." ]] && [[ -f "Cargo.toml" ]] && grep -q '^\[workspace\]' Cargo.toml && continue
    name=$(grep -E '^\s*name\s*=' "$toml" | head -1 | sed -E 's/.*=\s*"([^"]+)".*/\1/')
    echo "### ${name:-(unknown)}"
    echo "- path: $dir"
    if [[ -d "$dir/src" ]]; then
      loc=$(find "$dir/src" -name '*.rs' 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
      echo "- src LOC: ${loc:-0}"
      find "$dir/src" -name '*.rs' 2>/dev/null \
        | xargs wc -l 2>/dev/null \
        | awk '$2 != "total"' \
        | sort -rn | head -5 \
        | awk '{ printf "  • %s (%s)\n", $2, $1 }'
    fi
    deps=$(awk '/^\[dependencies\]/{flag=1;next} /^\[/{flag=0} flag && /^[a-zA-Z]/{print $1}' "$toml" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
    [[ -n "$deps" ]] && echo "- deps: $deps"
    echo
  done
}

scan_python() {
  top_py_files() {
    local d="$1"
    find "$d" -name '*.py' \
      -not -path '*/.venv/*' -not -path '*/venv/*' \
      -not -path '*/site-packages/*' -not -path '*/__pycache__/*' 2>/dev/null \
      | xargs wc -l 2>/dev/null \
      | awk '$2 != "total"' \
      | sort -rn | head -5 \
      | awk '{ printf "  • %s (%s)\n", $2, $1 }'
  }
  for cfg in pyproject.toml setup.py setup.cfg; do
    if [[ -f "$cfg" ]]; then
      echo "### $(basename "$(pwd)")"
      echo "- config: $cfg"
      if [[ -d src ]]; then
        loc=$(find src -name '*.py' 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
        echo "- src LOC: ${loc:-0}"
        top_py_files src
      else
        top_py_files .
      fi
      echo
      break
    fi
  done
  find . -maxdepth 4 -name pyproject.toml -not -path '*/.venv/*' \
    -not -path '*/venv/*' -not -path '*/site-packages/*' 2>/dev/null \
    | grep -v '^./pyproject.toml$' | while read -r pp; do
      dir=$(dirname "$pp")
      name=$(grep -E '^\s*name\s*=' "$pp" | head -1 | sed -E 's/.*=\s*"([^"]+)".*/\1/')
      echo "### ${name:-$(basename "$dir")}"
      echo "- path: $dir"
      top_py_files "$dir"
      echo
    done
}

scan_go() {
  find . -name go.mod -not -path '*/vendor/*' 2>/dev/null | while read -r mod; do
    dir=$(dirname "$mod")
    name=$(head -1 "$mod" | sed 's/^module //')
    echo "### $name"
    echo "- path: $dir"
    loc=$(find "$dir" -name '*.go' -not -name '*_test.go' 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
    [[ -n "$loc" ]] && echo "- src LOC: $loc"
    find "$dir" -name '*.go' -not -name '*_test.go' -not -path '*/vendor/*' 2>/dev/null \
      | xargs wc -l 2>/dev/null \
      | awk '$2 != "total"' \
      | sort -rn | head -5 \
      | awk '{ printf "  • %s (%s)\n", $2, $1 }'
    echo
  done
}

case "$REPO_TYPE" in
  js-*) scan_js ;;
  rust-*) scan_rust ;;
  python) scan_python ;;
  go-*)  scan_go ;;
  *) echo "(no module scanner for $REPO_TYPE — falling back to top-3-level dir listing)";
     find . -maxdepth 3 -type d \
       -not -path '*/node_modules*' -not -path '*/.git*' \
       -not -path '*/dist*' -not -path '*/target*' 2>/dev/null \
       | sort | head -40 ;;
esac

# ---------- 4. Build & CI ------------------------------------------------
echo "## Build & CI"
ls -1 2>/dev/null | grep -Ei '(tsconfig|tsup|rollup|vite|webpack|rspack|esbuild|turbo|nx|prettier|eslint|biome|lint|pnpm|yarn|cargo|pyproject|poetry|go\.mod|makefile)' | head -20 | sed 's/^/  /'
if [[ -d .github/workflows ]]; then
  echo "  .github/workflows/:"
  ls -1 .github/workflows/ | sed 's/^/    /'
fi
[[ -f .gitlab-ci.yml ]] && echo "  .gitlab-ci.yml"
[[ -f Jenkinsfile ]]    && echo "  Jenkinsfile"
echo

# ---------- 5. Existing docs --------------------------------------------
echo "## Existing docs"
ls -1 *.md 2>/dev/null | sed 's/^/  /'
if [[ -d docs ]]; then
  find docs -name '*.md' 2>/dev/null | head -20 | sed 's/^/  /'
fi
echo

# ---------- 6. Recent activity ------------------------------------------
echo "## Recent activity"
if git rev-parse --git-dir >/dev/null 2>&1; then
  echo "  branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "  commits (last 10):"
  git log --oneline -10 2>/dev/null | sed 's/^/    /'
else
  echo "  (not a git repo)"
fi
