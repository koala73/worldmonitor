#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4173}"
# Local-only by default; set HOST=0.0.0.0 explicitly to expose on the LAN.
HOST="${HOST:-localhost}"

GOOGLE_MAPS_API_KEY_ENV="${GOOGLE_MAPS_API_KEY:-}"
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
  GOOGLE_MAPS_API_KEY_SOURCE="env"
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
  parsed="$(node -e "const fs=require('fs');const p=process.argv[1];try{const raw=JSON.parse(fs.readFileSync(p,'utf8'));const id=String(raw.clientId??raw.client_id??'').trim();const secret=String(raw.clientSecret??raw.client_secret??'').trim();process.stdout.write(id+'\\t'+secret);}catch{process.exit(1)}" "${file_path}" 2>/dev/null || true)"
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
  OPENSKY_AUTH_MODE="$(printf '%s' "${OPENSKY_AUTH_MODE:-oauth}" | tr '[:upper:]' '[:lower:]')"
  OPENSKY_CREDENTIALS_FILE="${OPENSKY_CREDENTIALS_FILE:-}"
  case "${OPENSKY_AUTH_MODE}" in
    basic|oauth|auto|anon) ;;
    *)
      echo "warning: invalid OPENSKY_AUTH_MODE='${OPENSKY_AUTH_MODE}', defaulting to 'oauth'"
      OPENSKY_AUTH_MODE="oauth"
      ;;
  esac

  OPENSKY_CLIENT_ID="${OPENSKY_CLIENT_ID:-}"
  OPENSKY_CLIENT_SECRET="${OPENSKY_CLIENT_SECRET:-}"
  OPENSKY_USERNAME="${OPENSKY_USERNAME:-}"
  OPENSKY_PASSWORD="${OPENSKY_PASSWORD:-}"

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

CCTV_AUSTIN_MAX_SOURCES="${CCTV_AUSTIN_MAX_SOURCES:-36}"
CCTV_MAX_SOURCES="${CCTV_MAX_SOURCES:-48}"

echo "Starting God's Eye View dev server..."
echo "URL: http://localhost:${PORT}/"
echo "Google Maps key source: ${GOOGLE_MAPS_API_KEY_SOURCE}"
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

GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY}" \
CCTV_AUSTIN_MAX_SOURCES="${CCTV_AUSTIN_MAX_SOURCES}" \
CCTV_MAX_SOURCES="${CCTV_MAX_SOURCES}" \
OPENSKY_AUTH_MODE="${OPENSKY_AUTH_MODE}" \
OPENSKY_CREDENTIALS_FILE="${OPENSKY_CREDENTIALS_FILE}" \
OPENSKY_CLIENT_ID="${OPENSKY_CLIENT_ID}" \
OPENSKY_CLIENT_SECRET="${OPENSKY_CLIENT_SECRET}" \
OPENSKY_USERNAME="${OPENSKY_USERNAME}" \
OPENSKY_PASSWORD="${OPENSKY_PASSWORD}" \
npm run dev -- --host "${HOST}" --port "${PORT}"
