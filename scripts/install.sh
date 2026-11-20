#!/bin/sh
# World Monitor one-line installer (self-host with Docker).
#
#   curl -fsSL https://www.worldmonitor.app/install.sh | bash
#
# www.worldmonitor.app/install.sh is a vercel.json rewrite of this file on main.
# Options and behaviour: see usage() below, or run with --help.
# See SELF_HOSTING.md for API keys, production notes, and uninstall.
set -eu

REPO="${WM_REPO:-https://github.com/koala73/worldmonitor.git}"
BRANCH="${WM_BRANCH:-main}"
TARGET_DIR="${WM_DIR:-worldmonitor}"
PORT="${WM_PORT:-}"
SEED=1
# pull: pull the published images, build only if the pull fails (default)
# build: build from source   none: start whatever is local
BUILD=pull

# Help text lives here, not in a comment read from "$0": under
# `curl ... | bash -s -- --help` there is no script file to read.
usage() {
  cat <<'EOF'
World Monitor one-line installer (self-host with Docker).

Usage:
  curl -fsSL https://www.worldmonitor.app/install.sh | bash
  curl -fsSL https://www.worldmonitor.app/install.sh | bash -s -- [options]
  ./scripts/install.sh [options]          (inside a checkout)

What it does (idempotent, safe to re-run):
  1. Uses the current directory when it is a World Monitor checkout,
     otherwise clones (or fast-forwards) ./worldmonitor.
  2. Adds the four REQUIRED secrets to .env when they are missing
     (RELAY_SHARED_SECRET, REDIS_PASSWORD, REDIS_TOKEN, WM_SESSION_SECRET).
     Existing values are never overwritten. .env is kept at mode 600.
  3. Pulls the published images and starts the stack with Docker/Podman
     Compose (builds from source if the pull fails).
  4. With Node.js 22.19+ on the host: runs npm ci when node_modules is
     missing, waits for the Redis REST proxy, and seeds public data.

Options:
  --dir DIR     checkout directory (default: ./worldmonitor; ignored when
                run inside a checkout). Env: WM_DIR
  --port PORT   host port for the dashboard, saved as WM_PORT in .env
                (default: the saved value, else 3000). Env: WM_PORT
  --no-seed     skip npm ci and ./scripts/run-seeders.sh
  --build       build the images from source instead of pulling them
  --no-build    skip the explicit pull and build; compose still fetches or
                builds an image that is missing locally
  -h, --help    show this help

Env overrides: WM_REPO, WM_BRANCH, WM_DIR, WM_PORT.
See SELF_HOSTING.md for API keys, production notes, and uninstall.
EOF
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
    --build) BUILD=build; shift ;;
    --no-build) BUILD=none; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

valid_port() {
  case "$1" in
    ''|*[!0-9]*|??????*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

[ -z "$PORT" ] || valid_port "$PORT" || die "--port must be a number 1-65535"

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

# A World Monitor checkout, not just any Compose project: the stack file
# must define our containers and package.json must name this project.
is_wm_checkout() {
  [ -f "$1/docker-compose.yml" ] &&
    [ -f "$1/scripts/run-seeders.sh" ] &&
    grep -q 'container_name: worldmonitor-redis-rest' "$1/docker-compose.yml" 2>/dev/null &&
    grep -q '"name": "world-monitor"' "$1/package.json" 2>/dev/null
}

# Resolve the checkout: in-place when cwd is a World Monitor checkout,
# otherwise clone or reuse TARGET_DIR.
if is_wm_checkout .; then
  PROJECT_DIR="$(pwd)"
  log "Using current directory: $PROJECT_DIR"
else
  if [ -f "./docker-compose.yml" ]; then
    log "The current directory is another Compose project; installing into $TARGET_DIR instead."
  fi
  case "$TARGET_DIR" in
    /*) PROJECT_DIR="$TARGET_DIR" ;;
    *) PROJECT_DIR="$(pwd)/$TARGET_DIR" ;;
  esac
  if is_wm_checkout "$PROJECT_DIR"; then
    log "Reusing existing checkout: $PROJECT_DIR"
    if [ -d "$PROJECT_DIR/.git" ]; then
      log "Updating checkout..."
      git -C "$PROJECT_DIR" pull --ff-only 2>/dev/null || warn "git pull failed, continuing with local files"
    fi
  elif [ -e "$PROJECT_DIR" ] && [ -n "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]; then
    die "$PROJECT_DIR exists and is not a World Monitor checkout (pick another --dir)"
  else
    log "Cloning $REPO ($BRANCH) into $PROJECT_DIR..."
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$PROJECT_DIR" || die "git clone failed"
  fi
  cd "$PROJECT_DIR" || die "cannot enter $PROJECT_DIR"
  PROJECT_DIR="$(pwd)"
fi

# .env holds the secrets: owner-only, and newline-terminated so an append
# never joins the previous line.
if [ -f .env ]; then
  chmod 600 .env 2>/dev/null || warn "could not restrict permissions on .env; run: chmod 600 .env"
else
  (umask 077 && : > .env)
fi
if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then
  printf '\n' >> .env
fi

# Print the last VAR= value in .env with one layer of matching quotes
# removed; empty output when VAR is unset or empty ("" and '' included).
read_env() {
  line="$(grep -E "^$1=" .env 2>/dev/null | tail -1)" || true
  v="${line#*=}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# Drop every VAR= line (used only for empty placeholders before rewriting).
drop_env() {
  tmp="$(mktemp .env.XXXXXX)"
  grep -Ev "^$1=" .env > "$tmp" || true
  chmod 600 "$tmp"
  mv "$tmp" .env
}

# Ensure one VAR in .env: keep a nonempty value, else take the exported env
# value, else generate a fresh 32-byte hex secret. Never overwrites a
# nonempty value. The result is exported so Compose (which prefers the shell
# environment) and run-seeders.sh (which sources .env) use the same value.
ensure_secret() {
  var="$1"
  current="$(read_env "$var")"
  exported="$(eval "printf '%s' \"\${$var:-}\"")"
  if [ -n "$current" ]; then
    if [ -n "$exported" ] && [ "$exported" != "$current" ]; then
      warn "exported $var differs from .env; using the .env value"
    fi
    export "$var=$current"
    return 0
  fi
  grep -Eq "^${var}=" .env && drop_env "$var"
  if [ -z "$exported" ]; then
    val="$(openssl rand -hex 32)"
    printf '%s=%s\n' "$var" "$val" >> .env
    log "Generated $var"
  else
    # Single quotes keep $, spaces and # literal for both Compose and sh.
    case "$exported" in
      *"'"*) die "exported $var contains a single quote; put it in .env by hand" ;;
    esac
    val="$exported"
    printf "%s='%s'\n" "$var" "$val" >> .env
    log "Using exported $var"
  fi
  export "$var=$val"
}

ensure_secret RELAY_SHARED_SECRET
ensure_secret REDIS_PASSWORD
ensure_secret REDIS_TOKEN
ensure_secret WM_SESSION_SECRET

# One effective port for Compose and the printed links: the saved WM_PORT
# wins, then --port / WM_PORT (saved for re-runs), then 3000.
SAVED_PORT="$(read_env WM_PORT)"
if [ -n "$SAVED_PORT" ]; then
  if [ -n "$PORT" ] && [ "$PORT" != "$SAVED_PORT" ]; then
    warn "WM_PORT=$SAVED_PORT is already set in .env, keeping it (edit .env to change it)"
  fi
  PORT="$SAVED_PORT"
  valid_port "$PORT" || die "WM_PORT in .env must be a number 1-65535"
elif [ -n "$PORT" ]; then
  printf '%s=%s\n' "WM_PORT" "$PORT" >> .env
else
  PORT=3000
fi
export WM_PORT="$PORT"

log "Starting World Monitor (compose: $COMPOSE)..."
if [ "$BUILD" = "pull" ]; then
  # shellcheck disable=SC2086
  if ! $COMPOSE pull; then
    warn "pulling the published images failed, building from source instead"
    BUILD=build
  fi
fi
if [ "$BUILD" = "build" ]; then
  # shellcheck disable=SC2086
  $COMPOSE up -d --build || die "compose up failed (see ${COMPOSE} logs)"
else
  # shellcheck disable=SC2086
  $COMPOSE up -d || die "compose up failed (see ${COMPOSE} logs)"
fi

# Seeders run on the host and import packages from node_modules.
node_ok() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null
}

# Any HTTP status means the proxy is accepting connections.
wait_for_proxy() {
  url="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
  if ! command -v curl >/dev/null 2>&1; then
    sleep 5
    return 0
  fi
  i=0
  while [ "$i" -lt 60 ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url/" 2>/dev/null || true)"
    case "$code" in
      ''|000) ;;
      *) return 0 ;;
    esac
    i=$((i + 1))
    sleep 2
  done
  return 1
}

seed() {
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found, skipping seed step: install Node.js 24, then run npm ci and ./scripts/run-seeders.sh"
    return 0
  fi
  if ! node_ok; then
    warn "Node.js $(node -v) is older than 22.19, skipping seed step: install Node.js 24, then run npm ci and ./scripts/run-seeders.sh"
    return 0
  fi
  if [ ! -d node_modules ]; then
    command -v npm >/dev/null 2>&1 || { warn "npm not found, skipping seed step"; return 0; }
    log "Installing Node dependencies for the seeders (npm ci)..."
    npm ci || { warn "npm ci failed, skipping seed step: fix it, then run ./scripts/run-seeders.sh"; return 0; }
  fi
  log "Waiting for the Redis REST proxy..."
  wait_for_proxy || { warn "Redis REST proxy did not answer within 2 minutes, skipping seed step: check '$COMPOSE ps', then run ./scripts/run-seeders.sh"; return 0; }
  log "Seeding data (public sources work with no API keys)..."
  sh ./scripts/run-seeders.sh || warn "seeding had failures: the dashboard still starts, re-run ./scripts/run-seeders.sh later"
}

if [ "$SEED" -eq 1 ]; then
  seed
else
  log "Skipping seed step (--no-seed)."
fi

log ""
log "Done. Open http://localhost:$PORT in a browser."
log "Health: curl -s 'http://localhost:$PORT/api/health?compact=1'"
log "API keys are optional (public data works without them): see SELF_HOSTING.md -> API Keys."
log "Uninstall: see SELF_HOSTING.md -> Uninstall."
