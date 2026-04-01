#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="/opt/homebrew/bin"
ACTIVE_LINK="$TARGET_DIR/claude"
BACKUP_LINK="$TARGET_DIR/claude-official"

if [[ ! -L "$BACKUP_LINK" ]]; then
  echo "No claude-official backup link exists." >&2
  exit 1
fi

ln -snf "$(readlink "$BACKUP_LINK")" "$ACTIVE_LINK"

echo "Restored claude launcher -> $(readlink "$ACTIVE_LINK")"
