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

# Self-host premium unlock: expose WORLDMONITOR_API_KEY to the SPA at runtime.
# The web build has no keyring and no build-time env, so runtime-config.ts
# reads window.__WM_RUNTIME_ENV__ (see readEnvSecret). Written as a
# same-origin classic script (CSP script-src 'self' allows it; inline would
# not) and referenced at the top of <head> so it runs before the module
# bundle seeds secrets.
# NOTE: this hands the key to anyone who can load the page — intended for a
# single-operator LAN deployment where the key's only power is unlocking
# this same server's premium endpoints.
WEBROOT=/usr/share/nginx/html
if [ -n "${WORLDMONITOR_API_KEY:-}" ] && [ -w "$WEBROOT" ]; then
  node -e '
    const key = process.env.WORLDMONITOR_API_KEY;
    require("node:fs").writeFileSync(
      "/usr/share/nginx/html/wm-runtime-env.js",
      "window.__WM_RUNTIME_ENV__=" + JSON.stringify({ WORLDMONITOR_API_KEY: key }) + ";\n"
    );
  '
  find "$WEBROOT" -maxdepth 2 -name index.html | while read -r html; do
    if ! grep -q 'wm-runtime-env.js' "$html"; then
      sed -i 's|<head>|<head><script src="/wm-runtime-env.js"></script>|' "$html"
    fi
  done
fi

envsubst '$LOCAL_API_PORT $LOCAL_API_TOKEN' < /etc/nginx/nginx.conf.template > /tmp/nginx.conf
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/worldmonitor.conf
