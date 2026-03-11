---
title: "Premium Finance"
description: "Premium finance is the finance-variant layer that ports the reusable stock-analysis product surface from daily_stock_analysis into World Monitor without importing that repo's full standalone app architecture."
---

# Premium Finance

Premium finance is the finance-variant layer that ports the reusable stock-analysis product surface from `../daily_stock_analysis` into World Monitor without importing that repo's full standalone app architecture.

This layer is intentionally split into:

- `core premium finance`
- `extra enrichment layers`

The core layer is the part required for the premium feature to work. Extra layers improve output quality or efficiency but are not the source of truth.

---

## Core Scope

The current premium finance scope includes:

- premium stock analysis
- shared analysis history
- stored backtest summaries
- scheduled daily market brief generation
- finance-variant premium panels
- Redis-backed shared backend persistence for analysis history and backtests

It does **not** attempt full parity with the source repo's:

- standalone web app
- relational database model
- notification system
- agent/chat workflows
- bot integrations
- image ticker extraction
- China-specific provider mesh

---

## Core Architecture

### Request Flow

1. Finance premium panels load through the normal app shell and panel loader.
2. Premium stock RPCs are called through `MarketService`.
3. Premium endpoints require `WORLDMONITOR_API_KEY` server-side, not just a locked UI.
4. Results are persisted into Redis-backed shared storage.
5. Panels prefer stored shared results before recomputing fresh analyses or backtests.

### Core Backend Surfaces

Primary handlers:

- [analyze-stock.ts](https://github.com/koala73/worldmonitor/blob/main/server/worldmonitor/market/v1/analyze-stock.ts)
- [get-stock-analysis-history.ts](https://github.com/koala73/worldmonitor/blob/main/server/worldmonitor/market/v1/get-stock-analysis-history.ts)
- [backtest-stock.ts](https://github.com/koala73/worldmonitor/blob/main/server/worldmonitor/market/v1/backtest-stock.ts)
- [list-stored-stock-backtests.ts](https://github.com/koala73/worldmonitor/blob/main/server/worldmonitor/market/v1/list-stored-stock-backtests.ts)
- [premium-stock-store.ts](https://github.com/koala73/worldmonitor/blob/main/server/worldmonitor/market/v1/premium-stock-store.ts)

Primary contracts:

- [analyze_stock.proto](https://github.com/koala73/worldmonitor/blob/main/proto/worldmonitor/market/v1/analyze_stock.proto)
- [get_stock_analysis_history.proto](https://github.com/koala73/worldmonitor/blob/main/proto/worldmonitor/market/v1/get_stock_analysis_history.proto)
- [backtest_stock.proto](https://github.com/koala73/worldmonitor/blob/main/proto/worldmonitor/market/v1/backtest_stock.proto)
- [list_stored_stock_backtests.proto](https://github.com/koala73/worldmonitor/blob/main/proto/worldmonitor/market/v1/list_stored_stock_backtests.proto)
- [service.proto](https://github.com/koala73/worldmonitor/blob/main/proto/worldmonitor/market/v1/service.proto)

### Frontend Surfaces

Panels:

- [StockAnalysisPanel.ts](https://github.com/koala73/worldmonitor/blob/main/src/components/StockAnalysisPanel.ts)
- [StockBacktestPanel.ts](https://github.com/koala73/worldmonitor/blob/main/src/components/StockBacktestPanel.ts)
- [DailyMarketBriefPanel.ts](https://github.com/koala73/worldmonitor/blob/main/src/components/DailyMarketBriefPanel.ts)

Services and loading:

- [stock-analysis.ts](https://github.com/koala73/worldmonitor/blob/main/src/services/stock-analysis.ts)
- [stock-analysis-history.ts](https://github.com/koala73/worldmonitor/blob/main/src/services/stock-analysis-history.ts)
- [stock-backtest.ts](https://github.com/koala73/worldmonitor/blob/main/src/services/stock-backtest.ts)
- [daily-market-brief.ts](https://github.com/koala73/worldmonitor/blob/main/src/services/daily-market-brief.ts)
- [data-loader.ts](https://github.com/koala73/worldmonitor/blob/main/src/app/data-loader.ts)

---

## Stock Analysis

The premium stock-analysis engine is a TypeScript port of the reusable core logic from the source repo, adapted to World Monitor conventions.

It computes:

- moving-average stack and trend state
- bias versus short and medium moving averages
- volume pattern scoring
- MACD state
- RSI state
- bullish and risk factors
- composite signal and signal score
- AI overlay using the shared LLM chain when configured

Each stored analysis record includes stable replay fields so the record can be reused later:

- `analysisId`
- `analysisAt`
- `signal`
- `currentPrice`
- `stopLoss`
- `takeProfit`
- `engineVersion`

Those fields matter because backtesting now validates stored analysis records rather than re-deriving a different strategy view later.

---

## Shared Store

World Monitor still lacks a general-purpose relational backend, so premium finance currently uses Redis as the backend-owned source of truth.

### What Redis Stores

- latest shared stock-analysis snapshots
- per-symbol analysis history index
- historical analysis ledger used by backtesting
- stored backtest summary snapshots

### Why This Is Different From The Earlier App-Layer Version

Earlier iterations stored history locally per device and recomputed backtests on demand. The hardened version promotes those artifacts into the backend layer so:

- multiple users can share the same analysis results
- multiple users can share the same backtest summaries
- browser or desktop cache is no longer the canonical history

### Current Storage Model

Redis is used as:

- shared product memory
- cache-backed persistence
- the current source of truth for premium finance artifacts

It is **not** a relational finance ledger yet. Long-lived querying, rich pagination, and full auditability would still be better served by a future database layer.

---

## Backtesting

Backtesting in World Monitor is intentionally tied to stored analysis records, not just a raw signal replay.

Current flow:

1. Build or refresh a historical stored analysis ledger from Yahoo daily bars.
2. Persist those records with stable IDs and timestamps.
3. Evaluate forward performance from each stored record's saved signal and target levels.
4. Store the resulting backtest summary in Redis for shared reuse.

This makes the feature closer to "validate prior premium analyses" than "rerun whatever the latest strategy code happens to do."

---

## Daily Market Brief

The daily market brief is a premium finance panel layered on top of the project's existing market and news infrastructure.

It:

- builds once per local day
- uses the tracked watchlist and available market/news context
- caches the brief
- avoids unnecessary regeneration before the next local morning schedule

This is a World Monitor adaptation, not a port of the source repo's full scheduler/automation system.

---

## Premium Access Control

Premium finance endpoints are enforced server-side.

Premium RPC paths are gated in:

- [gateway.ts](https://github.com/koala73/worldmonitor/blob/main/server/gateway.ts)
- [api/_api-key.js](https://github.com/koala73/worldmonitor/blob/main/api/_api-key.js)

This matters because a UI-only lock would still allow direct API usage from trusted browser origins.

---

## Data Sources

Core premium finance currently depends on:

- Yahoo Finance chart/history endpoints
- Finnhub for broader market data already used elsewhere in World Monitor
- Google News RSS as the baseline stock-news fallback
- the shared LLM provider chain in [llm.ts](https://github.com/koala73/worldmonitor/blob/main/server/_shared/llm.ts)

The provider-backed targeted stock-news layer is documented separately in [PREMIUM_FINANCE_SEARCH.md](/PREMIUM_FINANCE_SEARCH).

---

## Caching And Freshness

There are three distinct cache or persistence behaviors in play:

- Redis shared storage for premium analysis history and backtests
- Redis response caching for expensive server recomputation
- client-side cache only as a rendering/performance layer

The data loader refreshes stale symbols individually rather than recomputing the whole watchlist when only one symbol is missing or stale.

---

## Separation Of Layers

### Core Premium Finance

The core layer is:

- analysis engine
- stored history
- stored backtests
- premium auth
- premium UI panels
- daily brief

### Extra Layer: Targeted Search Enrichment

The search-backed stock-news layer is intentionally separate because it improves analysis quality but is not required for the feature to function. If all search providers are unavailable, premium stock analysis still works using Google News RSS fallback.

See [PREMIUM_FINANCE_SEARCH.md](/PREMIUM_FINANCE_SEARCH).

---

## Current Boundaries

This feature is valid and production-usable within World Monitor's current architecture, but some boundaries remain explicit:

- Redis is the canonical store for now
- there is no standalone finance database
- there is no agent/chat or notifications integration yet
- the source repo's broader provider stack was not fully ported
- China-focused market data/search layers were intentionally excluded

That tradeoff keeps the feature aligned with World Monitor rather than contaminating the repo with a second backend architecture.
