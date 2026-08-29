#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v security >/dev/null 2>&1; then
  echo "error: macOS 'security' command not found"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to parse JSON credentials"
  exit 1
fi

CREDENTIALS_FILE="${1:-${OPENSKY_CREDENTIALS_FILE:-}}"
if [[ -z "${CREDENTIALS_FILE}" ]]; then
  echo "usage: ./scripts/opensky-import-client.sh /path/to/credentials.json"
  echo "or set OPENSKY_CREDENTIALS_FILE and run ./scripts/opensky-import-client.sh"
  exit 1
fi

if [[ ! -f "${CREDENTIALS_FILE}" ]]; then
  echo "error: credentials file not found: ${CREDENTIALS_FILE}"
  exit 1
fi

PARSED="$(node -e "const fs=require('fs');const p=process.argv[1];const raw=JSON.parse(fs.readFileSync(p,'utf8'));const id=String(raw.clientId??raw.client_id??'').trim();const secret=String(raw.clientSecret??raw.client_secret??'').trim();if(!id||!secret){process.exit(2)};process.stdout.write(id+'\t'+secret);" "${CREDENTIALS_FILE}" 2>/dev/null || true)"
if [[ "${PARSED}" != *$'\t'* ]]; then
  echo "error: could not parse clientId/clientSecret from ${CREDENTIALS_FILE}"
  exit 1
fi

CLIENT_ID="${PARSED%%$'\t'*}"
CLIENT_SECRET="${PARSED#*$'\t'}"
if [[ -z "${CLIENT_ID}" || -z "${CLIENT_SECRET}" ]]; then
  echo "error: credentials file is missing client id or client secret"
  exit 1
fi

security add-generic-password -U -s "opensky-network" -a "client_id" -w "${CLIENT_ID}" >/dev/null
security add-generic-password -U -s "opensky-network" -a "client_secret" -w "${CLIENT_SECRET}" >/dev/null

echo "OpenSky OAuth client credentials stored in Keychain:"
echo "  service=opensky-network account=client_id"
echo "  service=opensky-network account=client_secret"
