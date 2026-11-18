#!/usr/bin/env bash
# Runs the weekly dogfood agent: renders prompt.md, then runs Claude Code headless with agent-browser as its
# only shell command. Writes findings.json, screenshots and videos under OUT_DIR.
# Usage: OUT_DIR=<dir> TARGET_URL=<url> FOCUS=<text> [MODEL=<id>] [MAX_BUDGET_USD=<n>] scripts/dogfood/run-agent.sh
set -euo pipefail

: "${OUT_DIR:?OUT_DIR is required}"
: "${TARGET_URL:?TARGET_URL is required}"
: "${FOCUS:?FOCUS is required}"
MODEL="${MODEL:-claude-opus-5-5}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-15}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$OUT_DIR/screenshots" "$OUT_DIR/videos"
[ -f "$OUT_DIR/open-issues.json" ] || echo '[]' > "$OUT_DIR/open-issues.json"

prompt="$(cat "$here/prompt.md")"
prompt="${prompt//\{\{OUT_DIR\}\}/$OUT_DIR}"
prompt="${prompt//\{\{TARGET_URL\}\}/$TARGET_URL}"
prompt="${prompt//\{\{FOCUS\}\}/$FOCUS}"

# The agent reads third-party page text, so it gets agent-browser and file access inside OUT_DIR only:
# no other shell command and no web tools.
# The browser can open file:// URLs, including /proc/<pid>/environ of any process its user owns, and this
# process holds ANTHROPIC_API_KEY. With AGENT_BROWSER_USER set (the workflow sets it), every agent-browser call
# runs as that other user with an empty environment, so neither the browser nor its daemon can read the key.
if [ -n "${AGENT_BROWSER_USER:-}" ]; then
  real="$(command -v agent-browser)"
  wrap="$(mktemp -d)"
  printf '#!/bin/sh\nexec sudo -n -u %s -H env -i PATH=%q HOME=%q %q "$@"\n' \
    "$AGENT_BROWSER_USER" "$PATH" "/home/$AGENT_BROWSER_USER" "$real" > "$wrap/agent-browser"
  chmod 755 "$wrap/agent-browser"
  export PATH="$wrap:$PATH"
  chmod 1777 "$OUT_DIR" "$OUT_DIR/screenshots" "$OUT_DIR/videos"
fi

# --bare skips local settings, hooks and CLAUDE.md, and authenticates only from ANTHROPIC_API_KEY. A local run
# signed in through the keychain sets DOGFOOD_BARE=0.
bare=(--bare)
[ "${DOGFOOD_BARE:-1}" = 0 ] && bare=()
cd "$OUT_DIR"
# CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is not used: it forces the default permission mode, which waits on a
# permission prompt in a headless run instead of denying. `//` marks an absolute path in a permission rule.
claude -p "$prompt" \
  ${bare[@]+"${bare[@]}"} \
  --model "$MODEL" \
  --max-budget-usd "$MAX_BUDGET_USD" \
  --permission-mode dontAsk \
  --allowedTools "Bash(agent-browser *)" "Bash(sleep *)" "Read(/$OUT_DIR/**)" "Edit(/$OUT_DIR/**)" \
  --disallowedTools "WebFetch" "WebSearch" "Agent" \
  --output-format json > "$OUT_DIR/agent-result.json"
