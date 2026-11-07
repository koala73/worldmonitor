# 🌍 Self-Hosting World Monitor

Run the full World Monitor stack locally with Docker/Podman.

## 📋 Prerequisites

- **Docker** or **Podman** (rootless works fine)
- **Docker Compose** or **podman-compose** (`pip install podman-compose` or `uvx podman-compose`)
- **Node.js 24** (the version in `.nvmrc`; 22.19 is the minimum), for running the seed scripts on the host

## 🚀 Quick Start

```bash
# 1. Clone and enter the repo
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm ci

# 2. Generate the REQUIRED secrets, once. Without these the stack will not start
#    (see the "Required Environment Variables" table below).
echo "RELAY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env
echo "REDIS_PASSWORD=$(openssl rand -hex 32)"      >> .env
echo "REDIS_TOKEN=$(openssl rand -hex 32)"         >> .env
echo "WM_SESSION_SECRET=$(openssl rand -hex 32)"   >> .env

# 3. Start the stack
docker compose up -d        # or: uvx podman-compose up -d

# 4. Seed data into Redis
./scripts/run-seeders.sh

# 5. Open http://localhost:3000 in a browser (macOS: open http://localhost:3000)
```

The dashboard works out of the box with public data sources (earthquakes, weather, conflicts, etc.). API keys unlock additional data feeds. To serve it on another host port, set `WM_PORT` in `.env` (default `3000`).

## 🔐 Required Environment Variables

These must be set in `.env` before `docker compose up -d`. Until all four are set, Compose refuses to start the stack with `required variable ... is missing a value`.

| Variable | Purpose | How to generate |
| --- | --- | --- |
| `RELAY_SHARED_SECRET` | Authenticates every non-public request the dashboard makes to the AIS relay. | `openssl rand -hex 32` |
| `REDIS_PASSWORD` | Redis AUTH password (`--requirepass`). The REST proxy uses it in its upstream connection string. | `openssl rand -hex 32` |
| `REDIS_TOKEN` | Bearer token the REST proxy (`redis-rest`) requires on every request, and the value the app and relay send as `UPSTASH_REDIS_REST_TOKEN`. | `openssl rand -hex 32` |
| `WM_SESSION_SECRET` | Signs the anonymous browser session used by self-hosted API routes. Must be at least 32 characters, or the app container exits on boot. | `openssl rand -hex 32` |

> Earlier releases shipped `wm-local-token` as a default for the REST token. That default has been removed (#3804) — the proxy was only reachable from `127.0.0.1:8079` so external exposure required a hostile `docker-compose.override.yml`, but any user who flipped that binding to `0.0.0.0` was instantly authenticated by a publicly documented string. Fresh installs and existing clones both need to set `REDIS_TOKEN`, `REDIS_PASSWORD`, and `WM_SESSION_SECRET` in `.env` from this release onward.

## Self-hosted API authentication

Docker mode (`LOCAL_API_MODE=docker`) has no Clerk or Convex entitlement backend. The dashboard still mints an anonymous `wms_` session signed with `WM_SESSION_SECRET`.

A Pro or Pro Business subscriber can unlock Pro panels in their own browser with a desktop key. See [Pro panels with a desktop key](#pro-panels-with-a-desktop-key).

Native administration routes under `/api/local-` return `403` in Docker mode, including configuration updates, secret validation, and local status/debug controls. The internal sidecar token does not grant administrator access through nginx. Change operator settings through Compose environment variables or Docker secrets, then recreate the app container. Desktop administration remains available through the native app.

- Only `GET /api/intelligence/v1/get-country-intel-brief` accepts that session as the authentication boundary. The handler still returns the shared (non-premium) brief.
- Direct-LLM spend on that route is capped at 50 calls per UTC day per client IP. nginx stamps `X-Real-IP` from `$remote_addr`, so a caller cannot rotate the header to reset the cap. Rotating the session token also does not reset spend.
- Every other premium route still requires an API key, a Clerk entitlement, or a relayed desktop key. Cloud deployments do not set `LOCAL_API_MODE=docker` and keep key plus entitlement enforcement on this route too.

If another reverse proxy sits in front of the World Monitor container, set
`WM_TRUSTED_PROXY_CIDRS` to that proxy's IP address or network. Separate multiple
values with commas, for example `WM_TRUSTED_PROXY_CIDRS=172.20.0.0/16,2001:db8::/32`.
World Monitor then uses `X-Forwarded-For` only when it comes through those trusted
peers, and nginx resolves the original client address recursively. Invalid values
stop the container at startup. Leave this variable unset for direct connections;
never trust a network that can contain untrusted clients, because those clients
could then supply a false forwarded address and evade the per-IP quota.

> Need to run the relay without auth for local debugging? This applies only when you run `node scripts/ais-relay.cjs` yourself, outside Compose, with `RELAY_SHARED_SECRET` unset; Compose always sets the secret, and the relay ignores the override when the secret is set. Set `I_UNDERSTAND_THIS_DISABLES_AUTH=true` (the deprecated `ALLOW_UNAUTHENTICATED_RELAY=true` is still accepted). The relay will log a loud `[SECURITY]` warning at boot and every 5 minutes, and every non-public route will be reachable by anyone who can hit the port — **never use this on an internet-reachable host.**

## Pro panels with a desktop key

A self-hosted install has no World Monitor accounts, so signing in with a worldmonitor.app account does not unlock anything. A subscriber unlocks Pro panels with a [desktop key](https://www.worldmonitor.app/docs/api-keys#desktop-keys) instead: a `wm_` key created at [worldmonitor.app](https://www.worldmonitor.app) under **Settings → API Keys** with **Create desktop key**. Pro includes 2 desktop keys and Pro Business includes 3.

Sign-in stays off on the stock image. It needs the frontend built with `VITE_CLERK_PUBLISHABLE_KEY`; the `Dockerfile` takes no Vite build argument and `.dockerignore` excludes `.env*`, so the browser console logs `[clerk] VITE_CLERK_PUBLISHABLE_KEY not set, auth disabled`, and adding the key to `.env` does not change that. A custom build with the key would also need a Convex deployment and its billing webhooks before entitlements work; this guide covers neither. Premium **API** routes and the MCP server need no desktop key: they answer operator keys from `WORLDMONITOR_VALID_KEYS` (see [Using the MCP server](#-using-the-mcp-server)).

- Each browser user enters their own key in the dashboard's Settings. The API sidecar checks it with `https://api.worldmonitor.app/api/desktop-key/status` and stores it in an HttpOnly `wm-desktop-key` cookie scoped to `/api/` for 30 days. Status checks do not extend that; after 30 days the user enters the key again.
- Pro panels unlock in that browser only after World Monitor confirms the key. Only desktop keys work; an API Starter or API Business key is reported as not a desktop key.
- The sidecar forwards that browser's Pro requests (the paths in `shared/selfhost-relay-paths.js`) to World Monitor with the user's key. Usage counts against the key owner's desktop allocation: 7,500 requests per UTC day and 120 per minute, shared with their desktop app. All other requests are served by your install as before.
- A key World Monitor reports as revoked, lapsed or over its limit stops being forwarded; those requests are served by your install. The key stays saved in the browser until the user removes it or saves another, so a subscription renewed within those 30 days unlocks again without re-entry.
- Only this install's own pages can use the key: requests from another site, another subdomain of your domain, or another port on the same host are never forwarded. Anything served from the dashboard's own origin (same scheme, host and port) is trusted and can use the key, so do not serve other apps under a path on that origin. Over plain HTTP the sidecar checks this with the request's `Referer` against the `X-Forwarded-Host` the bundled nginx sets. If you put your own proxy in front of the sidecar instead, pass the browser's `Host` as `X-Forwarded-Host`, or forwarding stops on HTTP. HTTPS needs nothing extra.
- Requests from a browser with no key are never forwarded, and that browser stays on the free dashboard. `/api/v2/`, MCP server (`/api/mcp`) and OAuth requests are never forwarded, and operator keys (`WORLDMONITOR_API_KEY`, `WORLDMONITOR_VALID_KEYS`) are never sent with forwarded requests.
- On a shared install each user enters their own key. There is no operator key that unlocks Pro for every visitor. An API plan is for calling the World Monitor API directly; it does not unlock a shared dashboard.
- Your server sees each user's key when it forwards requests. Users should create a separate desktop key for any install they do not run themselves, and revoke it at worldmonitor.app when they stop using or trusting that install.

| Variable | Default | Purpose |
|---|---|---|
| `WORLDMONITOR_SELFHOST_RELAY` | on | Set to `off` to disable forwarding and the desktop key setting. The setting then says the operator has disabled it. |
| `WORLDMONITOR_PUBLIC_HTTPS` | unset | Set to `1` when users reach the install over HTTPS through an outer TLS proxy, so the cookie is marked `Secure`. Without it, the cookie is `Secure` only when nginx sees `X-Forwarded-Proto: https`. |

Both variables are passed through `docker-compose.yml`. Native installs set them in the sidecar's environment.

## Native installs (without Docker)

Packagers who run the services directly (for example the FreeBSD `www/worldmonitor` port) lose the container network that keeps internal services private. Set these explicitly:

| Variable | Service | Default | Native-install value |
|---|---|---|---|
| `SRH_BIND_HOST` | Redis REST proxy (`docker/redis-rest-proxy.mjs`) | `0.0.0.0` | `127.0.0.1` |
| `RELAY_BIND_HOST` | AIS relay (`scripts/ais-relay.cjs`) | all interfaces | `127.0.0.1` |
| `LOCAL_API_MODE` | API sidecar | `desktop-sidecar` | `docker` (the self-hosted mode name; Docker is not required) |

Inside Docker the defaults are correct: compose publishes the proxy only on `127.0.0.1:8079`, and Railway needs the relay on every interface.

`@bufbuild/buf` ships no binary for some platforms, including FreeBSD, and its install script fails there with `Unsupported platform`. The runtime does not need buf: it is only used by the proto development targets (`make generate`, `make lint`, `make deps`, `make breaking`, `make check`), and the generated code is committed. Install with `npm ci --ignore-scripts` and then run `npm run postinstall`; anyone running those targets on such a platform needs a buf CLI built for it. `--ignore-scripts` also skips the `esbuild` and `sharp` install scripts; check that your platform's packages provide working binaries for both.

## 🤖 Using the MCP server

The bundled MCP server is served at `/api/mcp` on your own stack. It authenticates
with the `X-WorldMonitor-Key` header, validated against `WORLDMONITOR_VALID_KEYS`
(the OAuth path is hosted-only). Generate a key, put it in `.env`, and restart:

```bash
YOUR_KEY="wm_$(openssl rand -hex 20)"
echo "WORLDMONITOR_VALID_KEYS=$YOUR_KEY" >> .env
docker compose up -d
```

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-WorldMonitor-Key: $YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The bundled nginx proxy supplies `X-WorldMonitor-Local-Token` for transport
between nginx and the sidecar. It preserves the client's `Authorization`
header. The transport token does not grant MCP access: operator keys still
use `X-WorldMonitor-Key`, and OAuth requires the hosted identity services.

## 🔑 API Keys

Put your keys in `.env`, next to the required secrets. `.env` is **gitignored**, so your secrets stay local. Compose passes each key below to the containers that use it, and `./scripts/run-seeders.sh` loads the same file for the host-side seeders. Recreate the containers after changing it: `docker compose up -d`.

```bash
# 🤖 LLM (used for intelligence assessments)
# https://openrouter.ai
OPENROUTER_API_KEY=

# 📊 Markets & Economics
# https://finnhub.io (free tier): primary equity gap + search
FINNHUB_API_KEY=
# https://www.alphavantage.co/support/#api-key: equity fallback (app and seeders)
ALPHA_VANTAGE_API_KEY=
# https://fred.stlouisfed.org/docs/api/api_key.html (free)
FRED_API_KEY=
# https://www.eia.gov/opendata/ (free)
EIA_API_KEY=

# ⚔️ Conflict & Unrest
# https://acleddata.com: OAuth flow, tokens auto-refresh (preferred over ACLED_ACCESS_TOKEN)
ACLED_EMAIL=
ACLED_PASSWORD=
# Alternative: static token (expires every 24h)
ACLED_ACCESS_TOKEN=
# https://ucdp.uu.se/apidocs/: conflict events, read by the relay
UCDP_ACCESS_TOKEN=

# 🛰️ Earth Observation
# REQUIRED for seed-fire-detections.mjs: https://firms.modaps.eosdis.nasa.gov (free)
NASA_FIRMS_API_KEY=

# ✈️ Aviation
# https://aviationstack.com (free tier)
AVIATIONSTACK_API=
# https://travelpayouts.com: flight price search (optional)
TRAVELPAYOUTS_API_TOKEN=

# 🚢 Maritime: https://aisstream.io (free), used by the relay
AISSTREAM_API_KEY=

# 🌐 Internet Outages: https://dash.cloudflare.com (free account, token with Radar access)
CLOUDFLARE_API_TOKEN=

# 🔌 Self-hosted LLM (optional, any OpenAI-compatible endpoint). The app runs
# inside a container, so "localhost" is the container itself. For Ollama on the
# Docker host use http://host.docker.internal:11434/v1/chat/completions
# (on Linux, see "Self-Hosted LLM" below for the extra_hosts entry).
LLM_API_URL=
LLM_API_KEY=
LLM_MODEL=

# Lets the relay's classify job read this install's news digest (#7437).
# Compose passes it to both the app and the relay. Generate: openssl rand -hex 32
WORLDMONITOR_RELAY_KEY=
```

Keep comments on their own lines in `.env`, as above.

### Keys Compose does not pass through

`docker-compose.yml` lists the variables each container receives. For anything else, add a `docker-compose.override.yml` (also **gitignored**) that hands the value from `.env` to the right service. The relay's X and Telegram feeds and its OpenSky client are the common case:

```yaml
services:
  ais-relay:
    environment:
      # X feed panel: app bearer token + a curated list ID
      X_BEARER_TOKEN: "${X_BEARER_TOKEN:-}"
      X_CURATED_LIST_ID: "${X_CURATED_LIST_ID:-}"
      # Telegram feed panel: MTProto app credentials + a StringSession
      TELEGRAM_API_ID: "${TELEGRAM_API_ID:-}"
      TELEGRAM_API_HASH: "${TELEGRAM_API_HASH:-}"
      TELEGRAM_SESSION: "${TELEGRAM_SESSION:-}"
      # OpenSky (higher rate limits with an account)
      OPENSKY_CLIENT_ID: "${OPENSKY_CLIENT_ID:-}"
      OPENSKY_CLIENT_SECRET: "${OPENSKY_CLIENT_SECRET:-}"
```

Without the X or Telegram credentials those panels load but stay empty. `.env.example` lists every variable the code reads.

### Docker secrets

To keep keys out of `docker inspect`, mount them as Docker secrets instead. The app's entrypoint reads each file in `/run/secrets/` and exports it under the file's name, taking priority over the same variable from `environment`. Create one file per key and uncomment the `secrets:` blocks at the bottom of `docker-compose.yml` and under the `worldmonitor` service:

```bash
mkdir -p secrets
printf '%s' 'sk-or-...' > secrets/openrouter_api_key.txt
```

Secrets reach the `worldmonitor` container only. The host-side seeders still read keys from `.env`.

### 💰 Free vs Paid

| Status | Keys |
|--------|------|
| 🟢 No key needed | Earthquakes, weather, natural events, UNHCR displacement, prediction markets, stablecoins, crypto, spending, climate anomalies, submarine cables, BIS data, cyber threats |
| 🟢 Free signup | FRED, EIA, NASA FIRMS, AISSTREAM, Finnhub, Alpha Vantage, AviationStack, ACLED, OpenRouter, Cloudflare Radar |
| 🟡 Free (limited) | OpenSky (higher rate limits with account) |
| 🟡 Metered | LLM usage, billed by whichever provider `OPENROUTER_API_KEY` or `LLM_API_URL` points at (a local Ollama or LM Studio endpoint is free) |

## 🌱 Seeding Data

The seed scripts fetch upstream data and write it to Redis. They run **on the host** (not inside the container) and need the Redis REST proxy to be running.

```bash
# Run all seeders (loads REDIS_TOKEN and API keys from .env, plus seeder keys
# set in docker-compose.override.yml)
./scripts/run-seeders.sh
```

**⚠️ Important:** Redis data persists across container restarts via the `redis-data` volume, but is lost on `docker compose down -v`. Re-run the seeders if you remove volumes or see stale data. Redis is capped at 256 MB (`--maxmemory 256mb --maxmemory-policy allkeys-lru` in `docker-compose.yml`), so when it fills, the least recently used keys are evicted; raise the cap there if panels lose data between seeder runs.

To automate, add a cron job:

```bash
# Re-seed every 30 minutes
*/30 * * * * cd /path/to/worldmonitor && ./scripts/run-seeders.sh >> /tmp/wm-seeders.log 2>&1
```

cron runs with a minimal `PATH`. If `node` lives elsewhere, for example under nvm, set `PATH` at the top of the crontab to include its directory.

**Per-seeder timeout (`SEED_TIMEOUT`):** standalone seeders are each wrapped in a
wall-clock cap so one hung upstream can't starve the rest of the run. It defaults
to `1800` (30 min); override with `SEED_TIMEOUT=<seconds>`, or `SEED_TIMEOUT=0` to
disable. Bundle seeders (`seed-bundle-*.mjs`) are exempt — they already bound each
section internally. Requires the `timeout` command (GNU coreutils; macOS does not
ship it); if it's absent the cap is silently skipped.

### 🔧 Manual seeder invocation

If you prefer to run seeders individually:

```bash
# Source .env so REDIS_TOKEN (and any API keys it holds) become available.
# Quick-start puts REDIS_TOKEN in .env, not in your shell — without this,
# the next line fails-loud with "REDIS_TOKEN: parameter null or not set".
set -a; . ./.env; set +a

export UPSTASH_REDIS_REST_URL=http://localhost:8079
export UPSTASH_REDIS_REST_TOKEN="${REDIS_TOKEN:?set REDIS_TOKEN in .env first}"
node scripts/seed-earthquakes.mjs
node scripts/seed-military-flights.mjs
# ... etc
```

`./scripts/run-seeders.sh` auto-sources `REDIS_TOKEN` from `.env`, so the wrapper is the simpler path. Use the manual form only when iterating on a single seeder.

## 🏗️ Architecture

```
                 browser → localhost:3000 (WM_PORT)
                              │
┌─ worldmonitor ──────────────▼────────────────────┐
│  nginx :8080  ── static files (Vite SPA)          │
│     │ /api/*                                      │
│  Node.js API sidecar :46123                       │
└────┬──────────────────────────────┬──────────────┘
     │ http://redis-rest:80         │ http://ais-relay:3004
┌────▼─────── redis-rest ──────┐ ┌──▼──────── ais-relay ─────────┐
│ Upstash-compatible REST      │ │ AISStream WebSocket, X and    │
│ proxy; host: 127.0.0.1:8079  │ │ Telegram feeds, relay seeding │
└────┬─────────────────────────┘ └───────────────────────────────┘
┌────▼─────── redis :6379 ─────┐
│ data store (redis-data vol.) │◄── host seeders via 127.0.0.1:8079
└──────────────────────────────┘
```

| Container | Purpose | Port |
|-----------|---------|------|
| `worldmonitor` | nginx + Node.js API sidecar (supervisord) | host `3000` (`WM_PORT`) → 8080 |
| `worldmonitor-redis` | Data store | 6379 (internal) |
| `worldmonitor-redis-rest` | Upstash-compatible REST proxy | 80 internal; host `127.0.0.1:8079` |
| `worldmonitor-ais-relay` | Live vessel tracking, X and Telegram feeds | 3004 (internal) |

> **`redis-rest` command allowlist**: the bundled proxy (`docker/redis-rest-proxy.mjs`) only
> forwards a fixed allowlist of Redis commands. It permits a fixed set of byte-pinned `EVAL`
> scripts used by the bundled handlers and seeders; all caller-selected Lua plus `EVALSHA` and
> `SCRIPT` remain rejected.
> Two consequences for a self-hosted stack:
>
> - `@upstash/ratelimit`'s Lua-based sliding-window limiter (`server/_shared/rate-limit.ts`,
>   `api/_rate-limit.js`) can't run against it. Both automatically detect the rejection once and
>   fall back to a non-Lua fixed-window limiter (`INCR` + `EXPIRE NX`) for the rest of the
>   process — rate limiting still enforces, just with fixed- instead of sliding-window semantics.
> - `scripts/ais-relay.cjs`'s own in-container seed loops (`UPSTASH_ENABLED`) require
>   `UPSTASH_REDIS_REST_URL` to start with `https://` by default, which the plain-HTTP proxy
>   never satisfies. `docker-compose.yml` already sets `UPSTASH_ALLOW_INSECURE_HTTP=true` on the
>   `ais-relay` service so the relay can use the proxy; set it yourself only if you run the relay
>   outside Compose against a plain-HTTP proxy.

## Revoking a news item

Sometimes a headline has to come down now — a retracted story, a defamatory
claim, a wrong attribution. The digest keeps a narrow, versioned set of
suppressed URLs and filters against it at **read** time, on every path that can
return bytes: a fresh build, a digest cache hit, the durable last-good
snapshot, the warm-isolate replay, the country brief, and the chat analyst.

```bash
# Source .env so REDIS_TOKEN is available, then point at the REST proxy.
set -a; . ./.env; set +a
export UPSTASH_REDIS_REST_URL=http://localhost:8079
export UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"

# 1. Suppress the URL. Match is EXACT string equality on the item's `link` —
#    scheme, trailing slash, and query string all count. Copy the URL from the
#    API response rather than retyping it.
curl -s -X POST "$UPSTASH_REDIS_REST_URL/pipeline" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '[["SADD","news:digest:revoked-urls:v1","https://example.com/retracted-story"]]'
```

That single `SADD` is enough for everything served out of Redis — no key
deletion is required, because suppression happens on read.

**Two things it does not do**, both of which matter during an incident:

1. **It does not evict shared caches.** `/api/news/v1/list-feed-digest` is
   served with `max-age=60, s-maxage=300` and `CDN-Cache-Control: s-maxage=600`. Once a
   revocation is live the endpoint stops feeding shared caches, but copies
   already stored survive. **Purge the CDN for that path** if you have one in
   front of the stack. A purely local Docker stack has no CDN and can skip this.
2. **It does not force a rebuild.** The existing digest keeps being rebuilt on
   its normal ~900s cycle. To rebuild immediately:

   ```bash
   curl -s -X POST "$UPSTASH_REDIS_REST_URL/pipeline" \
     -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '[["DEL","news:digest:v1:full:en"],["DEL","news:digest:lastgood:v1:full:en"]]'
   ```

   Note the key version is **v1**. Repeat per `<variant>:<lang>` scope you serve.

To lift a revocation, `SREM` the same URL — stored bodies are kept unfiltered on
purpose, so the item reappears on the next read without waiting for a rebuild.

```bash
curl -s -X POST "$UPSTASH_REDIS_REST_URL/pipeline" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '[["SREM","news:digest:revoked-urls:v1","https://example.com/retracted-story"]]'
```

> If the revocation set cannot be read at all (Redis erroring, not merely
> absent), every serving path fails **closed** — it serves nothing rather than
> serving content it could not check. A stack with no Redis configured is a
> different case: there is no suppression store to consult, so serving proceeds
> normally.

> **`redis-rest` request body limit**: the proxy accepts request bodies up to **16 MB**,
> overridable with `SRH_MAX_BODY_BYTES` (bytes) on the `redis-rest` service. The default is
> sized for the seeders: every seeder publishing through `atomicPublish` is capped at 5 MB per
> key (`MAX_PAYLOAD_BYTES` in `scripts/_seed-utils.mjs`), and `atomicPublish` sends that payload
> as a JSON string nested inside `["SET", key, <payload>, "EX", ttl]`, so escaping makes the
> wire body larger than the payload.
>
> An over-limit body is answered with `413 Payload Too Large` and logged by the proxy, so a
> rejection shows up as a clear HTTP status in the seeder log *and* a matching line in
> `docker compose logs redis-rest` — never a bare `EPIPE`-style connection error. That holds at
> any value you set, so lowering the limit is safe to diagnose. The `redis-rest` service also
> carries a `mem_limit`, since the proxy buffers each accepted body in full; raise both together
> if you raise `SRH_MAX_BODY_BYTES`.

## 🔨 Building from Source

```bash
# Frontend only (for development)
# Build /pro first: it is generated by pro-test, not committed (#6898), and the
# root Vite build only copies whatever public/ already contains. Skipping it
# leaves dist/ with no /pro.
npm run build:pro && npx vite build

# App image only
docker build -t worldmonitor:latest -f Dockerfile .

# Update: pull, rebuild every image, and restart
git pull
docker compose up -d --build     # or: uvx podman-compose up -d --build
./scripts/run-seeders.sh
```

### ⚠️ Build Notes

- The app, relay and REST-proxy images use **Node.js 24 Alpine** for every stage
- Blog site build is skipped in Docker (separate dependencies)
- The runtime stage needs `gettext` (Alpine package) for `envsubst` in the nginx config
- Docker nginx mirrors Vercel's `script-src` policy and does not allow `'unsafe-inline'`; hash-pin any custom inline scripts before adding them to a self-hosted build.
- If you hit `npm ci` sync errors in Docker, regenerate the lockfile with the container's npm version:
  ```bash
  docker run --rm -v "$(pwd)":/app -w /app node:24-alpine npm install --package-lock-only
  ```

## 🗑️ Uninstall

Removing a self-hosted stack is the reverse of the quick start. Nothing is
installed outside the clone, the Compose containers and images, and one named
volume, so uninstall is three steps.

> **⚠️ `-v` deletes the Redis data volume (`redis-data`).** Every seeded
> snapshot and every `seed-meta:*` freshness key goes with it. There is no
> undo; re-seeding after a reinstall is the only way to get the data back.

Run steps 1 and 2 from inside the clone, choosing the commands for your engine.

Docker:

```bash
# 1. Stop the stack and remove its containers, network and the redis-data volume
docker compose down -v
# 2. Remove the images the stack built or pulled
docker image rm worldmonitor:latest worldmonitor-ais-relay:latest worldmonitor-redis-rest:latest docker.io/redis:7-alpine
```

Podman:

```bash
uvx podman-compose down -v
podman image rm worldmonitor:latest worldmonitor-ais-relay:latest worldmonitor-redis-rest:latest docker.io/redis:7-alpine
```

Then remove the clone, which also removes `.env` and `docker-compose.override.yml`:

```bash
# 3. Remove the clone after stopping the stack
cd .. && rm -rf worldmonitor
```

What each step deletes:

| Step | Removes | Keeps |
| --- | --- | --- |
| `docker compose down -v` | Containers `worldmonitor`, `worldmonitor-ais-relay`, `worldmonitor-redis`, `worldmonitor-redis-rest`; the Compose network; the `redis-data` volume | Images, the clone |
| `docker image rm ...` | The three locally built images and the pulled Redis image | The clone |
| `rm -rf worldmonitor` | The source, `.env` (secrets), `docker-compose.override.yml` (API keys), `node_modules`, any local `dist/` | Nothing |

To keep the seeded data for a later reinstall, stop the stack without `-v`
and skip step 3:

```bash
docker compose down
```

Or, for Podman:

```bash
uvx podman-compose down
```

The `redis-data` volume survives. If you later decide to delete it, the
following optional step permanently removes the seeded data (the project
prefix is the clone's directory name):

```bash
docker volume rm worldmonitor_redis-data
```

Or, for Podman:

```bash
podman volume rm worldmonitor_redis-data
```

If you scheduled `./scripts/run-seeders.sh` in cron (see
[Seeding Data](#-seeding-data)), remove that crontab line too, or it will fail
loudly every 30 minutes against a Redis that no longer exists.

This section covers the Docker/Podman stack only. The desktop app installs
through the platform's own package format; remove it the way your operating
system removes applications.

## 🌐 Connecting to External Infrastructure

### Shared Redis (optional)

If you run other stacks that share a Redis instance, connect via an external network:

```yaml
# docker-compose.override.yml
services:
  redis:
    networks:
      - infra_default

networks:
  infra_default:
    external: true
```

### Self-Hosted LLM

Any OpenAI-compatible endpoint works (Ollama, vLLM, llama.cpp server, etc.):

```yaml
# docker-compose.override.yml
services:
  worldmonitor:
    environment:
      LLM_API_URL: "http://your-host:8000/v1/chat/completions"
      LLM_API_KEY: "your-key"
      LLM_MODEL: "your-model-name"
    extra_hosts:
      - "your-host:192.168.1.100"  # if not DNS-resolvable
```

For an endpoint on the Docker host itself, such as Ollama, use
`http://host.docker.internal:11434/v1/chat/completions`. Docker Desktop resolves
that name; on Linux add `- "host.docker.internal:host-gateway"` under
`extra_hosts`. `localhost` inside the container is the container, not the host.

## Documentation indexing

This section matters only if you publish the bundled documentation; the Docker
stack does not serve `/docs`.

The bundled documentation identifies `https://www.worldmonitor.app/docs` as its
original location. `docs/docs.json` sets this canonical base for Mintlify, and
`src/config/docs-locale-seo.ts` uses `DOCS_PUBLIC_ORIGIN` to produce an absolute,
page-specific canonical and language links.

Deployments that run `middleware.ts` also return `X-Robots-Tag: noindex` for docs
HTML on hosts other than the configured public host. This includes preview
hosts. The policy also applies to HEAD and 304 responses, and preserves existing
robots restrictions. It does not stop people from reading the docs. Static
exports and proxies that bypass this middleware must set their own indexing
headers; they retain the canonical metadata only if they preserve it.

The Docker images' nginx configurations send `X-Robots-Tag: noindex, follow` on
every route. Their pages keep `https://www.worldmonitor.app` canonicals, so a
self-hosted copy stays out of search results instead of competing with the
official pages. Visitors and the dashboard are unaffected.

Inspect canonical URLs before publishing a static export. The pinned Mintlify
CLI currently includes `/src/_props` in local preview and export canonicals;
that local output does not establish the hosted provider's URL behavior.

For a fork that publishes its own documentation, deliberately update the
canonical base in `docs/docs.json`, `DOCS_PUBLIC_ORIGIN`, and the docs upstream and
reverse-proxy routes (`DOCS_UPSTREAM_ORIGIN` and `vercel.json`) together. Configure
the provider's base path to match. Check the resulting canonical URLs, language
links, structured data, sitemap, and indexing headers before requesting indexing.
Do not derive the canonical origin from the incoming request or a forwarded-host
header. Keep shared caches separated by host and preserve the response's `Vary`
selectors.

Canonical metadata is a search-engine signal, not a guarantee. A proxy can rewrite
or remove it, and older deployed copies will not receive changes to this repo.

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| 📡 Almost every panel is empty | Seeders haven't run. Run `./scripts/run-seeders.sh`. `curl -s 'http://localhost:3000/api/health?compact=1'` reports `summary.ok` against `summary.total`. The health checks mirror the hosted fleet, so a self-hosted stack never reaches all-OK: sources whose keys you have not set stay `EMPTY` or `STALE_SEED`. |
| 🔴 `docker compose up` says `required variable ... is missing a value` | One of the four [required secrets](#-required-environment-variables) is not in `.env`. |
| 🔴 `worldmonitor` container exits on boot | Check `docker compose logs worldmonitor` (or `podman logs worldmonitor`). The usual causes are `WM_SESSION_SECRET must be at least 32 characters` and an invalid `WM_TRUSTED_PROXY_CIDRS`. |
| 🔑 Seeders say "Missing UPSTASH_REDIS_REST_URL" | The variables are not set in your shell. Run the seeders through `./scripts/run-seeders.sh`, which sets them, or follow [Manual seeder invocation](#-manual-seeder-invocation). If the stack is down, seeders fail with connection errors instead. |
| 📦 `npm ci` fails in Docker build | Lockfile mismatch — regenerate with `docker run --rm -v $(pwd):/app -w /app node:24-alpine npm install --package-lock-only` |
| 🧵 X, Telegram or RSS proxy requests return 502 with `Hostname resolves to a private/reserved IP address` | The image predates the relay allowlist fix ([#10006](https://github.com/koala73/worldmonitor/pull/10006)). Update and rebuild: `git pull && docker compose up -d --build`. |
| 🧵 X or Telegram panels stay empty | The relay needs its own credentials; see [Keys Compose does not pass through](#keys-compose-does-not-pass-through). |
| 🚢 No vessel data | Set `AISSTREAM_API_KEY` in `.env` and run `docker compose up -d`; Compose passes it to the relay. |
| 🔥 No wildfire data | Set `NASA_FIRMS_API_KEY` in `.env` and re-run the seeders. |
| 🌐 No outage data | Set `CLOUDFLARE_API_TOKEN` (free Cloudflare account, token with Radar access). |
