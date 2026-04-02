#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${CLAWDEX_BIN_DIR:-$HOME/.local/bin}"
ACTIVE_LINK="$TARGET_DIR/claude"
BACKUP_LINK="$TARGET_DIR/claude-official"
CLAWDEX_LINK="$TARGET_DIR/clawdex"
FORK_LINK="$TARGET_DIR/claude-codex"

rm -f "$CLAWDEX_LINK" "$FORK_LINK"

if [[ ! -L "$BACKUP_LINK" ]]; then
  echo "Removed clawdex launcher links. No claude-official backup link exists." >&2
  exit 0
fi

ln -snf "$(readlink "$BACKUP_LINK")" "$ACTIVE_LINK"

echo "Restored claude launcher -> $(readlink "$ACTIVE_LINK")"
