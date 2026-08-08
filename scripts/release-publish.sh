#!/usr/bin/env bash
set -Eeuo pipefail

# Custom publish step for changesets/action. changesets/action runs `version` while changesets
# remain on main (maintaining the "Version Packages" PR) and runs THIS script once none remain —
# i.e. after that PR is merged. Because "no changesets" is also the steady state of main, this
# script runs on every changeset-free push and therefore MUST be idempotent: it skips when a
# PUBLISHED release for v<version> already exists, recovers a stale draft left by an interrupted
# run, and refuses to guess (aborts) when the release state cannot be determined.
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

# Classify the current release state for $tag before doing anything destructive:
#   (a) exists & PUBLISHED  -> idempotent skip (this script re-runs on every changeset-free push);
#   (b) exists but is a DRAFT -> a prior run died between `create --draft` and un-draft (the ERR
#       trap does NOT fire on SIGTERM / runner eviction), leaving a stale draft — recover by
#       recreating it below;
#   (c) genuinely ABSENT     -> create.
# `gh release view` is the right probe: it resolves drafts by their intended tag, whereas the
# get-by-tag REST endpoint 404s on drafts. Its failure is ambiguous, though — a real 404 and a
# transient 403 / rate-limit / network error can look alike — so we proceed to create ONLY on an
# unmistakable "not found" with no transient-error markers. ANY other failure ABORTS the run:
# guessing "no release" would fall through to the delete-and-recreate path and could destroy an
# already-published release.
view_err="$(mktemp)"
if is_draft="$(gh release view "$tag" --json isDraft -q .isDraft 2>"$view_err")"; then
  if [ "$is_draft" = "false" ]; then
    echo "Already released: $tag"
    rm -f "$view_err"
    exit 0
  fi
  echo "Stale draft found for $tag — recreating."
elif grep -qi 'release not found' "$view_err" \
  && ! grep -qiE 'HTTP [0-9]|rate limit|timed? ?out|connection|could not resolve|temporarily' "$view_err"; then
  echo "No existing release for $tag — creating."
else
  echo "ERROR: cannot determine the release state for $tag; aborting so a transient error never" >&2
  echo "       triggers a destructive delete of a published release. gh reported:" >&2
  cat "$view_err" >&2
  rm -f "$view_err"
  exit 1
fi
rm -f "$view_err"

echo "==> Building release binaries for $tag..."
bash scripts/build-release.sh

# Confirm the build actually produced the platform binaries before creating a release around them;
# otherwise `gh release upload dist/wt-*` would pass an unexpanded glob straight to the API.
shopt -s nullglob
assets=(dist/wt-*)
shopt -u nullglob
[ "${#assets[@]}" -gt 0 ] || { echo "ERROR: build-release.sh produced no dist/wt-* assets." >&2; exit 1; }

# Release notes: the section for this version from CHANGELOG.md (changesets format — the lines
# between the "## <version>" heading and the next "## " heading). Fall back to a minimal note.
notes="$(mktemp)"
# Guard the read: a missing CHANGELOG.md would abort awk (and the publish) before the rollback trap
# below is armed, so skip it and let the "Release $tag" fallback take over.
if [ -f CHANGELOG.md ]; then
  awk -v ver="$version" '
    $0 == "## " ver { capture = 1; next }
    capture && /^## / { exit }
    capture { print }
  ' CHANGELOG.md > "$notes"
fi
[ -s "$notes" ] || echo "Release $tag" > "$notes"

# Roll back to the pre-publish state on any failure between create and un-draft.
# shellcheck disable=SC2317
cleanup() { gh release delete "$tag" --cleanup-tag --yes >/dev/null 2>&1 || true; }
trap cleanup ERR

# The guard above only lets us reach here for a confirmed stale draft or a genuine absence — never
# for a published release — so clearing any leftover draft/tag for this version is safe here and
# cannot delete a live release. (Case b: removes the stale draft. Case c: harmless no-op.)
gh release delete "$tag" --cleanup-tag --yes >/dev/null 2>&1 || true

gh release create "$tag" --draft --title "$tag" --notes-file "$notes" --target "$SHA"
gh release upload "$tag" dist/wt-* --clobber
gh release edit "$tag" --draft=false --latest

trap - ERR
echo "Released $tag"
# changesets/action parses "New tag:" lines to populate its published output.
echo "New tag: $tag"
