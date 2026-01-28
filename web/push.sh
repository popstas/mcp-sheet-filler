#!/usr/bin/env bash
set -euo pipefail

BRANCH="ai-sheet-filler.com"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this script from within the git repository." >&2
  exit 1
fi

git subtree split --prefix web -b "$BRANCH"
git push origin "$BRANCH" --force
