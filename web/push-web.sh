#!/usr/bin/env bash
set -euo pipefail

BRANCH_NAME="ai-sheet-filler.com"
REMOTE_NAME="origin"
TEMP_BRANCH="web-deploy-temp"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must be run from within the git repository." >&2
  exit 1
fi

git subtree split --prefix web -b "${TEMP_BRANCH}"
git push -f "${REMOTE_NAME}" "${TEMP_BRANCH}:${BRANCH_NAME}"
git branch -D "${TEMP_BRANCH}"

echo "Pushed /web to ${REMOTE_NAME}:${BRANCH_NAME}"
