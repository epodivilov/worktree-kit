#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_BIN="$PROJECT_DIR/dist/wt"
TARGET_BIN="$HOME/.local/bin/wt-preview"

pnpm build

# Remove existing symlink if present
if [ -L "$TARGET_BIN" ]; then
  rm "$TARGET_BIN"
fi

# Create symlink to dev build
ln -s "$DIST_BIN" "$TARGET_BIN"
echo "Linked: $TARGET_BIN -> $DIST_BIN"
echo "Run 'wt-preview' to test. Use 'pnpm clean' to remove."
