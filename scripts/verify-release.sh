#!/usr/bin/env bash
set -euo pipefail

DIST="${1:-dist}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: release verification requires macOS so codesign and a native Darwin smoke test can run." >&2
  exit 1
fi

for artifact in "$DIST/wt-darwin-arm64" "$DIST/wt-darwin-x64"; do
  [ -f "$artifact" ] || { echo "ERROR: missing release artifact: $artifact" >&2; exit 1; }
  echo "Verifying signature: $artifact"
  codesign --verify --strict --verbose=4 "$artifact"
done

case "$(uname -m)" in
  arm64) native="$DIST/wt-darwin-arm64" ;;
  x86_64) native="$DIST/wt-darwin-x64" ;;
  *)
    echo "ERROR: unsupported macOS runner architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

echo "Smoke testing native artifact: $native"
"$native" --version
"$native" --help >/dev/null
