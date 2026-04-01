#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: Bun is required to build this repo." >&2
  echo "Install Bun from https://bun.sh and run this script again." >&2
  exit 1
fi

node -e "const major = Number(process.versions.node.split('.')[0]); if (!Number.isFinite(major) || major < 18) { console.error('Error: Node.js 18 or newer is required.'); process.exit(1); }"

echo "Installing dependencies..."
npm install

echo "Building CLI..."
npm run build

echo
echo "Bootstrap complete."
echo "Start with: npm run start"
echo "Quick check: npm run start -- --help"
