#!/bin/bash
# Renders the vault intro videos via Blender (headless).
# Run from the project root: bash scripts/render-vault.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$SCRIPT_DIR/blender-vault-render.py"

# Find Blender
BLENDER=""
for candidate in \
  "/Applications/Blender.app/Contents/MacOS/Blender" \
  "/Applications/Blender/Blender.app/Contents/MacOS/Blender" \
  "$(which blender 2>/dev/null)"; do
  if [ -x "$candidate" ]; then
    BLENDER="$candidate"
    break
  fi
done

if [ -z "$BLENDER" ]; then
  echo "Error: Blender not found."
  echo "Install from https://www.blender.org or: brew install --cask blender"
  exit 1
fi

echo "Using Blender: $BLENDER"
echo "Rendering vault videos... (this takes ~5-10 minutes)"
"$BLENDER" --background --python "$PY"
echo ""
echo "Done. Check public/vault-idle.mp4 and public/vault-open.mp4"
