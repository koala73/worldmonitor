#!/bin/sh
# Run all seed scripts against the local Redis REST proxy.
# Usage: ./scripts/run-seeders.sh
#
# Requires the worldmonitor stack to be running (uvx podman-compose up -d).
# The Redis REST proxy listens on localhost:8079 by default.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load REDIS_TOKEN (and any seeder API keys present) from .env so the
# host-side seeders can talk to the REST proxy with the same bearer the
# compose stack is using. Defaults removed in #3804 — the seeders fail-loud
# if REDIS_TOKEN is not in the environment or .env.
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi

UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
# This script targets the LOCAL Docker REST proxy, so REDIS_TOKEN always
# wins if set — even when UPSTASH_REDIS_REST_TOKEN also appears in .env
# (e.g. a contributor who also works on the Vercel/Upstash side and keeps
# the production token in the same file). Otherwise we'd silently send a
# Vercel-Upstash bearer to localhost:8079 and the proxy would 401 the
# request with no hint about why. Reviewer caught this on PR #3829.
if [ -n "${REDIS_TOKEN:-}" ]; then
  UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"
fi
if [ -z "${UPSTASH_REDIS_REST_TOKEN:-}" ]; then
  echo "ERROR: REDIS_TOKEN (or UPSTASH_REDIS_REST_TOKEN) is required." >&2
  echo "       Generate with: openssl rand -hex 32, then add to .env" >&2
  echo "       See SELF_HOSTING.md → Required Environment Variables." >&2
  exit 1
fi
export UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

# Source API keys from docker-compose.override.yml if present.
# These keys are configured for the container but seeders run on the host.
OVERRIDE="$PROJECT_DIR/docker-compose.override.yml"
if [ -f "$OVERRIDE" ]; then
  _env_tmp=$(mktemp)
  grep -E '^\s+[A-Z_]+:' "$OVERRIDE" \
    | grep -v '#' \
    | sed 's/^\s*//' \
    | sed 's/: */=/' \
    | sed "s/[\"']//g" \
    | grep -E '^(NASA_FIRMS|GROQ|AISSTREAM|FRED|FINNHUB|EIA|ACLED_ACCESS_TOKEN|ACLED_EMAIL|ACLED_PASSWORD|CLOUDFLARE|AVIATIONSTACK|OPENAQ_API_KEY|WAQI_API_KEY|OPENROUTER_API_KEY|LLM_API_URL|LLM_API_KEY|LLM_MODEL|OLLAMA_API_URL|OLLAMA_MODEL)' \
    | sed 's/^/export /' > "$_env_tmp"
  . "$_env_tmp"
  rm -f "$_env_tmp"
fi
# Per-seeder wall-clock cap for STANDALONE seeders. They run sequentially, so a
# single upstream that hangs (e.g. a slow NOAA/NSIDC fetch that doesn't honour its
# own AbortSignal and keeps the node process alive for an hour) would burn the rest
# of the window and starve every later seeder — under a wrapping systemd/cron job
# timeout it drops everything after the hung one. Capping each seeder bounds that
# blast radius. Default 1800s (30min): above any standalone seeder's real runtime
# yet below the pathological hangs (60min+), so it kills only runaway runs.
# Override with SEED_TIMEOUT=<seconds>, or SEED_TIMEOUT=0 to disable.
#
# Bundle seeders (seed-bundle-*.mjs) are EXEMPT from this cap: scripts/_bundle-runner.mjs
# already hard-caps every section with its own wall-clock timer (SIGTERM→SIGKILL on
# the section's child PID — immune to the DNS-hang blind spot) and runs sections
# sequentially, so a bundle's *legitimate* total can exceed SEED_TIMEOUT (e.g.
# resilience-recovery's Import-HHI section alone budgets 30min). Wrapping a bundle in
# the outer cap would false-kill it mid-run and orphan the in-flight section child.
SEED_TIMEOUT="${SEED_TIMEOUT:-1800}"

# Resolve once whether the outer cap is usable (timeout(1) present and a positive
# numeric budget). Non-numeric/empty SEED_TIMEOUT → test errors → disabled (plain node).
if command -v timeout >/dev/null 2>&1 && [ "${SEED_TIMEOUT:-0}" -gt 0 ] 2>/dev/null; then
  timeout_enabled=true
else
  timeout_enabled=false
fi

# Bundle seeders self-bound per section — never wrap them in the outer cap.
is_bundle() {
  case "$1" in
    *seed-bundle-*) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether THIS seeder is wrapped by the outer timeout.
caps_seed() {
  [ "$timeout_enabled" = true ] && ! is_bundle "$1"
}

run_seed() {
  if caps_seed "$1"; then
    # -k: if it ignores SIGTERM, SIGKILL it 30s later so the run can move on.
    timeout -k 30 "$SEED_TIMEOUT" node "$1" 2>&1
  else
    node "$1" 2>&1
  fi
}

ok=0 fail=0 skip=0 timedout=0

for f in "$SCRIPT_DIR"/seed-*.mjs; do
  name="$(basename "$f")"
  printf "→ %s ... " "$name"
  output=$(run_seed "$f")
  rc=$?
  last=$(echo "$output" | tail -1)

  # timeout(1) exits 124 when it had to terminate the child, or 128+signal
  # (137 = SIGKILL after the -k grace) when SIGTERM was ignored. Only trust this
  # classification for seeders we actually wrapped (bundles run unwrapped).
  if caps_seed "$f" && { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; }; then
    printf "TIMEOUT (killed after %ss)\n" "$SEED_TIMEOUT"
    timedout=$((timedout + 1))
  elif echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
    printf "SKIP (%s)\n" "$last"
    skip=$((skip + 1))
  elif [ $rc -eq 0 ]; then
    printf "OK\n"
    ok=$((ok + 1))
  else
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
  fi
done

echo ""
echo "Done: $ok ok, $skip skipped, $fail failed, $timedout timed out"
