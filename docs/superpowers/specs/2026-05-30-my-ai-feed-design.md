# My AI Feed — Design Spec

**Date:** 2026-05-30
**Status:** Draft for review
**Owner:** rajesh-ms

## 1. Summary

Add a new dashboard panel, **"My AI Feed"** (`my-ai-feed`), to WorldMonitor that
aggregates seven curated AI-focused sources into a single content-stream panel,
visible in **all variants**:

1. **X / Twitter** — a curated set of accounts the user follows (handles supplied by the user)
2. **LinkedIn** — a curated set of company/creator pages (supplied by the user)
3. **Anthropic engineering blog**
4. **OpenAI news**
5. **OpenAI engineering** — engineering/research posts (see caveat in §3)
6. **Google DeepMind blog** — research/engineering posts
7. **AI Engineer** — new talk videos from the AI Engineer YouTube channel

The feature reuses WorldMonitor's existing RSS pipeline (`api/rss-proxy.js` +
`src/config/feeds.ts`). No new runtime subsystem is introduced.

## 2. Goals / Non-Goals

### Goals
- Surface the five sources above in one new panel across every variant.
- Maximize reliability by using **native RSS where it exists** and routing only
  the sources that have no native feed through a **self-hosted RSSHub**.
- Keep all credentials (X/LinkedIn cookies, RSSHub access keys) **out of the
  committed repo and out of client-visible feed URLs**.
- Keep CI green: feed validation (`scripts/validate-rss-feeds.mjs --ci`),
  allowlist parity, and edge-function guardrail tests.

### Non-Goals
- **No literal personalized timelines.** We do not reproduce the authenticated
  X "Following" home feed or the LinkedIn home feed. These require per-user auth
  and are out of scope. We track curated accounts instead.
- **No per-user runtime personalization.** "My AI Feed" is curated at
  deploy/config time (env-driven), not per logged-in user. This is an explicit
  simplification; revisit only if true per-user feeds are later required.
- No new panel framework, ranking, or storage mechanism — reuse the existing
  news-panel behaviour (ranking, activity tracking, Cmd+K, monitors).

## 3. Approach (chosen: B — Hybrid)

| # | Approaches considered | Outcome |
|---|---|---|
| A | Route **everything** (X, LinkedIn, Anthropic, OpenAI, YouTube) through self-hosted RSSHub | Rejected — single point of failure, unnecessary load/fragility for sources with good native feeds |
| **B** | **Hybrid:** native RSS for OpenAI + YouTube; RSSHub only for X, LinkedIn, Anthropic | **Chosen** — best reliability, minimal RSSHub burden |
| C | Google-News keyword-search proxies (like the existing `ai` panel) | Rejected — no real "following"; keyword noise; doesn't meet intent |

> **OpenAI engineering caveat:** OpenAI does not publish a separate "engineering"
> blog with its own RSS — `openai.com/blog/rss.xml` redirects to the same
> `openai.com/news/rss.xml` we already include, so a native engineering feed
> would duplicate OpenAI news. We therefore route "OpenAI engineering" through
> RSSHub as a **best-effort** category/research route (e.g. `/openai/research`),
> and de-duplicate against OpenAI news at the panel level. If no stable RSSHub
> route exists, this source is dropped and OpenAI news alone covers OpenAI.

### Source → mechanism mapping

| Source | Mechanism | Feed URL pattern | Allowlist host |
|---|---|---|---|
| X curated handles | self-hosted RSSHub | `https://<RSSHUB_BASE>/twitter/user/<handle>` | `<RSSHUB_BASE>` host |
| LinkedIn curated pages | self-hosted RSSHub | `https://<RSSHUB_BASE>/linkedin/company/<slug>` | `<RSSHUB_BASE>` host |
| Anthropic engineering | self-hosted RSSHub | `https://<RSSHUB_BASE>/anthropic/engineering` | `<RSSHUB_BASE>` host |
| OpenAI news | **native** | `https://openai.com/news/rss.xml` | `openai.com` (already allow-listed) |
| OpenAI engineering | self-hosted RSSHub (best-effort) | `https://<RSSHUB_BASE>/openai/research` (or category route) | `<RSSHUB_BASE>` host |
| Google DeepMind blog | **native** | `https://deepmind.google/blog/rss.xml` | `deepmind.google` |
| AI Engineer talks | **native YouTube** | `https://www.youtube.com/feeds/videos.xml?channel_id=<UC…>` | `www.youtube.com` + `youtube.com` |

## 4. Architecture

### 4.1 How feeds flow today (reused unchanged)
```
src/config/feeds.ts  (Feed[] per panel-category)
      │  rss(url) → rssProxyUrl(url)
      ▼
client fetch → api/rss-proxy.js (Edge)
      │  isAllowedDomain(host)  ── SSRF allowlist gate
      ▼
direct fetch from Vercel edge  ──fallback──▶  Railway relay
```

### 4.2 New/changed components

1. **`src/config/my-ai-feed.ts` (new)** — builds the `my-ai-feed` feed list:
   - Static native entries (always present): OpenAI news, Google DeepMind blog,
     AI Engineer YouTube.
   - Dynamic RSSHub entries built from env config (omitted when unset):
     - `VITE_RSSHUB_BASE` — public HTTPS base URL of the self-hosted RSSHub.
     - `VITE_AI_X_HANDLES` — comma-separated X handles.
     - `VITE_AI_LINKEDIN_PAGES` — comma-separated LinkedIn page slugs (with route hint).
     - Anthropic engineering and OpenAI engineering entries added when
       `VITE_RSSHUB_BASE` is set.
   - RSSHub/YouTube URLs are assembled with **template literals / a helper**, not
     single-quoted `rss('...')` literals. This is deliberate: the `--ci` feed
     validator only host-checks single-quoted literals, so env-built URLs are
     skipped, and when the env vars are unset those feeds simply don't exist.
   - The OpenAI native entry uses a normal `rss('https://openai.com/news/rss.xml')`
     literal (validated, host already allow-listed). The DeepMind native entry uses
     `rss('https://deepmind.google/blog/rss.xml')`. The YouTube native entry uses
     a literal once a concrete `channel_id` is pinned.

2. **`src/config/feeds.ts`** — register the `my-ai-feed` category by importing and
   spreading the list from `my-ai-feed.ts` into FULL_FEEDS and TECH_FEEDS (and via
   `CANONICAL_FEEDS` so finance/commodity/energy/happy resolve it). Add the new
   source `name`s to `SOURCE_TYPES` (type `tech`) and to
   `DEFAULT_ENABLED_SOURCES['my-ai-feed']`. Source `name`s MUST match exactly
   between the feed entries and `DEFAULT_ENABLED_SOURCES` or the panel starts empty.

3. **`src/config/panels.ts`** — define the `my-ai-feed` PanelConfig and add it to
   **all six** `*_PANELS` blocks (FULL, TECH, FINANCE, COMMODITY, ENERGY, HAPPY)
   so `VARIANT_DEFAULTS` (= `Object.keys(*_PANELS)`) includes it in every variant.
   Optionally add per-variant name overrides in `VARIANT_PANEL_OVERRIDES`.

4. **`src/app/data-loader.ts`** — wire the `my-ai-feed` category into the
   news/content loading path the same way existing feed panels are loaded.

5. **Allowlist — update ALL 5 mirrors** (drift causes runtime 403 or CI failure):
   - `shared/rss-allowed-domains.json`
   - `shared/rss-allowed-domains.cjs`
   - `scripts/shared/rss-allowed-domains.json`
   - `api/_rss-allowed-domains.js`
   - `vite.config.ts` → `RSS_PROXY_ALLOWED_DOMAINS`
   Add: the self-hosted RSSHub host, `deepmind.google`, `www.youtube.com`, and
   `youtube.com` (YouTube feed redirects can switch between the two — allowlist both).

## 5. Configuration & deployment

Set these as Vercel project env vars (and `.env` for local dev). All are
**non-secret** (the RSSHub base is a plain public hostname; credentials live
inside the RSSHub instance, never in these values or URLs):

| Env var | Example | Notes |
|---|---|---|
| `VITE_RSSHUB_BASE` | `https://rsshub.example.com` | **Must be public HTTPS, reachable from Vercel edge.** Not localhost/LAN/VPN. |
| `VITE_AI_X_HANDLES` | `swyx,karpathy,AnthropicAI` | Comma-separated, no `@`. |
| `VITE_AI_LINKEDIN_PAGES` | `anthropic,openai` | Comma-separated page slugs. |

The self-hosted RSSHub instance holds the X/LinkedIn auth cookies and any RSSHub
`ACCESS_KEY` in **its own** environment. We never append access keys to the feed
URLs in `feeds.ts` (they would be client-visible and logged). If RSSHub access
control is required, prefer IP-allowlisting the relay/edge or a path the instance
maps internally — to be decided at implementation against the chosen RSSHub
deployment.

## 6. Reliability & risk handling

- **RSSHub reachability:** If the instance is not publicly reachable from Vercel
  edge, all three RSSHub-backed sources fail. Mitigation: documented hard
  requirement (public HTTPS); the native OpenAI/YouTube sources keep the panel
  useful even if RSSHub is down.
- **X/LinkedIn fragility:** these RSSHub routes scrape auth-gated sites and break
  on upstream changes. They are **best-effort**. `api/rss-proxy.js` already
  isolates failures per feed, so one broken source does not blank the panel.
- **Fan-out / rate limits:** one RSSHub request per X handle per refresh. Keep the
  default handle list small (≈3–5). If RSSHub later exposes a combined
  multi-handle route, switch to it to cut request count.
- **YouTube channel_id:** the handle `@aiDotEngineer` is **not** valid for
  `feeds/videos.xml?channel_id=`. Resolve and pin the canonical `UC…` channel ID
  at implementation time (from the channel page `externalId`/`channelId`).
- **Placeholder/CI safety:** achieved by env-built template-literal URLs (Section
  4.2.1) — no placeholder literals are committed, so `--ci` validation stays green.

## 7. Testing & validation

- `npm run typecheck` and `npm run typecheck:api` clean.
- `npm run test:data` — add/extend a test asserting the `my-ai-feed` category
  exists, its native entries (OpenAI, DeepMind, YouTube) are well-formed, and every
  feed `name` is present in `DEFAULT_ENABLED_SOURCES['my-ai-feed']`.
- Allowlist parity test / `tests/edge-functions.test.mjs` green after adding the
  new hosts to all 5 mirrors.
- `node scripts/validate-rss-feeds.mjs` (non-CI, local) to sanity-check the native
  OpenAI/YouTube feeds resolve; confirm env-built RSSHub URLs are skipped by
  `--ci` mode.
- Manual: with env vars set against a real RSSHub, confirm all five sources
  populate the panel in at least the full and tech variants.

## 8. Open items to resolve during implementation

- Exact RSSHub route strings for LinkedIn (company vs profile vs newsletter) for
  the user's chosen pages.
- Confirm RSSHub has/needs an `/anthropic/engineering` route on the user's
  instance (some deployments require enabling specific namespaces); fall back to
  `/anthropic/news` or a maintained third-party Anthropic engineering RSS if not.
- Confirm a working RSSHub route for **OpenAI engineering** (e.g. `/openai/research`
  or a category route); if none is stable, drop this source (OpenAI news covers it).
- Verify the **DeepMind** native feed `https://deepmind.google/blog/rss.xml`
  resolves from the Vercel edge and pin the exact path if it changes.
- Final pinned YouTube `channel_id` for `@aiDotEngineer`.
- Whether to disable X/LinkedIn by default until the RSSHub instance is proven
  stable (default: enabled, best-effort).
