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
echo "Version -> $VERSION"

echo "Compiling..."
npm run compile

echo "Packaging..."
npx @vscode/vsce package

echo ""
echo "Done: git-branch-pr-$VERSION.vsix"
echo "Install with: code --install-extension git-branch-pr-$VERSION.vsix"
