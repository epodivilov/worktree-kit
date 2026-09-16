#!/bin/bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
DIST="dist"

rm -rf "$DIST"
mkdir -p "$DIST"

targets=(
  "bun-darwin-arm64:wt-darwin-arm64"
  "bun-darwin-x64:wt-darwin-x64"
  "bun-linux-x64:wt-linux-x64"
  "bun-linux-arm64:wt-linux-arm64"
  "bun-windows-x64:wt-windows-x64.exe"
)

for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  output="${entry##*:}"
  echo "Building $output..."
  bun build ./src/index.ts --compile --target="$target" --outfile "$DIST/$output"
done

# Bun cross-compilation can leave an invalid embedded Mach-O signature. Sign only
# after every artifact's final bytes have been written. The release workflow runs
# this script on macOS; non-macOS local builds remain useful for compilation checks
# but are deliberately not publishable (release-publish.sh enforces verification).
if [ "$(uname -s)" = "Darwin" ]; then
  for artifact in "$DIST/wt-darwin-arm64" "$DIST/wt-darwin-x64"; do
    echo "Ad-hoc signing $artifact..."
    codesign --force --sign - "$artifact"
  done
fi

echo "Built binaries for v$VERSION:"
ls -la "$DIST"
