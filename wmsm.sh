#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# 🌍 World Monitor Seed Manager (wmsm)
# Homelab CLI for managing the seed orchestrator.
# Keep CATALOG in sync with scripts/seed-config.mjs
# ═══════════════════════════════════════════════════════════════════════════════

REDIS_URL="${REDIS_URL:-http://localhost:8079}"
REDIS_TOKEN="${REDIS_TOKEN:-wm-local-token}"
CONTAINER="${WM_CONTAINER:-worldmonitor}"

# Auto-detect container runtime: docker or podman
if command -v docker >/dev/null 2>&1; then
  DOCKER=docker
elif command -v podman >/dev/null 2>&1; then
  DOCKER=podman
else
  DOCKER=docker  # will fail at check_deps with helpful message
fi

# ── Catalog: name|tier|intervalMin|ttlSec|metaKey ─────────────────────────────
# metaKey "null" means orchestrator writes seed-meta:orchestrator:{name}
CATALOG=(
  # HOT (5-15 min)
  "weather-alerts|hot|5|900|weather:alerts"
  "correlation|hot|5|1200|correlation:cards"
  "prediction-markets|hot|10|1800|prediction:markets"
  "commodity-quotes|hot|10|1800|market:commodities"
  "market-quotes|hot|10|1800|market:quotes"
  "insights|hot|15|1800|news:insights"
  "military-flights|hot|5|600|military:flights"
  "conflict-intel|hot|10|900|conflict:acled-intel"
  # WARM (30-60 min)
  "earthquakes|warm|30|3600|seismology:earthquakes"
  "security-advisories|warm|30|7200|intelligence:advisories"
  "fire-detections|warm|30|7200|wildfire:fires"
  "natural-events|warm|30|3600|natural:events"
  "radiation-watch|warm|30|7200|radiation:observations"
  "airport-delays|warm|30|7200|aviation:faa"
  "crypto-quotes|warm|30|3600|market:crypto"
  "stablecoin-markets|warm|30|3600|market:stablecoins"
  "gulf-quotes|warm|30|3600|market:gulf-quotes"
  "etf-flows|warm|30|3600|market:etf-flows"
  "economy|warm|30|3600|economic:energy-prices"
  "research|warm|30|3600|research:arxiv-hn-trending"
  "unrest-events|warm|30|3600|unrest:events"
  "usa-spending|warm|30|3600|economic:spending"
  "supply-chain-trade|warm|30|3600|supply_chain:shipping"
  "aviation|warm|30|3600|aviation:ops-news"
  "internet-outages|warm|15|1800|infra:outages"
  "infra|warm|30|3600|null"
  "service-statuses|warm|30|3600|infra:service-statuses"
  "military-maritime-news|warm|30|3600|null"
  "sanctions-pressure|warm|30|43200|sanctions:pressure"
  "forecasts|warm|60|6300|forecast:predictions"
  # COLD (2-6 hours)
  "cyber-threats|cold|120|10800|cyber:threats"
  "climate-anomalies|cold|120|10800|climate:anomalies"
  "thermal-escalation|cold|120|10800|thermal:escalation"
  "gdelt-intel|cold|120|86400|intelligence:gdelt-intel"
  "webcams|cold|360|86400|webcam:cameras:geo"
  "iran-events|cold|360|172800|conflict:iran-events"
  # FROZEN (12h-7d)
  "bis-data|frozen|600|43200|economic:bis"
  "displacement-summary|frozen|720|86400|displacement:summary"
  "submarine-cables|frozen|1440|604800|infrastructure:submarine-cables"
  "military-bases|frozen|1440|604800|null"
  "ucdp-events|frozen|720|86400|conflict:ucdp-events"
  "wb-indicators|frozen|720|86400|null"
)

TIER_ICONS=( "hot|🔥|5-15 min" "warm|🟡|30-60 min" "cold|🧊|2-6 hours" "frozen|🪨|12h-7d" )
TIER_CONCURRENCY=( "hot|3" "warm|5" "cold|3" "frozen|2" )

# ── Helpers ───────────────────────────────────────────────────────────────────

header() {
  echo "🌍 World Monitor Seed Manager"
  echo "══════════════════════════════════════════════════════════════"
  echo
}

footer_line() {
  echo "──────────────────────────────────────────────────────────────"
}

redis_get() {
  curl -sf -H "Authorization: Bearer $REDIS_TOKEN" "$REDIS_URL/get/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$1', safe=''))" 2>/dev/null || echo "$1")" 2>/dev/null
}

redis_scan() {
  local pattern="$1" cursor="0" all_keys=""
  while true; do
    local resp
    resp=$(curl -sf -H "Authorization: Bearer $REDIS_TOKEN" "$REDIS_URL/scan/$cursor?match=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$pattern', safe=''))" 2>/dev/null || echo "$pattern")&count=200" 2>/dev/null)
    [ -z "$resp" ] && break
    cursor=$(echo "$resp" | jq -r '.result[0]')
    local keys
    keys=$(echo "$resp" | jq -r '.result[1][]' 2>/dev/null)
    [ -n "$keys" ] && all_keys="$all_keys"$'\n'"$keys"
    [ "$cursor" = "0" ] && break
  done
  echo "$all_keys" | grep -v '^$' | sort -u
}

redis_del() {
  local key="$1"
  curl -sf -X POST -H "Authorization: Bearer $REDIS_TOKEN" -H "Content-Type: application/json" \
    -d "[\"DEL\",\"$key\"]" "$REDIS_URL" >/dev/null 2>&1
}

# Format seconds as human-readable age
format_age() {
  local secs=$1
  if (( secs < 0 )); then echo "just now"
  elif (( secs < 60 )); then echo "${secs}s ago"
  elif (( secs < 3600 )); then echo "$(( secs / 60 ))m ago"
  elif (( secs < 86400 )); then echo "$(( secs / 3600 ))h ago"
  else echo "$(( secs / 86400 ))d ago"
  fi
}

# Format minutes as human-readable interval
format_interval() {
  local min=$1
  if (( min < 60 )); then printf "%3dm" "$min"
  elif (( min < 1440 )); then printf "%3dh" "$(( min / 60 ))"
  else printf "%3dd" "$(( min / 1440 ))"
  fi
}

# Format seconds as human-readable TTL
format_ttl() {
  local secs=$1
  if (( secs < 3600 )); then printf "%3dm" "$(( secs / 60 ))"
  elif (( secs < 86400 )); then printf "%3dh" "$(( secs / 3600 ))"
  else printf "%3dd" "$(( secs / 86400 ))"
  fi
}

# Get the seed-meta Redis key for a catalog entry
get_meta_key() {
  local name="$1" meta_key="$2"
  if [ "$meta_key" = "null" ]; then
    echo "seed-meta:orchestrator:$name"
  else
    echo "seed-meta:$meta_key"
  fi
}

# Find closest seeder name match for typo correction
suggest_seeder() {
  local input="$1" best="" best_score=0
  for entry in "${CATALOG[@]}"; do
    local name="${entry%%|*}"
    if [[ "$name" == *"$input"* ]] || [[ "$input" == *"$name"* ]]; then
      echo "$name"
      return
    fi
  done
  # Fallback: longest common substring
  for entry in "${CATALOG[@]}"; do
    local name="${entry%%|*}"
    local score=0
    for (( i=0; i<${#input}; i++ )); do
      if [[ "$name" == *"${input:$i:1}"* ]]; then
        (( score++ ))
      fi
    done
    if (( score > best_score )); then
      best_score=$score
      best="$name"
    fi
  done
  echo "$best"
}

# ── Dependency check ──────────────────────────────────────────────────────────

check_deps() {
  local missing=()
  command -v "$DOCKER" >/dev/null 2>&1 || missing+=("docker or podman")
  command -v curl      >/dev/null 2>&1 || missing+=("curl")
  command -v jq        >/dev/null 2>&1 || missing+=("jq")
  if (( ${#missing[@]} > 0 )); then
    echo "❌ Missing required tools: ${missing[*]}"
    exit 1
  fi
}

check_container() {
  if ! $DOCKER inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    echo "❌ Container '$CONTAINER' is not running"
    echo "   Start it with: $DOCKER compose up -d"
    exit 1
  fi
}

check_redis() {
  if ! curl -sf -H "Authorization: Bearer $REDIS_TOKEN" "$REDIS_URL/ping" >/dev/null 2>&1; then
    echo "❌ Cannot reach Redis at $REDIS_URL — is the stack running?"
    exit 1
  fi
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_help() {
  cat <<'HELP'
🌍 World Monitor Seed Manager (wmsm)

Usage: ./wmsm.sh <command> [options]

Commands:
  status                📊 Show freshness of all seeders
  schedule              ⏱️  Show the refresh schedule
  refresh <name>        🔄 Force re-seed a specific seeder
  refresh --all         🔄 Force re-seed everything (tiered)
  flush                 🗑️  Wipe all seed data and re-seed from scratch
  logs [--follow|--all] 📋 Show orchestrator logs
  help                  ❓ Show this help

Environment:
  REDIS_URL             Redis REST proxy URL (default: http://localhost:8079)
  REDIS_TOKEN           Redis REST auth token (default: wm-local-token)
  WM_CONTAINER          Docker container name (default: worldmonitor)
HELP
}

cmd_status() {
  header
  local now_ms
  now_ms=$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")
  local count_healthy=0 count_stale=0 count_error=0 count_skipped=0
  local current_tier=""

  for entry in "${CATALOG[@]}"; do
    IFS='|' read -r name tier interval_min ttl_sec meta_key <<< "$entry"
    local redis_key
    redis_key=$(get_meta_key "$name" "$meta_key")

    # Print tier header on tier change
    if [ "$tier" != "$current_tier" ]; then
      [ -n "$current_tier" ] && echo
      current_tier="$tier"
      local icon="" label=""
      for ti in "${TIER_ICONS[@]}"; do
        IFS='|' read -r t i l <<< "$ti"
        if [ "$t" = "$tier" ]; then icon="$i"; label="$l"; break; fi
      done
      echo "$icon ${tier^^} ($label)"
    fi

    # Fetch seed-meta from Redis
    local raw
    raw=$(redis_get "$redis_key" 2>/dev/null) || raw=""
    local result
    result=$(echo "$raw" | jq -r '.result // empty' 2>/dev/null) || result=""

    if [ -z "$result" ] || [ "$result" = "null" ]; then
      # No meta — skipped
      printf "  ⬚  %-25s no data\n" "$name"
      (( count_skipped++ )) || true
      continue
    fi

    # Parse meta fields (result is a JSON string, so parse it again)
    local fetched_at record_count duration_ms status_field error_field
    fetched_at=$(echo "$result" | jq -r '.fetchedAt // 0' 2>/dev/null) || fetched_at=0
    record_count=$(echo "$result" | jq -r '.recordCount // "-"' 2>/dev/null) || record_count="-"
    duration_ms=$(echo "$result" | jq -r '.durationMs // 0' 2>/dev/null) || duration_ms=0
    status_field=$(echo "$result" | jq -r '.status // "ok"' 2>/dev/null) || status_field="ok"
    error_field=$(echo "$result" | jq -r '.error // empty' 2>/dev/null) || error_field=""

    # Calculate age
    local age_sec=0
    if (( fetched_at > 0 )); then
      age_sec=$(( (${now_ms%???} - fetched_at / 1000) ))
      (( age_sec < 0 )) && age_sec=0
    fi

    local age_str
    age_str=$(format_age "$age_sec")
    local duration_str
    if (( duration_ms > 0 )); then
      duration_str="$(awk "BEGIN {printf \"%.1f\", $duration_ms / 1000}")s"
    else
      duration_str="—"
    fi

    local items_str
    if [ "$record_count" != "-" ] && [ "$record_count" != "null" ]; then
      items_str="${record_count} items"
    else
      items_str="—"
    fi

    # Determine status icon
    local icon
    local interval_sec=$(( interval_min * 60 ))
    if [ "$status_field" = "error" ] || [ "$status_field" = "timeout" ]; then
      icon="❌"
      (( count_error++ )) || true
    elif (( age_sec > interval_sec )); then
      icon="⚠️ "
      (( count_stale++ )) || true
    else
      icon="✅"
      (( count_healthy++ )) || true
    fi

    printf "  %s %-25s %-12s %-14s %s\n" "$icon" "$name" "$age_str" "$items_str" "$duration_str"
  done

  echo
  footer_line
  echo "✅ $count_healthy healthy  ⚠️  $count_stale stale  ❌ $count_error error  ⏭️  $count_skipped skipped"
}

cmd_schedule() {
  echo "🌍 World Monitor Seed Manager — Schedule"
  echo "══════════════════════════════════════════════════════════════"
  echo

  local now_ms
  now_ms=$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")
  local now_sec=${now_ms%???}
  local count_scheduled=0 count_skipped=0
  local current_tier=""

  for entry in "${CATALOG[@]}"; do
    IFS='|' read -r name tier interval_min ttl_sec meta_key <<< "$entry"
    local redis_key
    redis_key=$(get_meta_key "$name" "$meta_key")

    # Print tier header on tier change
    if [ "$tier" != "$current_tier" ]; then
      [ -n "$current_tier" ] && echo
      current_tier="$tier"
      local icon=""
      for ti in "${TIER_ICONS[@]}"; do
        IFS='|' read -r t i l <<< "$ti"
        if [ "$t" = "$tier" ]; then icon="$i"; break; fi
      done
      echo "$icon ${tier^^}"
    fi

    # Fetch seed-meta
    local raw result fetched_at age_sec
    raw=$(redis_get "$redis_key" 2>/dev/null) || raw=""
    result=$(echo "$raw" | jq -r '.result // empty' 2>/dev/null) || result=""

    if [ -z "$result" ] || [ "$result" = "null" ]; then
      printf "  %-25s every %s   TTL %s   ⏭️  no data\n" "$name" "$(format_interval "$interval_min")" "$(format_ttl "$ttl_sec")"
      (( count_skipped++ )) || true
      continue
    fi

    fetched_at=$(echo "$result" | jq -r '.fetchedAt // 0' 2>/dev/null) || fetched_at=0
    if (( fetched_at > 0 )); then
      age_sec=$(( now_sec - fetched_at / 1000 ))
      (( age_sec < 0 )) && age_sec=0
    else
      age_sec=0
    fi

    local age_str
    age_str=$(format_age "$age_sec")

    # Calculate next run estimate
    local interval_sec=$(( interval_min * 60 ))
    local remaining=$(( interval_sec - age_sec ))
    local next_str
    if (( remaining <= 0 )); then
      next_str="overdue"
    elif (( remaining < 60 )); then
      next_str="~${remaining}s"
    elif (( remaining < 3600 )); then
      next_str="~$(( remaining / 60 ))m"
    else
      next_str="~$(( remaining / 3600 ))h"
    fi

    printf "  %-25s every %s   TTL %s   last %-12s next %s\n" \
      "$name" "$(format_interval "$interval_min")" "$(format_ttl "$ttl_sec")" "$age_str" "$next_str"
    (( count_scheduled++ )) || true
  done

  echo
  footer_line
  echo "⏱️  $count_scheduled scheduled  ⏭️  $count_skipped skipped"
}

cmd_refresh() {
  local target="${1:-}"

  if [ -z "$target" ]; then
    echo "❌ Usage: ./wmsm.sh refresh <name> or ./wmsm.sh refresh --all"
    exit 1
  fi

  if [ "$target" = "--all" ]; then
    cmd_refresh_all
    return
  fi

  # Validate seeder name
  local found=false
  for entry in "${CATALOG[@]}"; do
    local name="${entry%%|*}"
    if [ "$name" = "$target" ]; then
      found=true
      break
    fi
  done

  if [ "$found" = false ]; then
    echo "❌ Unknown seeder: $target"
    local suggestion
    suggestion=$(suggest_seeder "$target")
    if [ -n "$suggestion" ]; then
      echo "💡 Did you mean: $suggestion?"
    fi
    exit 1
  fi

  header
  echo "🔄 Refreshing $target..."
  local start_sec
  start_sec=$(date +%s)

  if $DOCKER exec "$CONTAINER" node "scripts/seed-${target}.mjs"; then
    local dur=$(( $(date +%s) - start_sec ))
    echo "   ✅ Done in ${dur}s"
  else
    local code=$?
    local dur=$(( $(date +%s) - start_sec ))
    echo "   ❌ Failed (exit code $code) in ${dur}s"
    exit 1
  fi
}

cmd_refresh_all() {
  header
  echo "🔄 Refreshing all seeders (tiered)..."
  echo

  local total_ok=0 total_err=0 total_skip=0

  for tier_order in hot warm cold frozen; do
    # Get concurrency for this tier
    local concurrency=3
    for tc in "${TIER_CONCURRENCY[@]}"; do
      IFS='|' read -r t c <<< "$tc"
      if [ "$t" = "$tier_order" ]; then concurrency=$c; break; fi
    done

    # Get tier icon
    local icon=""
    for ti in "${TIER_ICONS[@]}"; do
      IFS='|' read -r t i l <<< "$ti"
      if [ "$t" = "$tier_order" ]; then icon="$i"; break; fi
    done

    # Collect seeders for this tier
    local tier_seeders=()
    for entry in "${CATALOG[@]}"; do
      IFS='|' read -r name tier interval_min ttl_sec meta_key <<< "$entry"
      if [ "$tier" = "$tier_order" ]; then
        tier_seeders+=("$name")
      fi
    done

    (( ${#tier_seeders[@]} == 0 )) && continue

    echo "$icon ${tier_order^^} (${#tier_seeders[@]} seeders, $concurrency at a time)"

    # Run in batches
    local idx=0
    while (( idx < ${#tier_seeders[@]} )); do
      local pids=() names=() starts=()
      local batch_size=0
      while (( batch_size < concurrency && idx < ${#tier_seeders[@]} )); do
        local sname="${tier_seeders[$idx]}"
        local start_sec
        start_sec=$(date +%s)
        $DOCKER exec "$CONTAINER" node "scripts/seed-${sname}.mjs" >/dev/null 2>&1 &
        pids+=($!)
        names+=("$sname")
        starts+=("$start_sec")
        (( idx++ )) || true
        (( batch_size++ )) || true
      done

      # Wait for batch
      for i in "${!pids[@]}"; do
        if wait "${pids[$i]}" 2>/dev/null; then
          local dur=$(( $(date +%s) - ${starts[$i]} ))
          echo "   ✅ ${names[$i]} (${dur}s)"
          (( total_ok++ )) || true
        else
          local dur=$(( $(date +%s) - ${starts[$i]} ))
          echo "   ❌ ${names[$i]} (${dur}s)"
          (( total_err++ )) || true
        fi
      done
    done
    echo
  done

  footer_line
  echo "Done: $total_ok ✅  $total_err ❌  $total_skip ⏭️"
}

cmd_flush() {
  echo "⚠️  This will delete ALL seed data and metadata from Redis."
  echo "   The orchestrator will perform a full cold start re-seed."
  echo
  read -rp "   Type 'flush' to confirm: " confirm
  if [ "$confirm" != "flush" ]; then
    echo "   Cancelled."
    exit 0
  fi

  echo
  echo "🗑️  Flushing seed data..."

  # Delete seed-meta keys
  local meta_keys
  meta_keys=$(redis_scan "seed-meta:*")
  local meta_count=0
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    redis_del "$key"
    (( meta_count++ )) || true
  done <<< "$meta_keys"
  echo "   Deleted $meta_count seed-meta keys"

  # Delete seed-lock keys
  local lock_keys
  lock_keys=$(redis_scan "seed-lock:*")
  local lock_count=0
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    redis_del "$key"
    (( lock_count++ )) || true
  done <<< "$lock_keys"
  echo "   Deleted $lock_count seed-lock keys"

  echo
  echo "🔄 Restarting orchestrator for cold start..."
  $DOCKER restart "$CONTAINER" >/dev/null 2>&1
  echo "   ✅ Container restarting — run ./wmsm.sh logs --follow to watch"
}

cmd_logs() {
  local mode="${1:---filter}"

  case "$mode" in
    --follow|-f)
      $DOCKER logs -f "$CONTAINER" 2>&1 | grep --line-buffered '\[orchestrator\]\|\[seed:'
      ;;
    --all|-a)
      $DOCKER logs "$CONTAINER" 2>&1
      ;;
    *)
      $DOCKER logs "$CONTAINER" 2>&1 | grep '\[orchestrator\]\|\[seed:'
      ;;
  esac
}

# ── Main dispatcher ──────────────────────────────────────────────────────────

main() {
  local cmd="${1:-help}"
  shift 2>/dev/null || true

  if [ "$cmd" = "help" ] || [ "$cmd" = "--help" ] || [ "$cmd" = "-h" ]; then
    cmd_help
    exit 0
  fi

  check_deps
  check_container

  case "$cmd" in
    status)   check_redis; cmd_status "$@" ;;
    schedule) check_redis; cmd_schedule "$@" ;;
    refresh)  check_redis; cmd_refresh "$@" ;;
    flush)    check_redis; cmd_flush "$@" ;;
    logs)     cmd_logs "$@" ;;
    *)
      echo "❌ Unknown command: $cmd"
      echo "   Run ./wmsm.sh help for usage"
      exit 1
      ;;
  esac
}

main "$@"
