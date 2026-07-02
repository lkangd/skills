#!/usr/bin/env bash
set -euo pipefail

RAW_ARGS="${1:-}"
BRANCH_NAME=""
FORCE=0

usage() {
  echo "Usage: /my-workflows:clean-dev-worktree <branch-name> [--force]" >&2
  echo "Example: /my-workflows:clean-dev-worktree dev-f-20260702-ai-live-stream-reply" >&2
}

print_error_status() {
  echo "STATUS: ERROR"
  echo "$1"
}

append_note() {
  local current="$1"
  local next="$2"
  if [[ -z "${current}" ]]; then
    printf '%s' "${next}"
  else
    printf '%s; %s' "${current}" "${next}"
  fi
}

escape_cell() {
  local value="$1"
  value="${value//$'\n'/ }"
  value="${value//|/\\|}"
  printf '%s' "${value}"
}

print_row() {
  printf '| %s | %s | %s | %s |\n' "$(escape_cell "$1")" "$(escape_cell "$2")" "$(escape_cell "$3")" "$(escape_cell "$4")"
}

parse_args() {
  local args=()
  if [[ -n "${RAW_ARGS}" ]]; then
    read -r -a args <<< "${RAW_ARGS}"
  fi

  for arg in "${args[@]}"; do
    case "${arg}" in
      --force|-f)
        FORCE=1
        ;;
      *)
        if [[ -z "${BRANCH_NAME}" ]]; then
          BRANCH_NAME="${arg}"
        else
          print_error_status "Unexpected argument: ${arg}"
          usage
          exit 0
        fi
        ;;
    esac
  done

  if [[ -z "${BRANCH_NAME}" ]]; then
    print_error_status "Missing branch name."
    usage
    exit 0
  fi
}

default_merge_ref() {
  local repo_path="$1"
  local ref=""

  ref="$(git -C "${repo_path}" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "${ref}" ]] && git -C "${repo_path}" rev-parse --verify --quiet "${ref}" >/dev/null; then
    echo "${ref}"
    return 0
  fi

  for candidate in origin/main origin/master main master; do
    if git -C "${repo_path}" rev-parse --verify --quiet "${candidate}" >/dev/null; then
      echo "${candidate}"
      return 0
    fi
  done

  return 1
}

parse_args

if [[ ! "${BRANCH_NAME}" =~ ^dev-(f|bg)-[0-9]{8}-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  print_error_status "Branch name must match dev-[f/bg]-[YYYYMMdd]-[description-separated-by-dash]. Got: ${BRANCH_NAME}"
  exit 0
fi

if ! git check-ref-format --branch "${BRANCH_NAME}" >/dev/null 2>&1; then
  print_error_status "Invalid git branch name: ${BRANCH_NAME}"
  exit 0
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  print_error_status "Run this command inside a repository that is a sibling of the worktrees to clean."
  exit 0
fi

REPO_ROOT="$(cd "${REPO_ROOT}" && pwd -P)"
PARENT_DIR="$(dirname "${REPO_ROOT}")"
WORKSPACE_FILE="${PARENT_DIR}/${BRANCH_NAME}.code-workspace"
CURRENT_PWD="$(pwd -P)"

if [[ ! -f "${WORKSPACE_FILE}" ]]; then
  print_error_status "Workspace file was not found: ${WORKSPACE_FILE}. Confirm the branch name and cleanup target before deleting anything manually."
  exit 0
fi

TARGET_OUTPUT=""
if ! TARGET_OUTPUT="$(WORKSPACE_FILE="${WORKSPACE_FILE}" BRANCH_NAME="${BRANCH_NAME}" PARENT_DIR="${PARENT_DIR}" python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

workspace_file = Path(os.environ["WORKSPACE_FILE"])
branch_name = os.environ["BRANCH_NAME"]
parent_dir = Path(os.environ["PARENT_DIR"])
suffix = f"-{branch_name}"

try:
    data = json.loads(workspace_file.read_text(encoding="utf-8"))
except json.JSONDecodeError as error:
    print(f"Workspace file is not valid JSON: {workspace_file}: {error}", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict):
    print(f"Workspace file root must be a JSON object: {workspace_file}", file=sys.stderr)
    sys.exit(1)

folders = data.get("folders")
if not isinstance(folders, list):
    print(f"Workspace file folders must be a list: {workspace_file}", file=sys.stderr)
    sys.exit(1)

rows = []
for item in folders:
    if not isinstance(item, dict):
        continue
    raw_path = item.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        continue

    folder_path = Path(raw_path)
    absolute_path = folder_path if folder_path.is_absolute() else parent_dir / folder_path
    absolute_path = absolute_path.resolve(strict=False)
    folder_name = item.get("name") if isinstance(item.get("name"), str) else absolute_path.name

    if not absolute_path.name.endswith(suffix) and not folder_name.endswith(suffix):
        continue

    base_name = absolute_path.name[:-len(suffix)] if absolute_path.name.endswith(suffix) else folder_name[:-len(suffix)]
    admin_candidate = (parent_dir / base_name).resolve(strict=False)
    rows.append((folder_name, raw_path, str(absolute_path), str(admin_candidate)))

if not rows:
    print(f"No workspace folders matched branch {branch_name} in {workspace_file}", file=sys.stderr)
    sys.exit(1)

for row in rows:
    print("\t".join(row))
PY
)"; then
  echo "STATUS: ERROR"
  echo "Failed to parse cleanup targets from workspace file: ${WORKSPACE_FILE}"
  exit 0
fi

TARGET_LINES=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && TARGET_LINES+=("${line}")
done <<< "${TARGET_OUTPUT}"

if (( ${#TARGET_LINES[@]} == 0 )); then
  print_error_status "No cleanup targets were found in workspace file: ${WORKSPACE_FILE}"
  exit 0
fi

TARGET_NAMES=()
TARGET_RELPATHS=()
TARGET_PATHS=()
TARGET_ADMIN_PATHS=()
TARGET_COMMON_DIRS=()
TARGET_WORKTREE_EXISTS=()
TARGET_BRANCH_EXISTS=()
TARGET_PROTECTED=()
PRECHECK_STATUSES=()
PRECHECK_NOTES=()

unsafe_count=0
protected_count=0

for line in "${TARGET_LINES[@]}"; do
  IFS=$'\t' read -r target_name target_relpath target_path admin_path <<< "${line}"
  notes=""
  row_unsafe=0
  row_protected=0
  worktree_exists=0
  branch_exists=0
  context_path=""
  common_dir=""

  if [[ -e "${target_path}" ]]; then
    if [[ ! -e "${target_path}/.git" ]]; then
      notes="$(append_note "${notes}" "target exists but is not a git worktree")"
      row_protected=1
    elif [[ -d "${target_path}/.git" ]]; then
      notes="$(append_note "${notes}" "target is a main repository, not a linked git worktree")"
      row_protected=1
    elif ! git -C "${target_path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      notes="$(append_note "${notes}" "target is not a valid git worktree")"
      row_protected=1
    else
      worktree_exists=1
      context_path="${target_path}"
      common_dir="$(git -C "${target_path}" rev-parse --path-format=absolute --git-common-dir)"
      target_realpath="$(cd "${target_path}" && pwd -P)"

      case "${CURRENT_PWD}/" in
        "${target_realpath}/"*)
          notes="$(append_note "${notes}" "current shell is inside this worktree")"
          row_protected=1
          ;;
      esac

      current_branch="$(git -C "${target_path}" branch --show-current 2>/dev/null || true)"
      if [[ "${current_branch}" != "${BRANCH_NAME}" ]]; then
        notes="$(append_note "${notes}" "checked-out branch is ${current_branch:-detached}, expected ${BRANCH_NAME}")"
        row_protected=1
      fi

      dirty_output="$(git -C "${target_path}" status --porcelain --untracked-files=all)"
      if [[ -n "${dirty_output}" ]]; then
        dirty_count="$(printf '%s\n' "${dirty_output}" | wc -l | tr -d ' ')"
        notes="$(append_note "${notes}" "${dirty_count} uncommitted/untracked file(s)")"
        row_unsafe=1
      fi
    fi
  else
    notes="$(append_note "${notes}" "worktree path is missing")"
    row_unsafe=1
    if [[ -e "${admin_path}/.git" ]] && git -C "${admin_path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      context_path="${admin_path}"
      common_dir="$(git -C "${admin_path}" rev-parse --path-format=absolute --git-common-dir)"
    else
      notes="$(append_note "${notes}" "base repository is missing or invalid: ${admin_path}")"
      row_protected=1
    fi
  fi

  if [[ -n "${common_dir}" ]]; then
    if git --git-dir="${common_dir}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
      branch_exists=1
      if [[ -n "${context_path}" ]]; then
        if git -C "${context_path}" fetch --all --prune >/dev/null 2>&1; then
          merge_ref="$(default_merge_ref "${context_path}" || true)"
          if [[ -z "${merge_ref}" ]]; then
            notes="$(append_note "${notes}" "cannot determine main/default branch for merge safety check")"
            row_unsafe=1
          elif git -C "${context_path}" merge-base --is-ancestor "${BRANCH_NAME}" "${merge_ref}" >/dev/null 2>&1; then
            notes="$(append_note "${notes}" "branch is merged into ${merge_ref}")"
          else
            notes="$(append_note "${notes}" "branch is not merged into ${merge_ref}")"
            row_unsafe=1
          fi
        else
          notes="$(append_note "${notes}" "failed to fetch remote refs for safety check")"
          row_unsafe=1
        fi
      fi
    else
      notes="$(append_note "${notes}" "local branch already absent")"
    fi
  fi

  if (( row_protected )); then
    status="BLOCKED"
    protected_count=$((protected_count + 1))
  elif (( row_unsafe )); then
    status="NEEDS_CONFIRMATION"
    unsafe_count=$((unsafe_count + 1))
  else
    status="SAFE"
    notes="$(append_note "${notes}" "safe to delete")"
  fi

  TARGET_NAMES+=("${target_name}")
  TARGET_RELPATHS+=("${target_relpath}")
  TARGET_PATHS+=("${target_path}")
  TARGET_ADMIN_PATHS+=("${admin_path}")
  TARGET_COMMON_DIRS+=("${common_dir}")
  TARGET_WORKTREE_EXISTS+=("${worktree_exists}")
  TARGET_BRANCH_EXISTS+=("${branch_exists}")
  TARGET_PROTECTED+=("${row_protected}")
  PRECHECK_STATUSES+=("${status}")
  PRECHECK_NOTES+=("${notes}")
done

echo "Branch: ${BRANCH_NAME}"
echo "Workspace: ${WORKSPACE_FILE}"
echo

echo "Preflight checks:"
print_row "Folder" "Path" "Status" "Notes"
print_row "---" "---" "---" "---"
for index in "${!TARGET_NAMES[@]}"; do
  print_row "${TARGET_NAMES[$index]}" "${TARGET_RELPATHS[$index]}" "${PRECHECK_STATUSES[$index]}" "${PRECHECK_NOTES[$index]}"
done
echo

if (( protected_count > 0 )); then
  echo "STATUS: ERROR"
  echo "Protected targets were found. No deletion was performed. Fix the blocked rows manually, then rerun the command."
  exit 0
fi

if (( unsafe_count > 0 && FORCE == 0 )); then
  echo "STATUS: CONFIRMATION_REQUIRED"
  echo "No deletion was performed because at least one target is not safe to delete automatically."
  echo "If you confirm the uncommitted files, missing worktrees, or unmerged local branches can be discarded, rerun:"
  echo "/my-workflows:clean-dev-worktree ${BRANCH_NAME} --force"
  exit 0
fi

if (( unsafe_count > 0 && FORCE == 1 )); then
  echo "Force confirmation received; continuing cleanup for non-protected targets."
  echo
fi

RESULT_WORKTREE=()
RESULT_BRANCH=()
RESULT_NOTES=()
delete_failed=0

for index in "${!TARGET_NAMES[@]}"; do
  target_path="${TARGET_PATHS[$index]}"
  common_dir="${TARGET_COMMON_DIRS[$index]}"
  worktree_result="already absent"
  branch_result="already absent"
  result_notes=""

  if [[ -z "${common_dir}" ]]; then
    worktree_result="skipped"
    branch_result="skipped"
    result_notes="$(append_note "${result_notes}" "missing git repository context")"
    delete_failed=1
  else
    if [[ "${TARGET_WORKTREE_EXISTS[$index]}" == "1" ]]; then
      remove_args=(worktree remove)
      if (( FORCE == 1 )); then
        remove_args+=(--force)
      fi
      remove_args+=("${target_path}")

      if git --git-dir="${common_dir}" "${remove_args[@]}" >/dev/null 2>&1; then
        worktree_result="removed"
      else
        worktree_result="failed"
        result_notes="$(append_note "${result_notes}" "git worktree remove failed")"
        delete_failed=1
      fi
    fi

    if [[ "${TARGET_BRANCH_EXISTS[$index]}" == "1" ]]; then
      if git --git-dir="${common_dir}" branch -D "${BRANCH_NAME}" >/dev/null 2>&1; then
        branch_result="deleted"
      else
        branch_result="failed"
        result_notes="$(append_note "${result_notes}" "git branch delete failed")"
        delete_failed=1
      fi
    fi
  fi

  [[ -z "${result_notes}" ]] && result_notes="ok"
  RESULT_WORKTREE+=("${worktree_result}")
  RESULT_BRANCH+=("${branch_result}")
  RESULT_NOTES+=("${result_notes}")
done

if (( delete_failed > 0 )); then
  echo "STATUS: ERROR"
  echo "Cleanup partially failed. Workspace file was kept for manual recovery: ${WORKSPACE_FILE}"
  echo
  echo "Cleanup results:"
  print_row "Folder" "Worktree" "Branch" "Notes"
  print_row "---" "---" "---" "---"
  for index in "${!TARGET_NAMES[@]}"; do
    print_row "${TARGET_NAMES[$index]}" "${RESULT_WORKTREE[$index]}" "${RESULT_BRANCH[$index]}" "${RESULT_NOTES[$index]}"
  done
  exit 0
fi

rm -f "${WORKSPACE_FILE}"

echo "STATUS: CLEANED"
echo "Workspace file deleted: ${WORKSPACE_FILE}"
echo
echo "Cleanup results:"
print_row "Folder" "Worktree" "Branch" "Notes"
print_row "---" "---" "---" "---"
for index in "${!TARGET_NAMES[@]}"; do
  print_row "${TARGET_NAMES[$index]}" "${RESULT_WORKTREE[$index]}" "${RESULT_BRANCH[$index]}" "${RESULT_NOTES[$index]}"
done
