#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required. Install GitHub CLI and authenticate with 'gh auth login'." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree must be clean before releasing." >&2
  exit 1
fi

is_bump() {
  [[ "$1" == patch || "$1" == minor || "$1" == major ]]
}

next_version() {
  node -e '
    const [major, minor, patch] = require("./package.json").version.split(".").map(Number);
    const bump = process.argv[1];
    if (bump === "major") console.log(`${major + 1}.0.0`);
    else if (bump === "minor") console.log(`${major}.${minor + 1}.0`);
    else console.log(`${major}.${minor}.${patch + 1}`);
  ' "$1"
}

resolve_bump() {
  local bump="${1:-}"
  if [[ -z "$bump" && -n "${RELEASE_BUMP:-}" ]]; then
    bump="$RELEASE_BUMP"
  fi
  if [[ -n "$bump" ]]; then
    if ! is_bump "$bump"; then
      echo "Bump must be patch, minor, or major (got: $bump)." >&2
      echo "Usage: $0 [patch|minor|major]" >&2
      exit 1
    fi
    printf '%s\n' "$bump"
    return
  fi

  if [[ ! -t 0 ]]; then
    echo "Specify a version bump: patch, minor, or major." >&2
    echo "Usage: $0 [patch|minor|major]" >&2
    exit 1
  fi

  local current next_patch next_minor next_major choice
  current="$(node -p "require('./package.json').version")"
  next_patch="$(next_version patch)"
  next_minor="$(next_version minor)"
  next_major="$(next_version major)"

  echo "Current version: $current"
  echo
  echo "How should we bump the version?"
  echo "  patch  →  $next_patch"
  echo "  minor  →  $next_minor"
  echo "  major  →  $next_major"
  echo
  read -r -p "Bump [patch]: " choice
  choice="${choice:-patch}"
  if ! is_bump "$choice"; then
    echo "Bump must be patch, minor, or major (got: $choice)." >&2
    exit 1
  fi
  printf '%s\n' "$choice"
}

# Releases cut from a non-main branch leave the "latest" GitHub release on a
# divergent commit. gh's --fail-on-no-commits only accepts compare status
# "ahead", so "diverged" (main has new commits AND is not a descendant of that
# side-branch tag) incorrectly aborts after the version bump and tag push.
if [[ "${GITHUB_ACTIONS:-}" == "true" && "${GITHUB_REF_NAME:-}" != "main" ]]; then
  echo "Releases must be run from main (got: ${GITHUB_REF_NAME:-unknown})." >&2
  exit 1
fi

BUMP="$(resolve_bump "${1:-}")"
NAME="$(node -p "require('./package.json').name")"
VERSION="$(next_version "$BUMP")"
TAG="v$VERSION"
VSIX="$NAME-$VERSION.vsix"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists locally." >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists on origin." >&2
  exit 1
fi

echo "Bumping $BUMP ($TAG)..."
"$ROOT/scripts/bump-and-package.sh" "$BUMP"

if [[ ! -f "$VSIX" ]]; then
  echo "Expected package $VSIX was not created." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -u
  git commit -m "Release $TAG"
  echo "Pushing release commit..."
  if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
    git push origin "HEAD:${GITHUB_REF_NAME}"
  else
    git push origin HEAD
  fi
fi

echo "Creating tag $TAG..."
git tag -a "$TAG" -m "$NAME $VERSION"

echo "Pushing tag $TAG..."
git push origin "$TAG"

echo "Creating GitHub release..."
# Do not use --fail-on-no-commits: it treats divergent latest tags as "no
# commits" (see main-only guard above). Tag existence checks already prevent
# duplicate version publishes.
#
# Anchor notes at the last *published* GitHub release (not the previous git
# tag). Orphaned tags / side-branch releases would otherwise omit commits.
release_args=(
  "$TAG" "$VSIX#VSIX package"
  --generate-notes
  --notes "Install locally with: \`code --install-extension $VSIX\`"
  --title "$TAG"
  --verify-tag
)
prev_published="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
if [[ -n "$prev_published" ]]; then
  echo "Generating notes since last published release $prev_published..."
  release_args+=(--notes-start-tag "$prev_published")
fi
gh release create "${release_args[@]}"

echo "Released $TAG with $VSIX attached."
