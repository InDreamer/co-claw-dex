#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PATH="$REPO_DIR/cli.js"

if [[ ! -x "$CLI_PATH" ]]; then
  echo "Expected executable launcher at $CLI_PATH" >&2
  exit 1
fi

TARGET_DIR="${CLAWDEX_BIN_DIR:-$HOME/.local/bin}"
ACTIVE_LINK="$TARGET_DIR/clawdex"
FORK_LINK="$TARGET_DIR/claude-codex"
LEGACY_LINK="$TARGET_DIR/claude"
BACKUP_LINK="$TARGET_DIR/claude-official"

mkdir -p "$TARGET_DIR"

if [[ -L "$LEGACY_LINK" ]]; then
  current_target="$(readlink "$LEGACY_LINK")"
  if [[ "$current_target" != "$CLI_PATH" ]]; then
    ln -snf "$current_target" "$BACKUP_LINK"
  fi
fi

ln -snf "$CLI_PATH" "$ACTIVE_LINK"
ln -snf "$CLI_PATH" "$FORK_LINK"
if [[ "${CLAWDEX_LINK_CLAUDE:-0}" == "1" ]]; then
  ln -snf "$CLI_PATH" "$LEGACY_LINK"
fi

echo "Active clawdex launcher -> $CLI_PATH"
if [[ "${CLAWDEX_LINK_CLAUDE:-0}" == "1" ]]; then
  echo "Compatibility claude launcher -> $CLI_PATH"
fi
if [[ -L "$BACKUP_LINK" ]]; then
  echo "Official backup launcher -> $(readlink "$BACKUP_LINK")"
fi
