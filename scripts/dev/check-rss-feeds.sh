#!/usr/bin/env bash
set -euo pipefail

echo "Scanning repository for RSS feeds..."
echo

# find URLs but exclude large directories
grep -rhoE "https?://[a-zA-Z0-9./:_?&=%+-]+" . \
--exclude-dir=node_modules \
--exclude-dir=.git \
--exclude-dir=dist \
--exclude-dir=build \
| sort -u \
| while read -r url
do
  # additional validation
  if [[ "$url" =~ ^https?://[a-zA-Z0-9./:_?&=%+-]+$ ]]; then
    code=$(curl -L --max-time "${MAX_TIME:-8}" \
      -o /dev/null -s -w "%{http_code}" --url "$url")

    if [[ "$code" == "200" ]]; then
      echo "✅ $url"
    else
      echo "⚠️  $code  $url"
    fi
  fi
done

echo
echo "Scan complete."
