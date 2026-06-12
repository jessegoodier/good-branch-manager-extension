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

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
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

echo "Installing dependencies..."
npm ci

echo "Packaging $NAME $VERSION..."
npm run package

if [[ ! -f "$VSIX" ]]; then
  echo "Expected package $VSIX was not created." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Release build changed tracked files. Commit those changes before releasing." >&2
  exit 1
fi

echo "Creating tag $TAG..."
git tag -a "$TAG" -m "$NAME $VERSION"

echo "Pushing tag $TAG..."
git push origin "$TAG"

echo "Creating GitHub release..."
gh release create "$TAG" "$VSIX#VSIX package" \
  --fail-on-no-commits \
  --generate-notes \
  --notes "Install locally with: \`code --install-extension $VSIX\`" \
  --title "$TAG" \
  --verify-tag

echo "Released $TAG with $VSIX attached."
