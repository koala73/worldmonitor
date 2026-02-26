#!/bin/sh
# World Monitor — container entrypoint
# Starts the Node.js API sidecar, then nginx in the foreground.

set -e

API_PORT="${LOCAL_API_PORT:-3001}"

echo "==> Starting World Monitor API sidecar on port ${API_PORT}..."

# The API sidecar: prefer the repurposed Tauri local-api-server (primary),
# then fall back to a compiled server/index.js (legacy), then warn.
if [ -f /app/sidecar/local-api-server.mjs ]; then
    LOCAL_API_PORT="${API_PORT}" node /app/sidecar/local-api-server.mjs &
elif [ -f /app/server/index.js ]; then
    node /app/server/index.js &
elif [ -f /app/server/index.ts ]; then
    # Dev image fallback only — ts-node is not installed in production images
    npx ts-node /app/server/index.ts &
else
    echo "  [warn] No API sidecar found — API calls will fall back to worldmonitor.app (cloud)."
fi

echo "==> Starting nginx..."
# Remove default PID file location issue on alpine
nginx -g "daemon off;"
