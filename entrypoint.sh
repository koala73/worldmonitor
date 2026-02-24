#!/bin/sh
set -e

# ── AIS Relay (vessel tracking) ──
if [ -n "$AISSTREAM_API_KEY" ]; then
  echo "[worldmonitor] Starting AIS relay on port 3004..."
  node /app/scripts/ais-relay.cjs &
  AIS_PID=$!
else
  echo "[worldmonitor] AISSTREAM_API_KEY not set, skipping AIS relay"
  AIS_PID=""
fi

echo "[worldmonitor] Starting API sidecar (Node.js) on port 46123..."
node /app/sidecar/local-api-server.mjs &
SIDECAR_PID=$!

# Wait for sidecar to be ready
for i in $(seq 1 30); do
  if wget -q -O /dev/null http://127.0.0.1:46123/api/service-status 2>/dev/null; then
    echo "[worldmonitor] API sidecar ready"
    break
  fi
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    echo "[worldmonitor] API sidecar crashed during startup"
    exit 1
  fi
  sleep 1
done

echo "[worldmonitor] Starting nginx on port 8080..."
nginx -g 'daemon off;' &
NGINX_PID=$!

# Trap signals and forward to all processes
trap 'kill $SIDECAR_PID $NGINX_PID $AIS_PID 2>/dev/null; wait' TERM INT QUIT

# Wait for any process to exit
wait -n $SIDECAR_PID $NGINX_PID ${AIS_PID:-} 2>/dev/null || true
echo "[worldmonitor] A process exited, shutting down..."
kill $SIDECAR_PID $NGINX_PID $AIS_PID 2>/dev/null
wait
