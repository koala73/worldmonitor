#!/bin/sh
# World Monitor one-line installer (self-host with Docker).
#
# Usage:
#   curl -fsSL https://www.worldmonitor.app/install.sh | bash
#   curl -fsSL https://www.worldmonitor.app/install.sh | bash -s -- --port 8080
#
# www.worldmonitor.app/install.sh is a vercel.json rewrite of this file on main.
#
# What it does (idempotent, safe to re-run):
#   1. Uses the current directory when it already is a World Monitor checkout,
#      otherwise clones (or fast-forwards) ./worldmonitor.
#   2. Creates .env with the four REQUIRED secrets when they are missing
#      (RELAY_SHARED_SECRET, REDIS_PASSWORD, REDIS_TOKEN, WM_SESSION_SECRET).
#      Existing values are never overwritten.
#   3. Starts the stack with Docker/Podman Compose.
#   4. Seeds Redis with public data when node is available.
#
# Options:
#   --dir DIR     checkout directory (default: ./worldmonitor; ignored when
#                 run inside an existing checkout). Env: WM_DIR
#   --port PORT   host port for the dashboard (default: 3000 or WM_PORT).
#                 Env: WM_PORT
#   --no-seed     skip ./scripts/run-seeders.sh
#   --no-build    skip --build on compose up (faster re-runs)
#   -h, --help    show this help
#
# Env overrides: WM_REPO, WM_BRANCH, WM_DIR, WM_PORT.
# See SELF_HOSTING.md for API keys, production notes, and uninstall.
set -eu

REPO="${WM_REPO:-https://github.com/koala73/worldmonitor.git}"
BRANCH="${WM_BRANCH:-main}"
TARGET_DIR="${WM_DIR:-worldmonitor}"
PORT="${WM_PORT:-}"
SEED=1
BUILD=1

usage() {
  # Piped (`curl ... | bash -s -- --help`) there is no script file to read.
  if [ -f "$0" ] && head -1 "$0" | grep -q '^#!'; then
    sed -n '2,/^set -eu/p' "$0" | sed 's/^# \{0,1\}//'
  else
    printf '%s\n' "Usage: curl -fsSL https://www.worldmonitor.app/install.sh | bash -s -- [--dir DIR] [--port PORT] [--no-seed] [--no-build]" \
      "Full help: https://github.com/koala73/worldmonitor/blob/main/scripts/install.sh"
  fi
}

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -lt 2 ] && die "--dir needs a value"
      TARGET_DIR="$2"
      shift 2
      ;;
    --port)
      [ "$#" -lt 2 ] && die "--port needs a value"
      PORT="$2"
      shift 2
      ;;
    --no-seed) SEED=0; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "${PORT:-}" in
  '') ;;
  *[!0-9]*|??????*) die "--port must be a number 1-65535" ;;
  *) [ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || die "--port must be a number 1-65535" ;;
esac

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 ($2)"
}

need_cmd git "install git, then re-run"
need_cmd openssl "install openssl, then re-run"

# Pick a compose implementation. Prefer the Docker plugin, then the
# standalone binaries, then podman variants.
pick_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    printf '%s' "docker compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    printf '%s' "docker-compose"
    return 0
  fi
  if command -v podman-compose >/dev/null 2>&1; then
    printf '%s' "podman-compose"
    return 0
  fi
  if command -v uvx >/dev/null 2>&1; then
    printf '%s' "uvx podman-compose"
    return 0
  fi
  return 1
}

COMPOSE="$(pick_compose || true)"
[ -n "${COMPOSE:-}" ] || die "no compose implementation found (need 'docker compose', docker-compose, or podman-compose)"

# Resolve the checkout: in-place when cwd already has the stack file,
# otherwise clone or reuse TARGET_DIR.
if [ -f "./docker-compose.yml" ]; then
  PROJECT_DIR="$(pwd)"
  log "Using current directory: $PROJECT_DIR"
else
  case "$TARGET_DIR" in
    /*) PROJECT_DIR="$TARGET_DIR" ;;
    *) PROJECT_DIR="$(pwd)/$TARGET_DIR" ;;
  esac
  if [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
    log "Reusing existing checkout: $PROJECT_DIR"
    if [ -d "$PROJECT_DIR/.git" ]; then
      log "Updating checkout..."
      git -C "$PROJECT_DIR" pull --ff-only 2>/dev/null || warn "git pull failed, continuing with local files"
    fi
  else
    log "Cloning $REPO ($BRANCH) into $PROJECT_DIR..."
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$PROJECT_DIR" || die "git clone failed"
  fi
  cd "$PROJECT_DIR" || die "cannot enter $PROJECT_DIR"
  PROJECT_DIR="$(pwd)"
fi

# Ensure one VAR in .env: keep an existing line, else take the exported env
# value, else generate a fresh 32-byte hex secret. Never overwrites.
ensure_secret() {
  var="$1"
  [ -f .env ] || : > .env
  if grep -Eq "^${var}=[^[:space:]]" .env 2>/dev/null; then
    return 0
  fi
  val="$(eval "printf '%s' \"\${$var:-}\"")"
  if [ -z "$val" ]; then
    val="$(openssl rand -hex 32)"
    log "Generated $var"
  else
    log "Using exported $var"
  fi
  printf '%s=%s\n' "$var" "$val" >> .env
}

ensure_secret RELAY_SHARED_SECRET
ensure_secret REDIS_PASSWORD
ensure_secret REDIS_TOKEN
ensure_secret WM_SESSION_SECRET

if [ -n "$PORT" ]; then
  if grep -Eq '^WM_PORT=' .env 2>/dev/null; then
    warn "WM_PORT already set in .env, leaving it (remove the line to use --port $PORT)"
    PORT="$(grep -E '^WM_PORT=' .env | tail -1 | cut -d= -f2)"
  else
    printf '%s=%s\n' "WM_PORT" "$PORT" >> .env
  fi
fi
PORT="${PORT:-3000}"

log "Starting World Monitor (compose: $COMPOSE)..."
if [ "$BUILD" -eq 1 ]; then
  # shellcheck disable=SC2086
  $COMPOSE up -d --build || die "compose up failed (see ${COMPOSE} logs)"
else
  # shellcheck disable=SC2086
  $COMPOSE up -d || die "compose up failed (see ${COMPOSE} logs)"
fi

if [ "$SEED" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    log "Seeding data (public sources work with no API keys)..."
    sleep 5
    sh ./scripts/run-seeders.sh || warn "seeding had failures — dashboard still starts, re-run ./scripts/run-seeders.sh later"
  else
    warn "node not found, skipping seed step — install Node.js 24 and run ./scripts/run-seeders.sh"
  fi
else
  log "Skipping seed step (--no-seed)."
fi

log ""
log "Done. Open http://localhost:$PORT in a browser."
log "Health: curl -s 'http://localhost:$PORT/api/health?compact=1'"
log "API keys are optional (public data works without them): see SELF_HOSTING.md -> API Keys."
log "Uninstall: see SELF_HOSTING.md -> Uninstall."
