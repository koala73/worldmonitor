#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: bash scripts/research-eval.sh <alerting|source-trust|map-perf|rotation>"
}

TRACK="${1:-}"
if [[ -z "$TRACK" || "$TRACK" == "--help" || "$TRACK" == "-h" ]]; then
  usage
  [[ -n "$TRACK" ]] && exit 0
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

if [[ "$TRACK" == "rotation" ]]; then
  case "$(date +%u)" in
    1|4) TRACK="alerting" ;;
    2|5) TRACK="source-trust" ;;
    3|6|7) TRACK="map-perf" ;;
  esac
fi

PROGRAM_PATH="research/programs/${TRACK}.md"
if [[ ! -f "$PROGRAM_PATH" ]]; then
  echo "Unknown research track: $TRACK"
  usage
  exit 1
fi

declare -a COMMANDS
case "$TRACK" in
  alerting)
    COMMANDS=(
      "npm run typecheck:all"
      "npm run test:e2e:runtime"
    )
    ;;
  source-trust)
    COMMANDS=(
      "npm run typecheck:all"
      "npm run test:data"
    )
    ;;
  map-perf)
    COMMANDS=(
      "npm run typecheck:all"
      "npm run test:e2e:runtime"
    )
    ;;
  *)
    echo "Unknown research track: $TRACK"
    exit 1
    ;;
esac

RUN_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
RUN_DIR="research/runs/${RUN_STAMP}-${TRACK}"
mkdir -p "$RUN_DIR"

SUMMARY_PATH="${RUN_DIR}/summary.md"
{
  echo "# Research Run"
  echo
  echo "- Track: \`$TRACK\`"
  echo "- Started: \`$RUN_TS\`"
  echo "- Program: \`$PROGRAM_PATH\`"
  echo
  echo "## Commands"
} > "$SUMMARY_PATH"

STATUS="pass"
INDEX=1

for CMD in "${COMMANDS[@]}"; do
  LABEL="$(printf '%s' "$CMD" | tr ' /:' '-' | tr -cd '[:alnum:]-')"
  LOG_PATH="$(printf '%s/%02d-%s.log' "$RUN_DIR" "$INDEX" "$LABEL")"

  echo
  echo "[$TRACK] Running: $CMD"
  echo "- \`$CMD\`" >> "$SUMMARY_PATH"

  if bash -lc "$CMD" > "$LOG_PATH" 2>&1; then
    echo "  status: PASS"
    {
      echo
      echo "### Command ${INDEX}"
      echo "- Command: \`$CMD\`"
      echo "- Status: PASS"
      echo "- Log: \`$LOG_PATH\`"
    } >> "$SUMMARY_PATH"
  else
    EXIT_CODE=$?
    STATUS="fail"
    echo "  status: FAIL ($EXIT_CODE)"
    {
      echo
      echo "### Command ${INDEX}"
      echo "- Command: \`$CMD\`"
      echo "- Status: FAIL ($EXIT_CODE)"
      echo "- Log: \`$LOG_PATH\`"
    } >> "$SUMMARY_PATH"
  fi

  INDEX=$((INDEX + 1))
done

printf '%s\t%s\t%s\t%s\t%s\n' \
  "$RUN_TS" \
  "$TRACK" \
  "$STATUS" \
  "$RUN_DIR" \
  "$(IFS=' ; '; echo "${COMMANDS[*]}")" >> research/results.tsv

echo
echo "Wrote summary: $SUMMARY_PATH"
echo "Appended ledger row to research/results.tsv"

[[ "$STATUS" == "pass" ]]
