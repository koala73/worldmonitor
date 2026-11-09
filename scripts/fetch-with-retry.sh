#!/usr/bin/env bash
# Download one URL to a file, retrying transient failures with backoff.
#
# usage: fetch-with-retry.sh <url> <dest>
#
# GitHub release downloads return 5xx for minutes at a time during outages: the
# Desktop Canary failed twice, two minutes apart, on one `http status: 504` for
# a Tauri AppImage tool (run 42567226797). This waits out an outage of up to
# about six minutes. The file is written to a temporary path and moved into
# place only after a complete download, so a partial file can never stand in
# for the real one (the Tauri bundler skips any tool file that exists).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <url> <dest>" >&2
  exit 2
fi

URL=$1
DEST=$2
# Seconds to wait before each retry; one attempt more than there are delays.
DELAYS=(10 20 40 60 90 120)
TMP="${DEST}.part.$$"
trap 'rm -f "$TMP"' EXIT

mkdir -p "$(dirname "$DEST")"
attempt=1
while :; do
  if curl --fail --location --silent --show-error \
    --connect-timeout 20 --max-time 300 \
    --output "$TMP" "$URL"; then
    mv -f "$TMP" "$DEST"
    exit 0
  fi
  if [ "$attempt" -gt "${#DELAYS[@]}" ]; then
    echo "::error::Download failed after $attempt attempts: $URL" >&2
    exit 1
  fi
  delay=${DELAYS[$((attempt - 1))]}
  echo "::warning::Download attempt $attempt failed for $URL; retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
