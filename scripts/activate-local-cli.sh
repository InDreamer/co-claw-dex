#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PATH="$REPO_DIR/cli.js"

if [[ ! -x "$CLI_PATH" ]]; then
  echo "Expected executable launcher at $CLI_PATH" >&2
  exit 1
fi

TARGET_DIR="/opt/homebrew/bin"
ACTIVE_LINK="$TARGET_DIR/claude"
FORK_LINK="$TARGET_DIR/claude-codex"
BACKUP_LINK="$TARGET_DIR/claude-official"

mkdir -p "$TARGET_DIR"

if [[ -L "$ACTIVE_LINK" ]]; then
  current_target="$(readlink "$ACTIVE_LINK")"
  if [[ "$current_target" != "$CLI_PATH" ]]; then
    ln -snf "$current_target" "$BACKUP_LINK"
  fi
fi

ln -snf "$CLI_PATH" "$ACTIVE_LINK"
ln -snf "$CLI_PATH" "$FORK_LINK"

echo "Active claude launcher -> $CLI_PATH"
if [[ -L "$BACKUP_LINK" ]]; then
  echo "Official backup launcher -> $(readlink "$BACKUP_LINK")"
fi
