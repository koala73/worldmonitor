#!/bin/sh
set -e

# ────────────────────────────────────────────────────────────────────────────────
# Docker Secrets → Environment Variable Bridge
#
# Docker secrets are mounted as files at /run/secrets/KEYNAME.
# This loop reads each secret file and exports its contents as an
# environment variable, making them available to local-api-server.mjs
# via process.env without any source code changes.
#
# Usage in docker-compose.yml:
#   secrets:
#     GROQ_API_KEY:
#       file: ./secrets/groq_api_key.txt
#   services:
#     worldmonitor:
#       secrets:
#         - GROQ_API_KEY
# ────────────────────────────────────────────────────────────────────────────────
if [ -d /run/secrets ]; then
  for secret_file in /run/secrets/*; do
    if [ -f "$secret_file" ]; then
      key=$(basename "$secret_file")
      value=$(cat "$secret_file" | tr -d '\n')
      export "$key"="$value"
      echo "[entrypoint] loaded secret: $key"
    fi
  done
fi

# ────────────────────────────────────────────────────────────────────────────────
# Configure local-api-server defaults for Docker mode
# ────────────────────────────────────────────────────────────────────────────────
export LOCAL_API_PORT="${LOCAL_API_PORT:-46123}"
export LOCAL_API_MODE="${LOCAL_API_MODE:-docker}"
export LOCAL_API_CLOUD_FALLBACK="${LOCAL_API_CLOUD_FALLBACK:-true}"
export LOCAL_API_RESOURCE_DIR="/app"

# ────────────────────────────────────────────────────────────────────────────────
# Start supervisord (manages nginx + node)
# ────────────────────────────────────────────────────────────────────────────────
echo "[entrypoint] starting supervisord"
exec supervisord -c /etc/supervisord.conf
