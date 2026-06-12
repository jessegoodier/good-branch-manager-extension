#!/usr/bin/env bash
set -euo pipefail

BUMP="${1:-patch}"
if [[ "$BUMP" != patch && "$BUMP" != minor && "$BUMP" != major ]]; then
  echo "Usage: $0 [patch|minor|major]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Bumping $BUMP version..."
npm version "$BUMP" --no-git-tag-version > /dev/null

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
echo "Version -> $VERSION"

echo "Building..."
npm run build

echo "Packaging..."
npx @vscode/vsce package

echo ""
echo "Done: $NAME-$VERSION.vsix"
echo "Install with: code --install-extension $NAME-$VERSION.vsix"
