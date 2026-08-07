#!/usr/bin/env bash
set -Eeuo pipefail

# Custom publish step for changesets/action. changesets/action runs `version` while changesets
# remain on main (maintaining the "Version Packages" PR) and runs THIS script once none remain —
# i.e. after that PR is merged. Because "no changesets" is also the steady state of main, this
# script runs on every changeset-free push and therefore MUST be idempotent: it skips when the
# v<version> release already exists.
#
# Atomicity / rollback: the release is assembled as a DRAFT (tag + draft created together), the 5
# platform binaries uploaded, then un-drafted and marked "latest" in one final step — the only
# moment it goes live. Any failure in between deletes the draft AND its tag (gh --cleanup-tag), so
# a failed or interrupted publish leaves the previous release as "latest" with no dangling tag.
#
# Distribution contract (see self-update.ts / github-releases.ts / install.sh / install.ps1):
# tag is v<version>, assets are wt-{darwin,linux}-{arm64,x64} (+ wt-windows-x64.exe), and the
# release is non-prerelease + latest so /releases/latest resolves it. Do not weaken any of these.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Target the exact commit being released (the Version PR merge on main) rather than whatever the
# tag would default to.
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"

version="$(node -p "require('./package.json').version")"
tag="v$version"

# Idempotent: a release already exists for this version → nothing to do.
if gh release view "$tag" >/dev/null 2>&1; then
  echo "Already released: $tag"
  exit 0
fi

echo "==> Building release binaries for $tag..."
bash scripts/build-release.sh

# Release notes: the section for this version from CHANGELOG.md (changesets format — the lines
# between the "## <version>" heading and the next "## " heading). Fall back to a minimal note.
notes="$(mktemp)"
awk -v ver="$version" '
  $0 == "## " ver { capture = 1; next }
  capture && /^## / { exit }
  capture { print }
' CHANGELOG.md > "$notes"
[ -s "$notes" ] || echo "Release $tag" > "$notes"

# Roll back to the pre-publish state on any failure between create and un-draft.
# shellcheck disable=SC2317
cleanup() { gh release delete "$tag" --cleanup-tag --yes >/dev/null 2>&1 || true; }
trap cleanup ERR

# Clear a stale draft from a prior failed run (only reachable when not yet published).
gh release delete "$tag" --cleanup-tag --yes >/dev/null 2>&1 || true

gh release create "$tag" --draft --title "$tag" --notes-file "$notes" --target "$SHA"
gh release upload "$tag" dist/wt-* --clobber
gh release edit "$tag" --draft=false --latest

trap - ERR
echo "Released $tag"
# changesets/action parses "New tag:" lines to populate its published output.
echo "New tag: $tag"
