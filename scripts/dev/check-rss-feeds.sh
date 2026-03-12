#!/usr/bin/env bash
set -euo pipefail

USER_AGENT="Mozilla/5.0 (compatible; WorldMonitor-RSS-Check/1.0)"
MAX_TIME="${MAX_TIME:-8}"
CONCURRENCY="${CONCURRENCY:-5}"

echo "Scanning RSS source files..."
echo

FILES=("shared/rss-allowed-domains.json")

urls=$(grep -Eo "https?://[a-zA-Z0-9./:_?&=%+-]+" "${FILES[@]}" | sort -u)

check_feed() {
  url="$1"

  status=$(curl -L \
    -H "User-Agent: $USER_AGENT" \
    --max-time "$MAX_TIME" \
    -o /dev/null -s -w "%{http_code}" "$url")

  if [[ "$status" != "200" ]]; then
    echo "⚠️  $status  $url"
    return
  fi

  body=$(curl -L \
    -H "User-Agent: $USER_AGENT" \
    --max-time "$MAX_TIME" \
    -s "$url")

  if echo "$body" | grep -qiE "<rss|<feed"; then
    echo "✅ RSS OK  $url"
  else
    echo "⚠️  Not RSS  $url"
  fi
}

export -f check_feed
export USER_AGENT MAX_TIME

echo "$urls" | xargs -P"$CONCURRENCY" -I{} bash -c 'check_feed "$@"' _ {}

echo
echo "Scan complete."
