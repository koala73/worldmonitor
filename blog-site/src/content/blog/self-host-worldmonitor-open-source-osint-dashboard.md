---
title: "Self-Host WorldMonitor: Run an Open Source OSINT Dashboard Locally"
description: "A practical overview of self-hosting WorldMonitor with Docker or Podman, required secrets, Redis, seeders, optional API keys, and AGPL responsibilities."
metaTitle: "Self-Host WorldMonitor OSINT Dashboard"
keywords: "self host WorldMonitor, open source OSINT dashboard, Docker OSINT dashboard, geopolitical dashboard self hosted, AGPL intelligence dashboard"
audience: "Developers, OSINT builders, platform teams, security researchers"
heroImage: "/blog/og/self-host-worldmonitor-open-source-osint-dashboard.png"
pubDate: "2026-06-13"
---

WorldMonitor is open source, but "open source" does not automatically mean "safe to run on the public internet with defaults." A serious self-hosted intelligence dashboard needs secrets, seeders, Redis, source keys, and a clear understanding of which feeds are public, optional, or paid.

The good news: the local stack is designed to run with Docker or Podman. You can bring up the dashboard, seed Redis, and open a browser at `http://localhost:3000`.

The important caveat: you should treat it like infrastructure, not a toy clone. Generate real secrets, keep override files out of git, and understand which data sources require API keys.

## What self-hosting gives you

Self-hosting is useful when you want:

- a local geopolitical and OSINT dashboard for research
- control over API keys and source integrations
- a development environment for extending panels or APIs
- an auditable AGPL codebase instead of a closed vendor workflow
- a private Redis-backed data cache for seeders
- a local AIS relay path when maritime data is configured

It does not magically give you every upstream dataset. Some sources are public, some require free signup, and some are paid. Self-hosting controls the application layer; it does not bypass upstream licensing or authentication.

## The local stack

The Docker stack contains four core services:

| Service | Purpose |
|---|---|
| `worldmonitor` | nginx plus the Node.js API surface |
| `worldmonitor-redis` | Redis data store |
| `worldmonitor-redis-rest` | Upstash-compatible REST proxy |
| `worldmonitor-ais-relay` | AISStream relay for vessel tracking when configured |

The runtime route is simple: the browser hits `localhost:3000`, nginx serves the Vite app and proxies `/api/*` to the Node API, the API talks to the Redis REST proxy, and seed scripts populate Redis.

That architecture is deliberately close to production concepts without requiring Vercel, Railway, or Upstash for a local install.

## Required prerequisites

You need:

- Docker or Podman
- Docker Compose or podman-compose
- Node.js 22 or newer for host-side seed scripts
- a local `.env` with generated secrets

The required secrets are:

- `RELAY_SHARED_SECRET`
- `REDIS_PASSWORD`
- `REDIS_TOKEN`

Generate them with a secure random source such as `openssl rand -hex 32`. The stack refuses to start without these values because hardcoded local defaults are unsafe once someone changes a bind address or deploys an override file.

## The quick path

At a high level:

1. Clone the repository.
2. Install dependencies.
3. Generate the required secrets into `.env`.
4. Run `docker compose up -d`.
5. Run `./scripts/run-seeders.sh`.
6. Open `http://localhost:3000`.

The seeders are not optional if you want a useful dashboard. Redis starts empty. The app can render, but many panels need cached data written by seed scripts.

If you remove volumes with `docker compose down -v`, Redis data is lost and you need to seed again.

## API keys: what unlocks more data

WorldMonitor works with many public sources, but some feeds need keys.

Examples of optional or source-specific keys include:

- GROQ or OpenRouter for LLM-backed intelligence assessments
- FRED, Finnhub, EIA, and AviationStack for economic and market data
- ACLED for conflict event access
- NASA FIRMS for wildfire and thermal anomaly data
- AISStream for maritime vessel data
- Cloudflare Radar for internet outage data
- an OpenAI-compatible self-hosted LLM endpoint if you run local models

The recommended pattern is `docker-compose.override.yml` for local keys. That file is gitignored, which keeps secrets out of commits.

Do not paste production secrets into issue comments, screenshots, terminal transcripts, or blog posts. The safest self-hosting guide is boring about secrets.

## Security notes

The local relay can be run without auth only by setting an explicit danger flag. That path is for local debugging, not internet-exposed deployments. If a route is reachable by other machines, assume someone will eventually find it.

Also remember:

- Redis needs a password and REST bearer token.
- API keys belong in local env or override files, not source control.
- nginx mirrors the Vercel script policy and does not allow arbitrary inline scripts.
- Source APIs have their own terms and limits.
- AGPL-3.0-only licensing has obligations when you modify and network-deploy the software.

Self-hosting is power and responsibility in the same box.

## Development vs production

For local development, you can run the Vite app and API surfaces directly. For a fuller self-hosted stack, Docker Compose gives you the nginx, API, Redis, REST proxy, and relay shape.

For production-like deployment, you need to think beyond "does it start?":

- source-key rotation
- cron or scheduled seeders
- health checks
- backup/restore for Redis data if needed
- observability for failing upstream sources
- update cadence for upstream schema changes
- public exposure and network policy

WorldMonitor is a real-time intelligence dashboard with many external dependencies. That means operational hygiene matters.

For developer context before you deploy, read the [developer API and open-source guide](/blog/posts/build-on-worldmonitor-developer-api-open-source/) and the [MCP server guide](/blog/posts/worldmonitor-mcp-server-ai-agents-real-time-intelligence/).

## Source transparency

The self-hosting path uses public code, local secrets, Redis-backed caches, and seed scripts that fetch upstream data. Some panels will show more when optional keys exist. Some sources are free with signup. Some are paid. Missing source keys should be treated as expected partial coverage, not a broken product.

That distinction is important for demos. If a panel is empty, check whether the seeder ran, whether Redis has data, whether the key is configured, and whether the source is currently available.

## Frequently Asked Questions

**Can I run WorldMonitor entirely offline?**

Not meaningfully. The application can run locally, but most intelligence value comes from fetching upstream public or authenticated sources into Redis.

**Do I need every API key?**

No. Many public sources work without keys, and optional keys unlock additional feeds. Start with the public stack, then add keys for the domains you actually use.

**Can I deploy my fork publicly?**

You can, but read the AGPL license and upstream source terms carefully. Network deployment and redistribution have obligations, and third-party data sources may have their own rules.

---

**Self-hosting WorldMonitor is not about cloning a website. It is about owning the data path, the secrets, and the operational tradeoffs behind your intelligence workspace.**
