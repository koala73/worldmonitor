#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4173}"
# Local-only by default: the dev server brokers configured API keys, so it
# should not be reachable from the network unless explicitly requested.
# Set HOST=0.0.0.0 to opt in to LAN exposure (a warning is printed).
HOST="${HOST:-localhost}"
# CCTV source packs (all keyless): Austin (~815 live upstream), Caltrans
# districts 4,7,11,3 = SF/LA/San Diego/Sacramento (~1,860 live upstream),
# TfL London JamCams (~870 live upstream). Caps keep the densest cores per
# pack; override per-run for lighter/heavier loads. Kill switches:
# CCTV_CALTRANS_DISTRICTS='' and CCTV_TFL_ENABLED=0.
CCTV_AUSTIN_MAX_SOURCES="${CCTV_AUSTIN_MAX_SOURCES:-250}"
# Use `-` not `:-` so an explicit empty string (the documented kill switch)
# is preserved rather than replaced by the default. Still set-u-safe when unset.
CCTV_CALTRANS_DISTRICTS="${CCTV_CALTRANS_DISTRICTS-4,7,11,3}"
CCTV_CALTRANS_MAX_SOURCES="${CCTV_CALTRANS_MAX_SOURCES:-300}"
CCTV_TFL_ENABLED="${CCTV_TFL_ENABLED:-1}"
CCTV_TFL_MAX_SOURCES="${CCTV_TFL_MAX_SOURCES:-250}"
CCTV_MAX_SOURCES="${CCTV_MAX_SOURCES:-900}"

if command -v npm >/dev/null 2>&1; then
  DEV_COMMAND=(npm run dev --)
elif command -v pnpm >/dev/null 2>&1; then
  DEV_COMMAND=(pnpm run dev)
else
  echo "error: neither npm nor pnpm found"
  exit 1
fi

read_dotenv_value() {
  local variable_name="$1"
  if [[ ! -f ".env" ]]; then
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; cannot parse .env" >&2
    return
  fi
  node scripts/read-dotenv-value.mjs "${variable_name}"
}

# Vite loads .env for browser build-time configuration, but this launcher needs
# the Maps key before Vite starts. Preserve a shell-provided value; otherwise
# read the project-local .env without executing it as shell code.
GOOGLE_MAPS_API_KEY_ENV="${GOOGLE_MAPS_API_KEY:-}"
GOOGLE_MAPS_API_KEY_ENV_SOURCE="env"
if [[ -z "${GOOGLE_MAPS_API_KEY_ENV}" && -f ".env" ]]; then
  GOOGLE_MAPS_API_KEY_ENV="$(read_dotenv_value "GOOGLE_MAPS_API_KEY")"
  GOOGLE_MAPS_API_KEY_ENV_SOURCE=".env"
fi
GOOGLE_MAPS_API_KEY_KEYCHAIN=""
GOOGLE_MAPS_API_KEY_SOURCE=""
if command -v security >/dev/null 2>&1; then
  for acct in "api-key" "default" "key"; do
    GOOGLE_MAPS_API_KEY_KEYCHAIN="$(security find-generic-password -s "google-maps-api" -a "${acct}" -w 2>/dev/null || true)"
    if [[ -n "${GOOGLE_MAPS_API_KEY_KEYCHAIN}" ]]; then
      GOOGLE_MAPS_API_KEY_SOURCE="keychain:${acct}"
      break
    fi
  done
fi

if [[ -n "${GOOGLE_MAPS_API_KEY_KEYCHAIN}" ]]; then
  GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY_KEYCHAIN}"
elif [[ -n "${GOOGLE_MAPS_API_KEY_ENV}" ]]; then
  GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY_ENV}"
  GOOGLE_MAPS_API_KEY_SOURCE="${GOOGLE_MAPS_API_KEY_ENV_SOURCE}"
else
  GOOGLE_MAPS_API_KEY=""
fi
if [[ -z "${GOOGLE_MAPS_API_KEY}" ]]; then
  echo "error: Google Maps API key missing."
  echo "set GOOGLE_MAPS_API_KEY in env, or add Keychain item: service=google-maps-api account=api-key"
  exit 1
fi

read_keychain_secret() {
  local service="$1"
  local account="$2"
  security find-generic-password -s "$service" -a "$account" -w 2>/dev/null || true
}

load_opensky_oauth_from_file() {
  local file_path="$1"
  if [[ -z "${file_path}" || ! -f "${file_path}" ]]; then
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; cannot parse OPENSKY_CREDENTIALS_FILE"
    return
  fi

  local parsed
  parsed="$(node -e "const fs=require('fs');const p=process.argv[1];try{const raw=JSON.parse(fs.readFileSync(p,'utf8'));const id=String(raw.clientId??raw.client_id??'').trim();const secret=String(raw.clientSecret??raw.client_secret??'').trim();process.stdout.write(id+'\\t'+secret);}catch{process.exit(1)}" -- "${file_path}" 2>/dev/null || true)"
  if [[ "${parsed}" != *$'\t'* ]]; then
    return
  fi
  local parsed_client_id="${parsed%%$'\t'*}"
  local parsed_client_secret="${parsed#*$'\t'}"

  if [[ -z "${OPENSKY_CLIENT_ID}" && -n "${parsed_client_id}" ]]; then
    OPENSKY_CLIENT_ID="${parsed_client_id}"
  fi
  if [[ -z "${OPENSKY_CLIENT_SECRET}" && -n "${parsed_client_secret}" ]]; then
    OPENSKY_CLIENT_SECRET="${parsed_client_secret}"
  fi
}

resolve_opensky_credentials() {
  OPENSKY_AUTH_MODE="${OPENSKY_AUTH_MODE:-$(read_dotenv_value "OPENSKY_AUTH_MODE")}"
  OPENSKY_AUTH_MODE="$(printf '%s' "${OPENSKY_AUTH_MODE:-oauth}" | tr '[:upper:]' '[:lower:]')"
  OPENSKY_CREDENTIALS_FILE="${OPENSKY_CREDENTIALS_FILE:-$(read_dotenv_value "OPENSKY_CREDENTIALS_FILE")}"
  case "${OPENSKY_AUTH_MODE}" in
    basic|oauth|auto|anon) ;;
    *)
      echo "warning: invalid OPENSKY_AUTH_MODE='${OPENSKY_AUTH_MODE}', defaulting to 'oauth'"
      OPENSKY_AUTH_MODE="oauth"
      ;;
  esac

  # Explicit env wins, then .env, then the credentials file / Keychain below.
  OPENSKY_CLIENT_ID="${OPENSKY_CLIENT_ID:-$(read_dotenv_value "OPENSKY_CLIENT_ID")}"
  OPENSKY_CLIENT_SECRET="${OPENSKY_CLIENT_SECRET:-$(read_dotenv_value "OPENSKY_CLIENT_SECRET")}"
  OPENSKY_USERNAME="${OPENSKY_USERNAME:-$(read_dotenv_value "OPENSKY_USERNAME")}"
  OPENSKY_PASSWORD="${OPENSKY_PASSWORD:-$(read_dotenv_value "OPENSKY_PASSWORD")}"

  if [[ "${OPENSKY_AUTH_MODE}" == "basic" || "${OPENSKY_AUTH_MODE}" == "auto" ]] && [[ -z "${OPENSKY_USERNAME}" ]]; then
    for svc in "opensky-network" "opensky"; do
      for acct in "username" "user" "login" "email" "default"; do
        OPENSKY_USERNAME="$(read_keychain_secret "${svc}" "${acct}")"
        if [[ -n "${OPENSKY_USERNAME}" ]]; then
          break 2
        fi
      done
    done
  fi
  if [[ "${OPENSKY_AUTH_MODE}" == "basic" || "${OPENSKY_AUTH_MODE}" == "auto" ]] && [[ -z "${OPENSKY_PASSWORD}" ]]; then
    for svc in "opensky-network" "opensky"; do
      for acct in "password" "pass" "token" "secret" "default"; do
        OPENSKY_PASSWORD="$(read_keychain_secret "${svc}" "${acct}")"
        if [[ -n "${OPENSKY_PASSWORD}" ]]; then
          break 2
        fi
      done
    done
  fi
  if [[ "${OPENSKY_AUTH_MODE}" == "oauth" || "${OPENSKY_AUTH_MODE}" == "auto" ]] && [[ -n "${OPENSKY_CREDENTIALS_FILE}" ]]; then
    load_opensky_oauth_from_file "${OPENSKY_CREDENTIALS_FILE}"
  fi
  if [[ "${OPENSKY_AUTH_MODE}" == "oauth" || "${OPENSKY_AUTH_MODE}" == "auto" ]] && [[ -z "${OPENSKY_CLIENT_ID}" ]]; then
    for svc in "opensky-network" "opensky"; do
      for acct in "client_id" "client-id" "client" "api-key"; do
        OPENSKY_CLIENT_ID="$(read_keychain_secret "${svc}" "${acct}")"
        if [[ -n "${OPENSKY_CLIENT_ID}" ]]; then
          break 2
        fi
      done
    done
  fi
  if [[ "${OPENSKY_AUTH_MODE}" == "oauth" || "${OPENSKY_AUTH_MODE}" == "auto" ]] && [[ -z "${OPENSKY_CLIENT_SECRET}" ]]; then
    for svc in "opensky-network" "opensky"; do
      for acct in "client_secret" "client-secret" "secret"; do
        OPENSKY_CLIENT_SECRET="$(read_keychain_secret "${svc}" "${acct}")"
        if [[ -n "${OPENSKY_CLIENT_SECRET}" ]]; then
          break 2
        fi
      done
    done
  fi

  case "${OPENSKY_AUTH_MODE}" in
    basic)
      OPENSKY_CLIENT_ID=""
      OPENSKY_CLIENT_SECRET=""
      ;;
    oauth)
      OPENSKY_USERNAME=""
      OPENSKY_PASSWORD=""
      ;;
    anon)
      OPENSKY_CLIENT_ID=""
      OPENSKY_CLIENT_SECRET=""
      OPENSKY_USERNAME=""
      OPENSKY_PASSWORD=""
      ;;
  esac
}

resolve_opensky_credentials

# Optional keys: explicit env wins, followed by .env and Keychain fallback.
# Add to Keychain with e.g.:
#   security add-generic-password -U -s "openai-api" -a "api-key" -w
OPENAI_API_KEY="${OPENAI_API_KEY:-$(read_dotenv_value "OPENAI_API_KEY")}"
AISSTREAM_API_KEY="${AISSTREAM_API_KEY:-$(read_dotenv_value "AISSTREAM_API_KEY")}"
CESIUM_ION_TOKEN="${CESIUM_ION_TOKEN:-$(read_dotenv_value "CESIUM_ION_TOKEN")}"
LL2_API_TOKEN="${LL2_API_TOKEN:-$(read_dotenv_value "LL2_API_TOKEN")}"
TOMTOM_API_KEY="${TOMTOM_API_KEY:-$(read_dotenv_value "TOMTOM_API_KEY")}"
FIRMS_MAP_KEY="${FIRMS_MAP_KEY:-$(read_dotenv_value "FIRMS_MAP_KEY")}"
OPENAI_API_KEY="${OPENAI_API_KEY:-$(read_keychain_secret "openai-api" "api-key")}"
AISSTREAM_API_KEY="${AISSTREAM_API_KEY:-$(read_keychain_secret "aisstream-api" "api-key")}"
CESIUM_ION_TOKEN="${CESIUM_ION_TOKEN:-$(read_keychain_secret "cesium-ion" "token")}"
TOMTOM_API_KEY="${TOMTOM_API_KEY:-$(read_keychain_secret "tomtom-api" "api-key")}"
FIRMS_MAP_KEY="${FIRMS_MAP_KEY:-$(read_keychain_secret "firms-map" "map-key")}"

if [[ ! -f "src/data/cctv.js" ]]; then
  echo "error: expected CCTV layer file missing: src/data/cctv.js"
  exit 1
fi

if ! grep -q "dataManager.register(cctvLayer)" src/main.js; then
  echo "error: CCTV layer not wired in src/main.js"
  exit 1
fi

echo "Stopping all existing God's Eye View dev servers..."
pkill -f "${ROOT_DIR}/node_modules/.bin/vite" >/dev/null 2>&1 || true
pkill -f "${ROOT_DIR}/node_modules/vite/bin/vite.js" >/dev/null 2>&1 || true

# Also clear the requested port in case it is held by a stale wrapper or a
# server started through a different package-manager command.
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${PIDS}" ]]; then
    echo "${PIDS}" | xargs kill -9 >/dev/null 2>&1 || true
  fi
fi

echo "Clearing Vite cache..."
rm -rf node_modules/.vite

echo "Starting fresh God's Eye View dev server..."
case "${HOST}" in
  localhost|127.0.0.1|::1)
    echo "Local-only mode: reachable at http://localhost:${PORT}/ (set HOST=0.0.0.0 for LAN)"
    ;;
  *)
    LAN_IP=""
    if command -v ipconfig >/dev/null 2>&1; then
      # macOS: first active interface wins
      for iface in en0 en1; do
        LAN_IP="$(ipconfig getifaddr "${iface}" 2>/dev/null || true)"
        [[ -n "${LAN_IP}" ]] && break
      done
    elif command -v hostname >/dev/null 2>&1; then
      # Linux: hostname -I lists addresses; take the first
      LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
    echo ""
    echo "!! =============================================================="
    echo "!! WARNING: HOST=${HOST} — network-exposed mode."
    echo "!! This dev server brokers your configured API keys (OpenAI,"
    echo "!! OpenSky, AISStream, TomTom, FIRMS, LL2, Google) to ANYONE who can"
    echo "!! reach it on the network. Use only on networks you trust."
    echo "!! Consider the opt-in per-IP throttles GEV_RATELIMIT_OPENAI_PER_MIN"
    echo "!! and GEV_RATELIMIT_GOOGLE_PER_MIN (see .env.example) — and note"
    echo "!! they are NOT billing caps; set provider-side budget alerts too."
    if [[ -n "${LAN_IP}" ]]; then
      echo "!! LAN URL: http://${LAN_IP}:${PORT}/"
    else
      echo "!! LAN URL: http://<this-machine-ip>:${PORT}/"
    fi
    echo "!! =============================================================="
    echo ""
    echo "URL (this machine): http://localhost:${PORT}/"
    ;;
esac
echo "Google Maps key source: ${GOOGLE_MAPS_API_KEY_SOURCE}"
echo "Tip: after server starts, hard refresh browser (Cmd+Shift+R)."
echo "If panels are still missing, run this once in browser console:"
echo "localStorage.removeItem('godsEyeView.v6.panelPos.cctv-panel'); location.reload();"
echo "OpenSky auth mode: ${OPENSKY_AUTH_MODE}"
if [[ -n "${OPENSKY_CREDENTIALS_FILE}" ]]; then
  if [[ -f "${OPENSKY_CREDENTIALS_FILE}" ]]; then
    echo "OpenSky credentials file: ${OPENSKY_CREDENTIALS_FILE}"
  else
    echo "OpenSky credentials file: ${OPENSKY_CREDENTIALS_FILE} (missing)"
  fi
fi
case "${OPENSKY_AUTH_MODE}" in
  basic)
    if [[ -n "${OPENSKY_USERNAME}" && -n "${OPENSKY_PASSWORD}" ]]; then
      echo "OpenSky basic auth: configured"
    else
      echo "OpenSky basic auth: missing credentials"
    fi
    ;;
  oauth)
    if [[ -n "${OPENSKY_CLIENT_ID}" && -n "${OPENSKY_CLIENT_SECRET}" ]]; then
      echo "OpenSky OAuth: configured"
    else
      echo "OpenSky OAuth: missing client credentials"
    fi
    ;;
  auto)
    if [[ -n "${OPENSKY_CLIENT_ID}" && -n "${OPENSKY_CLIENT_SECRET}" ]]; then
      echo "OpenSky auto auth: OAuth configured"
    elif [[ -n "${OPENSKY_USERNAME}" && -n "${OPENSKY_PASSWORD}" ]]; then
      echo "OpenSky auto auth: basic configured"
    else
      echo "OpenSky auto auth: no credentials found"
    fi
    ;;
  anon)
    echo "OpenSky auth: disabled (anonymous mode)"
    ;;
esac
[[ -n "${OPENAI_API_KEY}" ]] && echo "OpenAI key (voice + HUD summary): configured" || echo "OpenAI key (voice + HUD summary): not set — GEV MIC disabled"
[[ -n "${AISSTREAM_API_KEY}" ]] && echo "AISStream key (live vessels): configured" || echo "AISStream key (live vessels): not set — ships layer empty"
[[ -n "${CESIUM_ION_TOKEN}" ]] && echo "Cesium ion token (Bing map stacks): configured" || echo "Cesium ion token (Bing map stacks): not set — Google 3D/OSM only"
[[ -n "${TOMTOM_API_KEY}" ]] && echo "TomTom key (live traffic flow): configured" || echo "TomTom key (live traffic flow): not set — simulated traffic"
[[ -n "${FIRMS_MAP_KEY}" ]] && echo "NASA FIRMS key (live fires): configured" || echo "NASA FIRMS key (live fires): not set — fires layer requires a key"
[[ -n "${LL2_API_TOKEN}" ]] && echo "Launch Library 2 token: configured" || echo "Launch Library 2 token: not set — using public access"

# Build the dev server environment explicitly. A value that resolved to
# nothing is left UNSET instead of being exported empty: Vite backfills its
# own .env values only for variables it finds undefined, so an empty export
# would shadow a key the user did configure in .env.
DEV_ENV=()
DEV_UNSET=()
put_env() {
  DEV_ENV+=("$1=$2")
}
put_env_if_set() {
  if [[ -n "$2" ]]; then
    DEV_ENV+=("$1=$2")
  else
    # Leaving it out is not enough: the child inherits this shell's
    # environment, so an empty export made in the PARENT would pass straight
    # through and shadow .env just the same. Remove it from the child outright.
    DEV_UNSET+=(-u "$1")
  fi
}

put_env GOOGLE_MAPS_API_KEY "${GOOGLE_MAPS_API_KEY}"
put_env CCTV_AUSTIN_MAX_SOURCES "${CCTV_AUSTIN_MAX_SOURCES}"
# Empty is the documented Caltrans kill switch, so this one is passed as-is.
put_env CCTV_CALTRANS_DISTRICTS "${CCTV_CALTRANS_DISTRICTS}"
put_env CCTV_CALTRANS_MAX_SOURCES "${CCTV_CALTRANS_MAX_SOURCES}"
put_env CCTV_TFL_ENABLED "${CCTV_TFL_ENABLED}"
put_env CCTV_TFL_MAX_SOURCES "${CCTV_TFL_MAX_SOURCES}"
put_env_if_set TFL_APP_KEY "${TFL_APP_KEY:-}"
put_env CCTV_MAX_SOURCES "${CCTV_MAX_SOURCES}"
put_env OPENSKY_AUTH_MODE "${OPENSKY_AUTH_MODE}"
put_env_if_set OPENSKY_CREDENTIALS_FILE "${OPENSKY_CREDENTIALS_FILE}"
put_env_if_set OPENSKY_CLIENT_ID "${OPENSKY_CLIENT_ID}"
put_env_if_set OPENSKY_CLIENT_SECRET "${OPENSKY_CLIENT_SECRET}"
put_env_if_set OPENSKY_USERNAME "${OPENSKY_USERNAME}"
put_env_if_set OPENSKY_PASSWORD "${OPENSKY_PASSWORD}"
put_env_if_set OPENAI_API_KEY "${OPENAI_API_KEY}"
put_env_if_set AISSTREAM_API_KEY "${AISSTREAM_API_KEY}"
put_env_if_set CESIUM_ION_TOKEN "${CESIUM_ION_TOKEN}"
put_env_if_set TOMTOM_API_KEY "${TOMTOM_API_KEY}"
put_env_if_set FIRMS_MAP_KEY "${FIRMS_MAP_KEY}"
put_env_if_set LL2_API_TOKEN "${LL2_API_TOKEN}"

env ${DEV_UNSET[@]+"${DEV_UNSET[@]}"} "${DEV_ENV[@]}" "${DEV_COMMAND[@]}" --host "${HOST}" --port "${PORT}" --force
