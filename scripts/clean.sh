#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_BIN="$HOME/.local/bin/wt-preview"

# Remove dev symlink if it points to this project
if [ -L "$TARGET_BIN" ]; then
  LINK_TARGET="$(readlink -f "$TARGET_BIN")"
  if [[ "$LINK_TARGET" == "$PROJECT_DIR"* ]]; then
    rm "$TARGET_BIN"
    echo "Removed: $TARGET_BIN"
  fi
fi

if [ -d "$PROJECT_DIR/dist" ]; then
  rm -rf "$PROJECT_DIR/dist"
  echo "Removed: dist/"
fi

echo "Clean complete"
