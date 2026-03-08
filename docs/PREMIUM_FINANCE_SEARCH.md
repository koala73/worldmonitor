# Premium Finance Search Layer

This document covers the **extra** targeted stock-news search layer used by premium finance.

It is separate from the core premium-finance architecture on purpose.

Core premium finance can still function without this layer. The search layer exists to improve stock-news discovery quality for targeted ticker analysis, especially where feed-only coverage is weak.

See the core system document in [PREMIUM_FINANCE.md](./PREMIUM_FINANCE.md).

---

## Why This Exists

World Monitor is mostly feed-first:

- curated RSS feeds
- digest aggregation
- Google News RSS fallbacks

The source repo being migrated from uses a broader search-provider layer for stock-specific news lookup. That produces better targeted coverage for:

- single-symbol premium analysis
- less prominent tickers
- recent company-specific developments not well represented in the feed inventory

This layer closes that gap without replacing the project's broader feed architecture.

---

## Provider Order

The current provider chain is:

1. `Tavily`
2. `Brave`
3. `SerpAPI`
4. Google News RSS fallback

`Bocha` was intentionally not added because the current premium-finance direction is not China-focused.

---

## Implementation

Primary implementation:

- [stock-news-search.ts](../server/worldmonitor/market/v1/stock-news-search.ts)

Integration point:

- [analyze-stock.ts](../server/worldmonitor/market/v1/analyze-stock.ts)

The helper:

- builds a normalized stock-news query
- tries providers in priority order
- rotates across configured keys
- tracks temporary provider/key failures in memory
- normalizes provider responses into `StockAnalysisHeadline`
- caches search results in Redis
- falls back to Google News RSS when provider-backed search is unavailable

---

## Query Strategy

The current query shape intentionally mirrors the stock-news style from the source repo for foreign equities:

`<Company Name> <SYMBOL> stock latest news`

Examples:

- `Apple AAPL stock latest news`
- `Microsoft MSFT stock latest news`

Search freshness is dynamic:

- Monday: 3 days
- Saturday/Sunday: 2 days
- Tuesday-Friday: 1 day

That mirrors the idea that weekend gaps need a wider lookback than midweek trading days.

---

## Runtime Secrets

The search layer uses runtime-managed secret keys so it fits the same desktop/web secret model as the rest of the project.

Configured keys:

- `TAVILY_API_KEYS`
- `BRAVE_API_KEYS`
- `SERPAPI_API_KEYS`

These are wired through:

- [runtime-config.ts](../src/services/runtime-config.ts)
- [settings-constants.ts](../src/services/settings-constants.ts)
- [main.rs](../src-tauri/src/main.rs)
- [local-api-server.mjs](../src-tauri/sidecar/local-api-server.mjs)

The values are multi-key strings, split on commas or newlines.

---

## Caching

Search results are cached in Redis under a query-derived key. The cache key includes:

- symbol
- dynamic day window
- result limit
- hashed query

This avoids repeated provider calls when multiple users request the same premium stock analysis.

The cache is intentionally short-lived because search-backed finance news gets stale quickly.

---

## Fallback Behavior

If `Tavily` fails, the system tries `Brave`.

If `Brave` fails, the system tries `SerpAPI`.

If provider-backed search is unavailable, empty, or unconfigured, the system falls back to Google News RSS.

That means:

- premium stock analysis does not hard-depend on paid search providers
- provider keys improve coverage, not feature availability

---

## Why This Is A Separate Layer

This layer is not the stock-analysis engine itself.

It should be treated as:

- targeted news enrichment
- a coverage-quality upgrade
- a provider-backed precision lookup layer

It should **not** be treated as:

- the canonical market/news ingestion architecture
- a replacement for feed digest aggregation
- the source of truth for premium finance persistence

That separation matters because it keeps the premium finance feature understandable:

- core finance product logic stays stable
- search-backed enrichment can evolve independently

---

## Known Boundaries

The current implementation does not yet expose a standalone public stock-news search RPC.

Right now it is an internal backend helper used by premium stock analysis. That is deliberate:

- it keeps the surface area small
- it avoids adding a premature UI/API product surface
- it allows provider behavior to evolve before being frozen into a dedicated external contract

If needed later, this helper can be promoted into a first-class market RPC.
