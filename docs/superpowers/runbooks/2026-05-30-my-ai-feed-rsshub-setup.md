# My AI Feed — RSSHub Setup Runbook

The native sources (OpenAI News, Google DeepMind, AI Engineer YouTube) work with
no extra setup. The auth-gated sources (X/Twitter, LinkedIn, Anthropic
engineering, OpenAI engineering) require a **self-hosted RSSHub** that you
operate. This runbook stands one up and wires it in.

## 0. Prerequisites

- A host reachable over **public HTTPS from the Vercel edge** (not localhost,
  LAN, or VPN-only). A small VPS + a reverse proxy (Caddy/Cloudflare) for TLS.
- Docker + Docker Compose.
- Logged-in X and LinkedIn session cookies (for the scraping routes).

## 1. Run RSSHub with Docker Compose

Create `rsshub/docker-compose.yml` on your server:

```yaml
services:
  rsshub:
    image: diygod/rsshub:latest
    restart: always
    ports:
      - "1200:1200"
    environment:
      NODE_ENV: production
      CACHE_TYPE: redis
      REDIS_URL: "redis://redis:6379/"
      # X / Twitter auth — paste your logged-in auth_token cookie value:
      TWITTER_COOKIE: "auth_token=<YOUR_X_AUTH_TOKEN>"
      # LinkedIn auth — paste your li_at cookie value:
      LINKEDIN_COOKIE: "li_at=<YOUR_LINKEDIN_LI_AT>"
      # Optional: gate the instance so only you can read it.
      ACCESS_KEY: "<OPTIONAL_LONG_RANDOM_STRING>"
    depends_on:
      - redis
  redis:
    image: redis:7-alpine
    restart: always
```

Start it:

```bash
cd rsshub && docker compose up -d
curl -s http://localhost:1200/healthz   # expect: ok
```

Put it behind HTTPS (example with Caddy):

```text
rsshub.example.com {
  reverse_proxy localhost:1200
}
```

> **Credentials never leave the server.** Do NOT append `ACCESS_KEY` to feed URLs
> in the app — those URLs are client-visible and logged. If you set `ACCESS_KEY`,
> prefer IP-allowlisting the Vercel egress / Railway relay at your reverse proxy
> instead of `?key=` query params.

## 2. Verify the routes you intend to use

Replace `rsshub.example.com` with your host. Each should return an RSS/Atom XML body:

```bash
curl -sI "https://rsshub.example.com/twitter/user/swyx"          | head -n1
curl -sI "https://rsshub.example.com/linkedin/company/anthropic" | head -n1
curl -sI "https://rsshub.example.com/anthropic/engineering"      | head -n1
curl -sI "https://rsshub.example.com/openai/research"            | head -n1
```

- If `/anthropic/engineering` or `/openai/research` 404, that namespace isn't
  available on your image. Pick an available route (browse `https://rsshub.example.com/`
  or the RSSHub docs) and update the corresponding URL in
  `src/config/my-ai-feed.ts`. If none is stable, drop that source — OpenAI News
  (native) already covers OpenAI.
- X/LinkedIn routes are **best-effort**: they scrape auth-gated sites and break on
  upstream changes. `api/rss-proxy.js` isolates per-feed failures, so a broken
  source never blanks the panel.

## 3. Add your RSSHub host to all four allowlist mirrors

The SSRF guard blocks any host not on the allowlist. Add your RSSHub hostname
(e.g. `rsshub.example.com`) to **all four**:

- `shared/rss-allowed-domains.json`
- `scripts/shared/rss-allowed-domains.json`
- `api/_rss-allowed-domains.js`
- `vite.config.ts` (`RSS_PROXY_ALLOWED_DOMAINS`)

(`shared/rss-allowed-domains.cjs` re-exports the JSON — no edit.) The matcher in
`api/_rss-allowed-domain-match.js` normalizes `www.`, so list the bare host.
Commit this change.

## 4. Set the build-time env vars

These are read at **build time** by Vite (the `VITE_` prefix), so set them in
the Vercel project (Production + Preview) and in local `.env`, then redeploy:

| Env var | Example | Notes |
|---|---|---|
| `VITE_RSSHUB_BASE` | `https://rsshub.example.com` | Public HTTPS base, no trailing slash needed. Unset means only native sources appear. |
| `VITE_AI_X_HANDLES` | `swyx,karpathy,AnthropicAI` | Comma-separated, no `@`. Keep to ~3-5 to limit fan-out. |
| `VITE_AI_LINKEDIN_PAGES` | `anthropic,openai` | Comma-separated company slugs. |

Local dev:

```bash
echo 'VITE_RSSHUB_BASE=https://rsshub.example.com' >> .env
echo 'VITE_AI_X_HANDLES=swyx,karpathy' >> .env
echo 'VITE_AI_LINKEDIN_PAGES=anthropic' >> .env
npm run dev   # the My AI Feed panel now shows native + RSSHub sources
```

## 5. Re-resolve the AI Engineer YouTube channel id (if it ever changes)

```bash
curl -s -A "Mozilla/5.0" https://www.youtube.com/@aiDotEngineer | grep -o 'channel/UC[A-Za-z0-9_-]*' | head -n1
```

Paste the `UC...` value into `AI_ENGINEER_YT_CHANNEL_ID` in
`src/config/my-ai-feed.ts` (and update the pinned id in `tests/my-ai-feed.test.mts`).

## 6. Operational notes

- One RSSHub request per X handle per refresh — keep handle lists small.
- If RSSHub is down, the three native sources keep the panel useful.
- Rotate the X/LinkedIn cookies when they expire (routes start 4xx-ing).
