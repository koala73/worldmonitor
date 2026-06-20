#!/usr/bin/env bash
# Exempts /mcp from Cloudflare Bot Fight Mode. Fixes issue #4348.
# Usage: CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ZONE_ID=<zone_id> ./apply-waf-rules.sh
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?required}"
: "${CLOUDFLARE_ZONE_ID:?required}"
DRY_RUN="${DRY_RUN:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULE_FILE="${SCRIPT_DIR}/waf-mcp-bot-exempt.json"
PHASE="http_request_firewall_custom"
CF_API="https://api.cloudflare.com/client/v4"
DESC="Skip Bot Fight Mode for /mcp — allow MCP client connections (issue #4348)"
log() { echo "[waf] $*" >&2; }
die() { echo "[waf] ERROR: $*" >&2; exit 1; }
command -v curl &>/dev/null || die "curl required"
command -v jq   &>/dev/null || die "jq required"
NEW_RULE="$(jq .rules[0] "$RULE_FILE")"
RESP="$(curl -sf -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" "${CF_API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/${PHASE}/entrypoint" || echo "{}")"
if echo "$RESP" | jq -e .success &>/dev/null; then
  CURRENT="$(echo "$RESP" | jq ".result.rules // []")"
else
  CURRENT="[]"; log "No existing ruleset."
fi
FILTERED="$(echo "$CURRENT" | jq --arg d "$DESC" "[.[] | select(.description != \$d)]")"
MERGED="$(jq -n --argjson n "$NEW_RULE" --argjson r "$FILTERED" "[\$n] + \$r")"
PAYLOAD="$(jq -n --argjson rules "$MERGED" "{description:\"WAF rules worldmonitor.app\",rules:\$rules}")"
[[ "$DRY_RUN" == "1" ]] && { echo "$PAYLOAD" | jq .; exit 0; }
log "Applying..."
APPLY="$(curl -sf -X PUT -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" --data "$PAYLOAD" "${CF_API}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/${PHASE}/entrypoint")"
echo "$APPLY" | jq -e .success &>/dev/null && log "? Done." || { echo "$APPLY" | jq . >&2; die "Failed."; }
