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

# 2. Start the stack
docker compose up -d        # or: uvx podman-compose up -d

# 3. Seed data into Redis
./scripts/run-seeders.sh

# 4. Open the dashboard
open http://localhost:3000
```

The dashboard works out of the box with public data sources (earthquakes, weather, conflicts, etc.). API keys unlock additional data feeds.

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
      ACLED_ACCESS_TOKEN: ""      # https://acleddata.com (free for researchers)

      # 🛰️ Earth Observation
      NASA_FIRMS_API_KEY: ""      # https://firms.modaps.eosdis.nasa.gov (free)

      # ✈️ Aviation
      AVIATIONSTACK_API: ""       # https://aviationstack.com (free tier)

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

### 🔧 Manual seeder invocation

If you prefer to run seeders individually:

```bash
export UPSTASH_REDIS_REST_URL=http://localhost:8079
export UPSTASH_REDIS_REST_TOKEN=wm-local-token
node scripts/seed-earthquakes.mjs
node scripts/seed-military-flights.mjs
# ... etc
```

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
- If you hit `npm ci` sync errors in Docker, regenerate the lockfile with the container's npm version:
  ```bash
  docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npm install --package-lock-only
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

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| 📡 `0/55 OK` on health check | Seeders haven't run — `./scripts/run-seeders.sh` |
| 🔴 nginx won't start | Check `podman logs worldmonitor` — likely missing `gettext` package |
| 🔑 Seeders say "Missing UPSTASH_REDIS_REST_URL" | Stack isn't running, or run via `./scripts/run-seeders.sh` (auto-sets env vars) |
| 📦 `npm ci` fails in Docker build | Lockfile mismatch — regenerate with `docker run --rm -v $(pwd):/app -w /app node:22-alpine npm install --package-lock-only` |
| 🚢 No vessel data | Set `AISSTREAM_API_KEY` in both `worldmonitor` and `ais-relay` services |
| 🔥 No wildfire data | Set `NASA_FIRMS_API_KEY` |
| 🌐 No outage data | Requires `CLOUDFLARE_API_TOKEN` (paid Radar access) |
