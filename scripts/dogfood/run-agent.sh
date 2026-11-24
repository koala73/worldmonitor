#!/usr/bin/env bash
# Runs a dogfood agent: renders a prompt, then runs Claude Code headless with agent-browser as its only shell
# command. Writes findings.json, screenshots and videos under OUT_DIR.
# Claude's own result (cost, turns) goes to RESULT_FILE, outside OUT_DIR, so the agent cannot edit it.
#
# The weekly run (prompt.md) needs OUT_DIR, TARGET_URL and FOCUS. The panel content run (content-prompt.md) needs
# OUT_DIR, TARGET_URL and DOGFOOD_PANELS, a comma-separated list of panel ids: before the agent starts, this script
# loads the dashboard with only those panels enabled and, when DOGFOOD_PRO_KEY is set, a Pro session. It records
# what it set up in SETUP_FILE, also outside OUT_DIR.
# Usage: OUT_DIR=<dir> TARGET_URL=<url> (FOCUS=<text> | DOGFOOD_PANELS=<ids>) [PROMPT_FILE=<file>]
#        [DOGFOOD_PRO_KEY=<key>] [RESULT_FILE=<file>] [SETUP_FILE=<file>] [MODEL=<id>] [MAX_BUDGET_USD=<n>]
#        scripts/dogfood/run-agent.sh
set -euo pipefail

: "${OUT_DIR:?OUT_DIR is required}"
: "${TARGET_URL:?TARGET_URL is required}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="${PROMPT_FILE:-$here/prompt.md}"
DOGFOOD_PANELS="${DOGFOOD_PANELS:-}"
[ -n "$DOGFOOD_PANELS" ] || : "${FOCUS:?FOCUS is required}"
FOCUS="${FOCUS:-}"
MODEL="${MODEL:-claude-opus-5-5}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-15}"
RESULT_FILE="${RESULT_FILE:-${OUT_DIR%/}.result.json}"
SETUP_FILE="${SETUP_FILE:-${OUT_DIR%/}.setup.json}"
# The API host the dashboard calls. The Pro cookie is host-only (__Host-), so it is set there.
API_ORIGIN="${API_ORIGIN:-https://api.worldmonitor.app}"
SESSION=dogfood

# Read the key once and drop it from the environment, so neither the agent nor anything it starts inherits it.
pro_key="${DOGFOOD_PRO_KEY:-}"
unset DOGFOOD_PRO_KEY

case "$DOGFOOD_PANELS" in
  *[!a-z0-9,-]*) echo "DOGFOOD_PANELS may hold only panel ids (a-z, 0-9, -) separated by commas" >&2; exit 2 ;;
esac

mkdir -p "$OUT_DIR/screenshots" "$OUT_DIR/videos" "$OUT_DIR/panels"
[ -f "$OUT_DIR/open-issues.json" ] || echo '[]' > "$OUT_DIR/open-issues.json"

prompt="$(cat "$PROMPT_FILE")"
prompt="${prompt//\{\{OUT_DIR\}\}/$OUT_DIR}"
prompt="${prompt//\{\{TARGET_URL\}\}/$TARGET_URL}"
prompt="${prompt//\{\{FOCUS\}\}/$FOCUS}"
prompt="${prompt//\{\{PANELS\}\}/${DOGFOOD_PANELS//,/, }}"
prompt="${prompt//\{\{RUN_DATE\}\}/$(date -u '+%Y-%m-%d %H:%M UTC')}"

# The agent reads third-party page text, so it gets agent-browser and file access inside OUT_DIR only:
# no other shell command and no web tools. `Bash(agent-browser *)` permits any argument, so a wrapper first on PATH
# runs browser-guard.mjs on every call first; it says which commands and options are allowed and why. The wrapper
# also forces an empty read-only config (AGENT_BROWSER_CONFIG replaces both config files) and starts from /, so
# nothing the agent writes is read as configuration. Paths given to screenshot and record must be absolute.
#
# The browser can also open file:// URLs, including /proc/<pid>/environ of any process its user owns, and this
# process holds ANTHROPIC_API_KEY. With AGENT_BROWSER_USER set (the workflow sets it), the wrapper runs every
# call as that other user with an empty environment, so neither the browser nor its daemon can read the key.
#
# With a Pro key the guard runs locked down: see browser-guard.mjs for what that refuses and why.
real="$(command -v agent-browser)"
node_bin="$(command -v node)"
wrap="$(mktemp -d)"
chmod 755 "$wrap"
echo '{}' > "$wrap/agent-browser.json"
chmod 644 "$wrap/agent-browser.json"
if [ -n "${AGENT_BROWSER_USER:-}" ]; then
  as_browser=(sudo -n -u "$AGENT_BROWSER_USER" -H env -i "PATH=$PATH" "HOME=/home/$AGENT_BROWSER_USER"
    "AGENT_BROWSER_EXECUTABLE_PATH=${AGENT_BROWSER_EXECUTABLE_PATH:-}" "AGENT_BROWSER_CONFIG=$wrap/agent-browser.json" "$real")
  chmod 1777 "$OUT_DIR" "$OUT_DIR/screenshots" "$OUT_DIR/videos"
else
  as_browser=(env "AGENT_BROWSER_CONFIG=$wrap/agent-browser.json" "$real")
fi
locked_down=0
[ -n "$pro_key" ] && locked_down=1
{
  echo '#!/bin/sh'
  printf '%q %q %q "$@" || exit 2\n' "$node_bin" "$here/browser-guard.mjs" "$locked_down"
  echo 'cd / || exit 2'
  printf 'exec %s"$@"\n' "$(printf '%q ' "${as_browser[@]}")"
} > "$wrap/agent-browser"
chmod 755 "$wrap/agent-browser"

# Trusted setup for the content run, before the agent exists: enable only this shard's panels and, with a key,
# hold a Pro session. The key goes into the browser as an HttpOnly cookie on the API host; the localStorage
# marker only tells the app to ask the server whether such a cookie exists, and holds no key.
setup_session() {
  local ab=("${as_browser[@]}" --session "$SESSION")
  # The wrapper forces `cd /`; so does this, for the same reason.
  (cd / && "${ab[@]}" set viewport 1440 900 >/dev/null)
  if [ -n "$pro_key" ]; then
    (cd / && "${ab[@]}" cookies set __Host-wm-pro-key "$pro_key" --url "$API_ORIGIN" --http-only --secure --same-site Lax >/dev/null)
  fi
  (cd / && "${ab[@]}" open "${TARGET_URL%/}/dashboard" >/dev/null && "${ab[@]}" wait 8000 >/dev/null)
  local panels_json
  panels_json="[\"${DOGFOOD_PANELS//,/\",\"}\"]"
  local pro_js=false
  [ -n "$pro_key" ] && pro_js=true
  local seed="(() => {
    const want = $panels_json;
    if ($pro_js) localStorage.setItem('wm-key-session-check', '1');
    const all = JSON.parse(localStorage.getItem('worldmonitor-panels') || '{}');
    for (const [id, config] of Object.entries(all)) config.enabled = id === 'map' || want.includes(id);
    localStorage.setItem('worldmonitor-panels', JSON.stringify(all));
    return JSON.stringify({ missing: want.filter((id) => !(id in all)) });
  })()"
  local seeded
  seeded="$(cd / && "${ab[@]}" eval "$seed")"
  (cd / && "${ab[@]}" reload >/dev/null && "${ab[@]}" wait 15000 >/dev/null)
  # pro_session is the server's answer for this browser's cookie, not whether a key was supplied.
  local check="(async () => {
    const want = $panels_json;
    const shown = [...document.querySelectorAll('[data-panel]')].map((el) => el.dataset.panel);
    const locked = [...document.querySelectorAll('.panel-is-locked')].map((el) => el.dataset.panel);
    let pro = false;
    try { pro = (await (await fetch('$API_ORIGIN/api/wm-session', { credentials: 'include' })).json()).pro === true; } catch {}
    return JSON.stringify({ pro_session: pro, rendered: want.filter((id) => shown.includes(id)), locked: want.filter((id) => locked.includes(id)) });
  })()"
  local state
  state="$(cd / && "${ab[@]}" eval "$check")"
  # shellcheck disable=SC2016 # JavaScript, not shell.
  node -e '
    const [seeded, state, keyGiven, file] = process.argv.slice(1);
    const parse = (s) => { try { const v = JSON.parse(s); return typeof v === "string" ? JSON.parse(v) : v; } catch { return {}; } };
    const out = { key_given: keyGiven === "1", pro_session: false, ...parse(seeded), ...parse(state) };
    if (out.key_given && !out.pro_session) console.log("::warning::The Pro key was given but the server did not accept it; Pro panels will read as locked.");
    require("fs").writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`Setup: ${out.rendered?.length ?? 0} panels rendered, ${out.locked?.length ?? 0} locked, ${out.missing?.length ?? 0} missing; Pro session ${out.pro_session}`);
  ' "$seeded" "$state" "$locked_down" "$SETUP_FILE"
}
[ -n "$DOGFOOD_PANELS" ] && setup_session
pro_key=""

# The content run also gets the dashboard's startup data split into one small file per key (split-bootstrap.mjs),
# listed in the prompt with sizes, so comparing a panel with its API data costs a few kilobytes of context.
api_files="(none: the startup data could not be fetched)"
if [ -n "$DOGFOOD_PANELS" ]; then
  index="$("$node_bin" "$here/split-bootstrap.mjs" "$API_ORIGIN" "${TARGET_URL%/}" "$OUT_DIR/api" | awk '{ printf "%s (%.0f KB), ", $1, $2 / 1024 }')"
  [ -n "$index" ] && api_files="${index%, }"
fi
prompt="${prompt//\{\{API_FILES\}\}/$api_files}"

export PATH="$wrap:$PATH"

# --bare skips local settings, hooks and CLAUDE.md, and authenticates only from ANTHROPIC_API_KEY. A local run
# signed in through the keychain sets DOGFOOD_BARE=0.
bare=(--bare)
[ "${DOGFOOD_BARE:-1}" = 0 ] && bare=()
cd "$OUT_DIR"
# --setting-sources project keeps user settings out even where --bare reads them: a local advisorModel there turns
# on a server-side advisor on another model, which no tool rule can refuse (it cost a pilot a third of its spend).
# CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is not used: it forces the default permission mode, which waits on a
# permission prompt in a headless run instead of denying. `//` marks an absolute path in a permission rule.
claude -p "$prompt" \
  ${bare[@]+"${bare[@]}"} \
  --setting-sources project \
  --model "$MODEL" \
  --max-budget-usd "$MAX_BUDGET_USD" \
  --permission-mode dontAsk \
  --allowedTools "Bash(agent-browser *)" "Bash(sleep *)" "Read(/$OUT_DIR/**)" "Edit(/$OUT_DIR/**)" \
  --disallowedTools "WebFetch" "WebSearch" "Agent" \
  --output-format json > "$RESULT_FILE"
