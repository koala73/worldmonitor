# 🌍 Self-Hosting World Monitor

Run the full World Monitor stack locally with Docker/Podman.

## 📋 Prerequisites

- **Docker** or **Podman** (rootless works fine)
- **Docker Compose** or **podman-compose** (`pip install podman-compose` or `uvx podman-compose`)
- **Node.js 22+** (for running seed scripts on the host)

## 🚀 Quick Start

```bash
# 1. Clone and enter the repo
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install

# 2. Generate the REQUIRED secrets. Without these the stack will not start
#    (see the "Required Environment Variables" table below).
echo "RELAY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env
echo "REDIS_PASSWORD=$(openssl rand -hex 32)"      >> .env
echo "REDIS_TOKEN=$(openssl rand -hex 32)"         >> .env
echo "WM_SESSION_SECRET=$(openssl rand -hex 32)"   >> .env

# 3. Start the stack
docker compose up -d        # or: uvx podman-compose up -d

# 4. Seed data into Redis
./scripts/run-seeders.sh

# 5. Open the dashboard
open http://localhost:3000
```

The dashboard works out of the box with public data sources (earthquakes, weather, conflicts, etc.). API keys unlock additional data feeds.

## 🔐 Required Environment Variables

These must be set before `docker compose up -d`, or one of the containers will exit on boot.

| Variable | Purpose | How to generate |
| --- | --- | --- |
| `RELAY_SHARED_SECRET` | Authenticates every non-public request the dashboard makes to the AIS relay. The relay refuses to start without it. | `openssl rand -hex 32` |
| `REDIS_PASSWORD` | Redis AUTH password (`--requirepass`). The Redis container refuses to start without it; the REST proxy uses it in its upstream connection string. | `openssl rand -hex 32` |
| `REDIS_TOKEN` | Bearer token the REST proxy (`redis-rest`) requires on every request, and the value the app sends as `UPSTASH_REDIS_REST_TOKEN`. The proxy and app containers refuse to start without it. | `openssl rand -hex 32` |
| `WM_SESSION_SECRET` | Signs the anonymous `wm-session` cookies. Without it `/api/wm-session` fails closed (503) and every session-gated data route degrades for anonymous visitors. | `openssl rand -hex 32` |

> Earlier releases shipped `wm-local-token` as a default for the REST token. That default has been removed (#3804) — the proxy was only reachable from `127.0.0.1:8079` so external exposure required a hostile `docker-compose.override.yml`, but any user who flipped that binding to `0.0.0.0` was instantly authenticated by a publicly documented string. Fresh installs and existing clones both need to set `REDIS_TOKEN` and `REDIS_PASSWORD` in `.env` from this release onward.

> **Upgrading an existing deployment:** `WM_SESSION_SECRET` is newly required. Existing clones must add it to `.env` (`echo "WM_SESSION_SECRET=$(openssl rand -hex 32)" >> .env`) before `docker compose up -d`, or Compose fails with `required variable WM_SESSION_SECRET is missing a value`. The value must be at least 32 characters, or `/api/wm-session` returns 503 at runtime even though the stack boots.

> Need to bring the relay up without auth for local debugging? Set `I_UNDERSTAND_THIS_DISABLES_AUTH=true` (the deprecated `ALLOW_UNAUTHENTICATED_RELAY=true` is still accepted). The relay will log a loud `[SECURITY]` warning at boot and every 5 minutes, and every non-public route will be reachable by anyone who can hit the port — **never use this on an internet-reachable host.**

## 🔑 API Keys

Create a `docker-compose.override.yml` to inject your keys. This file is **gitignored** — your secrets stay local.

```yaml
services:
  worldmonitor:
    environment:
      # 🤖 LLM — pick one or both (used for intelligence assessments)
      GROQ_API_KEY: ""            # https://console.groq.com (free, 14.4K req/day)
      OPENROUTER_API_KEY: ""      # https://openrouter.ai (free, 50 req/day)

      # 📊 Markets & Economics
      FINNHUB_API_KEY: ""         # https://finnhub.io (free tier)
      FRED_API_KEY: ""            # https://fred.stlouisfed.org/docs/api/api_key.html (free)
      EIA_API_KEY: ""             # https://www.eia.gov/opendata/ (free)

      # ⚔️ Conflict & Unrest
      ACLED_EMAIL: ""             # https://acleddata.com (free for researchers)
      ACLED_PASSWORD: ""          # OAuth flow — tokens auto-refresh (preferred over ACLED_ACCESS_TOKEN)
      ACLED_ACCESS_TOKEN: ""      # Alternative: static token (expires every 24h)

      # 🛰️ Earth Observation
      NASA_FIRMS_API_KEY: ""      # REQUIRED for seed-fire-detections.mjs — https://firms.modaps.eosdis.nasa.gov (free)

      # ✈️ Aviation
      AVIATIONSTACK_API: ""       # https://aviationstack.com (free tier)
      TRAVELPAYOUTS_API_TOKEN: "" # https://travelpayouts.com (flight price search — optional)
      # 🚢 Maritime
      AISSTREAM_API_KEY: ""       # https://aisstream.io (free)

      # 🌐 Internet Outages (paid)
      CLOUDFLARE_API_TOKEN: ""    # https://dash.cloudflare.com (requires Radar access)

      # 🔌 Self-hosted LLM (optional — any OpenAI-compatible endpoint)
      LLM_API_URL: ""             # e.g. http://localhost:11434/v1/chat/completions
      LLM_API_KEY: ""
      LLM_MODEL: ""

  ais-relay:
    environment:
      AISSTREAM_API_KEY: ""       # same key as above — relay needs it too
```

### 💰 Free vs Paid

| Status | Keys |
|--------|------|
| 🟢 No key needed | Earthquakes, weather, natural events, UNHCR displacement, prediction markets, stablecoins, crypto, spending, climate anomalies, submarine cables, BIS data, cyber threats |
| 🟢 Free signup | GROQ, FRED, EIA, NASA FIRMS, AISSTREAM, Finnhub, AviationStack, ACLED, OpenRouter |
| 🟡 Free (limited) | OpenSky (higher rate limits with account) |
| 🔴 Paid | Cloudflare Radar (internet outages) |

## 🌱 Seeding Data

The seed scripts fetch upstream data and write it to Redis. They run **on the host** (not inside the container) and need the Redis REST proxy to be running.

```bash
# Run all seeders (auto-sources API keys from docker-compose.override.yml)
./scripts/run-seeders.sh
```

**⚠️ Important:** Redis data persists across container restarts via the `redis-data` volume, but is lost on `docker compose down -v`. Re-run the seeders if you remove volumes or see stale data.

To automate, add a cron job:

```bash
# Re-seed every 30 minutes
*/30 * * * * cd /path/to/worldmonitor && ./scripts/run-seeders.sh >> /tmp/wm-seeders.log 2>&1
```

**Per-seeder timeout (`SEED_TIMEOUT`):** standalone seeders are each wrapped in a
wall-clock cap so one hung upstream can't starve the rest of the run. It defaults
to `1800` (30 min); override with `SEED_TIMEOUT=<seconds>`, or `SEED_TIMEOUT=0` to
disable. Bundle seeders (`seed-bundle-*.mjs`) are exempt — they already bound each
section internally. Requires the `timeout` command (GNU coreutils); if it's absent
the cap is silently skipped.

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
┌─────────────────────────────────────────────┐
│                 localhost:3000               │
│                   (nginx)                    │
├──────────────┬──────────────────────────────┤
│ Static Files │      /api/* proxy            │
│  (Vite SPA)  │         │                    │
│              │    Node.js API (:46123)       │
│              │    50+ route handlers         │
│              │         │                     │
│              │    Redis REST proxy (:8079)   │
│              │         │                     │
│              │      Redis (:6379)            │
└──────────────┴──────────────────────────────┘
         AIS Relay (WebSocket → AISStream)
```

| Container | Purpose | Port |
|-----------|---------|------|
| `worldmonitor` | nginx + Node.js API (supervisord) | 3000 → 8080 |
| `worldmonitor-redis` | Data store | 6379 (internal) |
| `worldmonitor-redis-rest` | Upstash-compatible REST proxy | 8079 |
| `worldmonitor-ais-relay` | Live vessel tracking WebSocket | 3004 (internal) |

> **`redis-rest` command allowlist**: the bundled proxy (`docker/redis-rest-proxy.mjs`) only
> forwards a fixed allowlist of Redis commands and rejects `EVAL`/`EVALSHA`/`SCRIPT` (no Lua
> scripting). Two consequences for a self-hosted stack:
>
> - `@upstash/ratelimit`'s Lua-based sliding-window limiter (`server/_shared/rate-limit.ts`,
>   `api/_rate-limit.js`) can't run against it. Both automatically detect the rejection once and
>   fall back to a non-Lua fixed-window limiter (`INCR` + `EXPIRE NX`) for the rest of the
>   process — rate limiting still enforces, just with fixed- instead of sliding-window semantics.
> - `scripts/ais-relay.cjs`'s own in-container seed loops (`UPSTASH_ENABLED`) also require
>   `UPSTASH_REDIS_REST_URL` to start with `https://` by default, which the plain-HTTP proxy
>   never satisfies. Set `UPSTASH_ALLOW_INSECURE_HTTP=true` on the `ais-relay` service (already
>   wired for `redis-rest` in `docker-compose.yml`) to opt into using the proxy from
>   inside the relay container.

## 🔨 Building from Source

```bash
# Frontend only (for development)
npx vite build

# Full Docker image
docker build -t worldmonitor:latest -f Dockerfile .

# Rebuild and restart
docker compose down && docker compose up -d
./scripts/run-seeders.sh
```

### ⚠️ Build Notes

- The Docker image uses **Node.js 22 Alpine** for both builder and runtime stages
- Blog site build is skipped in Docker (separate dependencies)
- The runtime stage needs `gettext` (Alpine package) for `envsubst` in the nginx config
- Docker nginx mirrors Vercel's `script-src` policy and does not allow `'unsafe-inline'`; hash-pin any custom inline scripts before adding them to a self-hosted build.
- If you hit `npm ci` sync errors in Docker, regenerate the lockfile with the container's npm version:
  ```bash
  docker run --rm -v "$(pwd)":/app -w /app node:24-alpine npm install --package-lock-only
  ```

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

### Claude Code (use your Claude subscription)

If you have a Claude Pro/Max subscription, the bundled shim (`Dockerfile.claude-shim`)
exposes headless Claude Code as an OpenAI-compatible endpoint, so the dashboard's AI
features run against your subscription instead of a metered API key. The shim strips
Claude Code's session context per call (settings, skills, tools), so a request costs
little more than its own prompt.

1. On a machine with a browser, run `claude setup-token` (any recent Claude Code CLI;
   the shim container installs the latest) and copy the long-lived OAuth token.
2. Add the token and a shim key to `.env` — run these in a shell so the `openssl`
   substitution executes (pasting `$(openssl …)` literally into `.env` would make the
   key that literal string):

   ```bash
   echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" >> .env
   echo "SHIM_API_KEY=$(openssl rand -hex 32)" >> .env   # authenticates the app→shim hop
   ```
3. Wire it up in `docker-compose.override.yml`:

```yaml
# docker-compose.override.yml
services:
  claude-shim:
    build:
      context: .
      dockerfile: Dockerfile.claude-shim
    environment:
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:?}
      SHIM_API_KEY: ${SHIM_API_KEY:?}
      SHIM_DAILY_CAP: "300"          # default 300; calls/day then 429 (protects quota)
      SHIM_MAX_CONCURRENCY: "2"      # default 4; lowered to protect subscription quota
      SHIM_CACHE_TTL_MS: "900000"    # default 900000; identical NON-STREAMING requests
                                     # cached 15 min (streamed chat-analyst calls are not
                                     # cached and always count against SHIM_DAILY_CAP)
      SHIM_QUEUE_TIMEOUT_MS: "45000" # default 15000; reject queued calls after this. Keep
                                     # ≥ the caller's patience (LLM_MIN_TIMEOUT_MS below)
                                     # so a call that will still be awaited isn't rejected.
      # SHIM_TIMEOUT_MS default 120000 (hard per-call ceiling)
    restart: unless-stopped
  worldmonitor:
    environment:
      LLM_API_URL: "http://claude-shim:8383/v1/chat/completions"  # full path — used verbatim
      LLM_API_KEY: ${SHIM_API_KEY:?}   # required, or the generic provider is skipped
      LLM_MODEL: "claude-haiku"
      LLM_TOOL_PROVIDER: "generic"      # prefer the shim over groq/openrouter…
      LLM_TOOL_MODEL: "claude-haiku"    # …for extraction/classification stages
      LLM_REASONING_PROVIDER: "generic"
      LLM_REASONING_MODEL: "claude-sonnet"  # briefs + chat analyst
```

Model names containing `haiku`/`sonnet`/`opus` map to those Claude tiers; anything else
falls back to `CLAUDE_SHIM_DEFAULT_MODEL` (default `haiku`). Notes:

- `LLM_API_URL` must include the full `/v1/chat/completions` path (it is not appended).
- Self-hosted backends are slower than hosted APIs — set `LLM_MIN_TIMEOUT_MS: "60000"`
  on the `worldmonitor` service so long generations (country briefs) aren't cut off by
  the 25s per-attempt timeout tuned for hosted providers. Applies to any self-hosted
  LLM (Ollama, vLLM, this shim), not just Claude Code.
- Leave `GROQ_API_KEY`/`OPENROUTER_API_KEY` unset (or keep the `LLM_*_PROVIDER: generic`
  pins) — `generic` is last in the fallback chain.
- The token draws down your personal subscription quota. Keep the daily cap conservative,
  keep the deployment private, and don't share the endpoint: Anthropic's terms cover
  personal use of your own subscription through Claude Code.
- Rotate the token by re-running `claude setup-token` and restarting the shim container.

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| 📡 `0/55 OK` on health check | Seeders haven't run — `./scripts/run-seeders.sh` |
| 🔴 nginx won't start | Check `podman logs worldmonitor` — likely missing `gettext` package |
| 🔑 Seeders say "Missing UPSTASH_REDIS_REST_URL" | Stack isn't running, or run via `./scripts/run-seeders.sh` (auto-sets env vars) |
| 📦 `npm ci` fails in Docker build | Lockfile mismatch — regenerate with `docker run --rm -v $(pwd):/app -w /app node:24-alpine npm install --package-lock-only` |
| 🚢 No vessel data | Set `AISSTREAM_API_KEY` in both `worldmonitor` and `ais-relay` services |
| 🔥 No wildfire data | Set `NASA_FIRMS_API_KEY` |
| 🌐 No outage data | Requires `CLOUDFLARE_API_TOKEN` (paid Radar access) |
| ⚙️ `required variable WM_SESSION_SECRET is missing a value` | Add it to `.env`: `echo "WM_SESSION_SECRET=$(openssl rand -hex 32)" >> .env` |
| 🔒 `/api/wm-session` 503 despite the var being set | `WM_SESSION_SECRET` must be ≥ 32 chars — regenerate with `openssl rand -hex 32` |
| 🤖 Claude shim AI features silently fall back | Check `SHIM_DAILY_CAP` isn't hit (`GET /` on the shim shows `today`/`cap`); set `LLM_MIN_TIMEOUT_MS: "60000"` so briefs aren't cut off by the 25s hosted-tuned timeout |
