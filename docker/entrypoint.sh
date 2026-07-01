#!/bin/sh
set -e

# Docker secrets → env var bridge
# Reads /run/secrets/KEYNAME files and exports as env vars.
# Secrets take priority over env vars set via docker-compose environment block.
if [ -d /run/secrets ]; then
  for secret_file in /run/secrets/*; do
    [ -f "$secret_file" ] || continue
    key=$(basename "$secret_file")
    value=$(cat "$secret_file" | tr -d '\n')
    export "$key"="$value"
  done
fi

export LOCAL_API_PORT="${LOCAL_API_PORT:-46123}"
if [ -z "${LOCAL_API_TOKEN:-}" ]; then
  LOCAL_API_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
  export LOCAL_API_TOKEN
fi

# Render Blueprint: map private-network hostports to URLs the app expects.
export UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-${REDIS_TOKEN:-}}"
if [ -n "${REDIS_REST_HOSTPORT:-}" ] && [ -z "${UPSTASH_REDIS_REST_URL:-}" ]; then
  export UPSTASH_REDIS_REST_URL="http://${REDIS_REST_HOSTPORT}"
fi
if [ -n "${AIS_RELAY_HOSTPORT:-}" ] && [ -z "${WS_RELAY_URL:-}" ]; then
  export WS_RELAY_URL="http://${AIS_RELAY_HOSTPORT}"
fi

envsubst '$LOCAL_API_PORT $LOCAL_API_TOKEN' < /etc/nginx/nginx.conf.template > /tmp/nginx.conf
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/worldmonitor.conf
