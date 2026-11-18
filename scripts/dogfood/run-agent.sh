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
# `Bash(agent-browser *)` permits any argument, and agent-browser can do more than browse: `plugin`/`plugins` and
# --engine or --executable-path run programs the caller names, `download`, `state` and `upload` move files, and a
# config file (~/.agent-browser/config.json or ./agent-browser.json) can load a plugin at launch. A wrapper first on
# PATH therefore allows only the browsing commands below, refuses the global options that change what runs, forces
# an empty read-only config (AGENT_BROWSER_CONFIG replaces both config files) and starts from /, so nothing the
# agent writes is read as configuration. Paths given to screenshot and record must be absolute.
#
# The browser can also open file:// URLs, including /proc/<pid>/environ of any process its user owns, and this
# process holds ANTHROPIC_API_KEY. With AGENT_BROWSER_USER set (the workflow sets it), the wrapper runs every
# call as that other user with an empty environment, so neither the browser nor its daemon can read the key.
real="$(command -v agent-browser)"
wrap="$(mktemp -d)"
chmod 755 "$wrap"
echo '{}' > "$wrap/agent-browser.json"
chmod 644 "$wrap/agent-browser.json"
if [ -n "${AGENT_BROWSER_USER:-}" ]; then
  # shellcheck disable=SC2016 # "$@" is expanded by the wrapper, not here.
  launch="$(printf 'exec sudo -n -u %q -H env -i PATH=%q HOME=%q AGENT_BROWSER_EXECUTABLE_PATH=%q AGENT_BROWSER_CONFIG=%q %q "$@"' \
    "$AGENT_BROWSER_USER" "$PATH" "/home/$AGENT_BROWSER_USER" "${AGENT_BROWSER_EXECUTABLE_PATH:-}" "$wrap/agent-browser.json" "$real")"
  chmod 1777 "$OUT_DIR" "$OUT_DIR/screenshots" "$OUT_DIR/videos"
else
  # shellcheck disable=SC2016 # "$@" is expanded by the wrapper, not here.
  launch="$(printf 'AGENT_BROWSER_CONFIG=%q exec %q "$@"' "$wrap/agent-browser.json" "$real")"
fi
cat > "$wrap/agent-browser" <<WRAPPER
#!/bin/sh
refuse() { echo "dogfood: \$1 is not allowed in this run" >&2; exit 2; }
# The command is the first word after an optional --session <name>.
command=""
skip=0
for arg in "\$@"; do
  if [ "\$skip" = 1 ]; then skip=0; continue; fi
  case "\$arg" in
    --session) skip=1 ;;
    --session=*) ;;
    --version|-V) command=--version; break ;;
    -*) refuse "agent-browser option \$arg before the command" ;;
    *) command="\$arg"; break ;;
  esac
done
case "\$command" in
  open|goto|navigate|read|back|forward|reload|wait|snapshot|screenshot|click|dblclick|type|fill|press|keyboard|hover|focus|check|uncheck|select|drag|scroll|scrollintoview|get|is|find|eval|errors|console|network|record|set|tab|frame|mouse|dialog|skills|close|--version) ;;
  *) refuse "agent-browser command '\$command'" ;;
esac
# Global options can follow the command too.
for arg in "\$@"; do
  case "\$arg" in
    --executable-path*|--engine*|--config*|--extension*|--init-script*|--args*|--provider*|--proxy*|--allowed-domains*|--allow-file-access*|--auto-connect*|--cdp*|--profile*|--state*|--credential-provider*)
      refuse "agent-browser option \$arg" ;;
  esac
done
cd / || exit 2
$launch
WRAPPER
chmod 755 "$wrap/agent-browser"
export PATH="$wrap:$PATH"

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
