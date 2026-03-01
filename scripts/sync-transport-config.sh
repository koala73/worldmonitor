#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${1:-$ROOT_DIR/server/worldmonitor/transport/private/transport.local.txt}"
ENV_LOCAL="$ROOT_DIR/.env.local"
ENV_TRANSPORT="$ROOT_DIR/server/worldmonitor/transport/private/.env.transport.local"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[transport-sync] Missing config file: $CONFIG_FILE" >&2
  echo "[transport-sync] Copy example: server/worldmonitor/transport/v1/transport-config.example.txt" >&2
  exit 1
fi

if [[ -z "$(grep -E '^[a-zA-Z0-9_]+=' "$CONFIG_FILE" || true)" ]]; then
  echo "[transport-sync] Config file appears empty: $CONFIG_FILE" >&2
  echo "[transport-sync] Add provider keys in transport.local.txt before syncing." >&2
  exit 1
fi

read_cfg() {
  local key="$1"
  local val
  val="$(grep -E "^${key}=" "$CONFIG_FILE" | tail -n1 | cut -d'=' -f2- || true)"
  val="${val%\"}"
  val="${val#\"}"
  val="$(echo "$val" | tr '[:upper:]' '[:lower:]' | xargs)"
  echo "$val"
}

has_source() {
  local list="$1"
  local source="$2"
  echo " $list " | tr ',' ' ' | grep -qiE "(^|[[:space:]])${source}([[:space:]]|$)"
}

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"

  if [[ ! -f "$file" ]]; then
    touch "$file"
  fi

  if grep -qE "^${key}=" "$file"; then
    sed -i '' "s#^${key}=.*#${key}=${value}#" "$file"
  else
    printf "\n%s=%s\n" "$key" "$value" >> "$file"
  fi
}

ADSB_SOURCE="$(read_cfg "adsb_source")"
ADSB_APIKEY_RAW="$(grep -E '^adsb_apikey=' "$CONFIG_FILE" | tail -n1 | cut -d'=' -f2- || true)"
ADSB_APIKEY_RAW="${ADSB_APIKEY_RAW%\"}"
ADSB_APIKEY_RAW="${ADSB_APIKEY_RAW#\"}"
ADSB_BASE_URL_RAW="$(grep -E '^adsb_base_url=' "$CONFIG_FILE" | tail -n1 | cut -d'=' -f2- || true)"
ADSB_BASE_URL_RAW="${ADSB_BASE_URL_RAW%\"}"
ADSB_BASE_URL_RAW="${ADSB_BASE_URL_RAW#\"}"
ADSB_BASE_URL_RAW="$(echo "$ADSB_BASE_URL_RAW" | xargs)"
OPENSKY_CLIENT_ID_RAW="$(grep -E '^opensky_client_id=' "$CONFIG_FILE" | tail -n1 | cut -d'=' -f2- || true)"
OPENSKY_CLIENT_ID_RAW="${OPENSKY_CLIENT_ID_RAW%\"}"
OPENSKY_CLIENT_ID_RAW="${OPENSKY_CLIENT_ID_RAW#\"}"
OPENSKY_CLIENT_ID_RAW="$(echo "$OPENSKY_CLIENT_ID_RAW" | xargs)"
OPENSKY_CLIENT_SECRET_RAW="$(grep -E '^opensky_client_secret=' "$CONFIG_FILE" | tail -n1 | cut -d'=' -f2- || true)"
OPENSKY_CLIENT_SECRET_RAW="${OPENSKY_CLIENT_SECRET_RAW%\"}"
OPENSKY_CLIENT_SECRET_RAW="${OPENSKY_CLIENT_SECRET_RAW#\"}"
OPENSKY_CLIENT_SECRET_RAW="$(echo "$OPENSKY_CLIENT_SECRET_RAW" | xargs)"
AIS_SOURCE="$(read_cfg "ais_source")"
AIS_KEY_RAW="$(grep -E '^ais_key=' "$CONFIG_FILE" | tail -n1 | cut -d'=' -f2- || true)"
AIS_KEY_RAW="${AIS_KEY_RAW%\"}"
AIS_KEY_RAW="${AIS_KEY_RAW#\"}"
RELAY_URL_RAW="$(grep -E '^relay_url=' "$CONFIG_FILE" | tail -n1 | cut -d'=' -f2- || true)"
RELAY_URL_RAW="${RELAY_URL_RAW%\"}"
RELAY_URL_RAW="${RELAY_URL_RAW#\"}"
RELAY_URL_RAW="$(echo "$RELAY_URL_RAW" | xargs)"

ENABLE_OPENSKY="false"
ENABLE_FR24="false"
ENABLE_AISSTREAM="false"
ENABLE_MARINETRAFFIC="false"
ENABLE_VESSELFINDER="false"

if has_source "$ADSB_SOURCE" "opensky"; then ENABLE_OPENSKY="true"; fi
if has_source "$ADSB_SOURCE" "fr24"; then ENABLE_FR24="true"; fi
if has_source "$AIS_SOURCE" "aisstream"; then ENABLE_AISSTREAM="true"; fi
if has_source "$AIS_SOURCE" "marinetraffic"; then ENABLE_MARINETRAFFIC="true"; fi
if has_source "$AIS_SOURCE" "vesselfinder"; then ENABLE_VESSELFINDER="true"; fi

if [[ -z "$RELAY_URL_RAW" ]]; then
  RELAY_URL_RAW="ws://localhost:3004"
fi

for f in "$ENV_LOCAL" "$ENV_TRANSPORT"; do
  upsert_env "$f" "ENABLE_OPENSKY_ADSB" "$ENABLE_OPENSKY"
  upsert_env "$f" "ENABLE_FR24" "$ENABLE_FR24"
  upsert_env "$f" "ENABLE_AISSTREAM_AIS" "$ENABLE_AISSTREAM"
  upsert_env "$f" "ENABLE_MARINETRAFFIC" "$ENABLE_MARINETRAFFIC"
  upsert_env "$f" "ENABLE_VESSELFINDER_AIS" "$ENABLE_VESSELFINDER"

  upsert_env "$f" "AISSTREAM_API_KEY" "$AIS_KEY_RAW"
  upsert_env "$f" "FR24_API_KEY" "$ADSB_APIKEY_RAW"
  upsert_env "$f" "FR24_API_BASE_URL" "$ADSB_BASE_URL_RAW"
  upsert_env "$f" "OPENSKY_CLIENT_ID" "$OPENSKY_CLIENT_ID_RAW"
  upsert_env "$f" "OPENSKY_CLIENT_SECRET" "$OPENSKY_CLIENT_SECRET_RAW"

  upsert_env "$f" "WS_RELAY_URL" "$RELAY_URL_RAW"
  upsert_env "$f" "VITE_WS_RELAY_URL" "$RELAY_URL_RAW"
done

echo "[transport-sync] Updated:"
echo "  - $ENV_LOCAL"
echo "  - $ENV_TRANSPORT"
echo "[transport-sync] ADS-B: $ADSB_SOURCE"
echo "[transport-sync] AIS:   $AIS_SOURCE"

if has_source "$ADSB_SOURCE" "opensky" && [[ -z "$OPENSKY_CLIENT_ID_RAW" || -z "$OPENSKY_CLIENT_SECRET_RAW" ]]; then
  echo "[transport-sync] Warning: OpenSky selected but opensky_client_id/opensky_client_secret is empty." >&2
fi
if has_source "$ADSB_SOURCE" "fr24" && [[ -z "$ADSB_APIKEY_RAW" || -z "$ADSB_BASE_URL_RAW" ]]; then
  echo "[transport-sync] Warning: FR24 selected but adsb_apikey/adsb_base_url is empty." >&2
fi
if has_source "$AIS_SOURCE" "aisstream" && [[ -z "$AIS_KEY_RAW" ]]; then
  echo "[transport-sync] Warning: AISStream selected but ais_key is empty." >&2
fi
