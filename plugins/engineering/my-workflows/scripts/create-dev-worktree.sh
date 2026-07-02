#!/usr/bin/env bash
set -euo pipefail

BRANCH_NAME="${1:-}"

usage() {
  echo "Usage: /create-dev-worktree <branch-name>" >&2
  echo "Example: /create-dev-worktree dev-f-20260511-auto-aftermarket-for-standard" >&2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ -z "${BRANCH_NAME}" ]]; then
  usage
  exit 2
fi

if [[ ! "${BRANCH_NAME}" =~ ^dev-(f|bg)-[0-9]{8}-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  fail "Branch name must match dev-[f/bg]-[YYYYMMdd]-[description-separated-by-dash]. Got: ${BRANCH_NAME}"
fi

if ! git check-ref-format --branch "${BRANCH_NAME}" >/dev/null 2>&1; then
  fail "Invalid git branch name: ${BRANCH_NAME}"
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "Run this command inside the repository that should receive the worktree."
fi

REPO_ROOT="$(cd "${REPO_ROOT}" && pwd -P)"
REPO_NAME="$(basename "${REPO_ROOT}")"
PARENT_DIR="$(dirname "${REPO_ROOT}")"
WORKTREE_NAME="${REPO_NAME}-${BRANCH_NAME}"
WORKTREE_PATH="${PARENT_DIR}/${WORKTREE_NAME}"
WORKSPACE_FILE="${PARENT_DIR}/${BRANCH_NAME}.code-workspace"

echo "Repository: ${REPO_ROOT}"
echo "Branch: ${BRANCH_NAME}"
echo "Worktree: ${WORKTREE_PATH}"
echo "Workspace: ${WORKSPACE_FILE}"
echo

echo "Syncing remote branch information..."
if git -C "${REPO_ROOT}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git -C "${REPO_ROOT}" pull --ff-only --prune
else
  echo "Current branch has no upstream; running git fetch --all --prune instead."
  git -C "${REPO_ROOT}" fetch --all --prune
fi

REMOTE_REF=""
if git -C "${REPO_ROOT}" show-ref --verify --quiet "refs/remotes/origin/${BRANCH_NAME}"; then
  REMOTE_REF="origin/${BRANCH_NAME}"
else
  REMOTE_REF="$(git -C "${REPO_ROOT}" for-each-ref --format='%(refname:short)' "refs/remotes/*/${BRANCH_NAME}" | grep -v '/HEAD$' | head -n 1 || true)"
fi

if [[ -z "${REMOTE_REF}" ]] && ! git -C "${REPO_ROOT}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  fail "Branch ${BRANCH_NAME} was not found locally or on any remote. Create it in the company system, then rerun this command."
fi

if [[ -e "${WORKTREE_PATH}" && ! -e "${WORKTREE_PATH}/.git" ]]; then
  fail "Target path exists but is not a git worktree: ${WORKTREE_PATH}"
fi

if [[ -e "${WORKTREE_PATH}/.git" ]]; then
  echo "Worktree already exists; keeping it unchanged."
else
  echo "Creating worktree..."
  if git -C "${REPO_ROOT}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    git -C "${REPO_ROOT}" worktree add "${WORKTREE_PATH}" "${BRANCH_NAME}"
  else
    git -C "${REPO_ROOT}" worktree add --track -b "${BRANCH_NAME}" "${WORKTREE_PATH}" "${REMOTE_REF}"
  fi
fi

WORKSPACE_FILE="${WORKSPACE_FILE}" \
FOLDER_NAME="${WORKTREE_NAME}" \
FOLDER_PATH="${WORKTREE_NAME}" \
python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

workspace_file = Path(os.environ["WORKSPACE_FILE"])
folder = {
    "name": os.environ["FOLDER_NAME"],
    "path": os.environ["FOLDER_PATH"],
}

if workspace_file.exists():
    try:
        data = json.loads(workspace_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        print(f"ERROR: Workspace file is not valid JSON: {workspace_file}: {error}", file=sys.stderr)
        sys.exit(1)
else:
    data = {"folders": [], "settings": {}}

if not isinstance(data, dict):
    print(f"ERROR: Workspace file root must be a JSON object: {workspace_file}", file=sys.stderr)
    sys.exit(1)

folders = data.get("folders")
if not isinstance(folders, list):
    folders = []
    data["folders"] = folders

existing_index = next((index for index, item in enumerate(folders) if isinstance(item, dict) and item.get("path") == folder["path"]), None)
if existing_index is None:
    folders.insert(0, folder)
    action = "added"
else:
    folders[existing_index] = {**folders[existing_index], **folder}
    action = "updated"

if not isinstance(data.get("settings"), dict):
    data["settings"] = {}

workspace_file.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")
print(f"Workspace folder {action}: {folder['name']}")
PY

echo
echo "Done."
echo "Worktree path: ${WORKTREE_PATH}"
echo "Workspace file: ${WORKSPACE_FILE}"
