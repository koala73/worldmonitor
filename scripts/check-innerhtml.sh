#!/usr/bin/env bash
# Flags innerHTML assignments in src/ that interpolate values without escapeHtml().
# Intended for CI or as a pre-commit hook.
#
# Exit codes:
#   0  – no unsafe patterns found
#   1  – potential unsafe innerHTML detected (review required)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/src"

# Pattern: innerHTML assignment with a template literal that contains ${...}
# but the interpolation does NOT call escapeHtml / sanitizeUrl / t( (i18n).
# This is a heuristic — it will have false positives on safe patterns like
# ${escapeHtml(...)}, but those are easily reviewed.

UNSAFE_LINES=$(grep -rn '\.innerHTML\s*=' "$SRC_DIR" \
  --include='*.ts' --include='*.tsx' \
  | grep -v '\.innerHTML\s*=\s*["'"'"']\s*$' \
  | grep -v "\.innerHTML\s*=\s*''" \
  | grep -v '\.innerHTML\s*=\s*""' \
  | grep -v '// eslint-disable' \
  | grep -v '// innerHTML-safe' \
  || true)

if [ -z "$UNSAFE_LINES" ]; then
  echo "No innerHTML assignments found — nothing to review."
  exit 0
fi

echo "=== innerHTML assignments found in src/ ==="
echo "Review each for proper escapeHtml() usage on external data."
echo "Mark intentionally safe lines with a '// innerHTML-safe' comment."
echo ""
echo "$UNSAFE_LINES"
echo ""

# Count lines that look suspicious (contain ${...} without escapeHtml nearby)
SUSPECT_COUNT=$(echo "$UNSAFE_LINES" \
  | grep '\${'  \
  | grep -v 'escapeHtml\|sanitizeUrl\|\.innerHTML\s*=\s*`\s*`' \
  || true)

if [ -n "$SUSPECT_COUNT" ]; then
  echo ""
  echo "=== POTENTIALLY UNSAFE (interpolation without escapeHtml): ==="
  echo "$SUSPECT_COUNT"
  echo ""
  echo "Found potential unsafe innerHTML patterns. Please review above."
  exit 1
fi

echo "All innerHTML assignments appear to use escapeHtml(). OK."
exit 0
