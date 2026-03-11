#!/usr/bin/env bash

echo "Scanning repository for RSS feeds..."
echo

DIRS=("api" "server" "shared" "data" "docs")

for dir in "${DIRS[@]}"; do
  if [ -d "$dir" ]; then
    grep -rhoE "https?://[^\"' ]+" "$dir" \
    | grep -Ei "rss|feed|xml" \
    | sort -u
  fi
done | while read -r url
do
  code=$(curl -L -o /dev/null -s -w "%{http_code}" --max-time 8 "$url")

  if [[ "$code" == "200" ]]; then
    echo "✅ $url"
  else
    echo "⚠️  $code  $url"
  fi
done

echo
echo "Scan complete."
