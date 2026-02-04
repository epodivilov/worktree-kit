#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# pnpm unlink doesn't always remove the symlink, so we do it manually
# Only remove if it's a symlink pointing to THIS project
# (won't affect: pnpm global install, curl+sh install - those are regular files)
WT_PATH="$(which wt 2>/dev/null || true)"
if [ -n "$WT_PATH" ] && [ -L "$WT_PATH" ]; then
  LINK_TARGET="$(readlink -f "$WT_PATH")"
  if [[ "$LINK_TARGET" == "$PROJECT_DIR"* ]]; then
    rm "$WT_PATH"
    echo "Removed dev symlink: $WT_PATH"
  fi
fi

if [ -d "$PROJECT_DIR/dist" ]; then
  rm -rf "$PROJECT_DIR/dist"
  echo "Removed: dist/"
fi

echo "Clean complete"
