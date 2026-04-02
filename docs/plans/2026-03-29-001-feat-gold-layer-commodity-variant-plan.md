---
title: Gold Layer Enhancements for Commodity Variant
type: feat
status: active
date: 2026-03-29
---

# feat: Gold Layer Enhancements for Commodity Variant

## Overview

Enhance WorldMonitor's commodity variant with learnings from the `Yazan-Abuawwad/gold-monitor` fork. The fork was a fully independent Angular+Spring Boot app (not based on our codebase), but its gold layer design surfaces four concrete gaps in our current commodity variant:

1. **10 major gold mines missing** from our `MINING_SITES` geo data
2. **2 direct gold RSS feeds missing** from the `gold-silver` panel
3. **Commodity brief is titled "WORLD BRIEF"** — no variant-aware title or context
4. **No XAU multi-currency widget** — gold priced in USD only; no cross-currency view

Importantly, much of what the fork built **already exists** in our stack:

- `GC=F` gold futures seeded every 5 min via `seedCommodityQuotes()` in `ais-relay.cjs`
- `gold-silver` news panel with Kitco, GoldSeek, SilverSeek, WGC, Google News
- `MINING_SITES` layer in `commodity-geo.ts` already has `operator` + `annualOutput` fields and gold mine records (Nevada Gold Mines, Lihir, Pueblo Viejo, Cortez, Peñasquito)
- Gold majors + royalty streamers already in `COMMODITY_MARKET_SYMBOLS` (NEM, GOLD, AEM, WPM, RGLD, FNV)

This plan is additive enrichment, not new infrastructure.

---

## Problem Statement / Motivation

The commodity variant (`commodity.worldmonitor.app`) serves users focused on gold, metals, and energy markets. Compared to the fork's gold layer design, three user-facing gaps exist:

- **Map incompleteness**: Major producing mines (Muruntau, Kibali, Yanacocha, Ahafo, South Deep, etc.) are absent from the mining layer. A user clicking into gold production misses ~40% of the top 20 global mines.
- **Brief irrelevance**: The AI brief on the commodity variant reads news from `['markets', 'economic', 'crypto', 'finance']` — all of which are finance-variant categories. Commodity users get a stock market brief, not a gold/commodities brief.
- **No gold pricing breadth**: Gold is only shown in USD (`GC=F`). Professional users track XAU/EUR, XAU/CNY (yuan debasement hedge), XAU/TRY (emerging market inflation). No cross-currency view exists.

---

## Proposed Solution

Four phases, ordered by effort and risk:

1. **Mine data enrichment** — add 10 missing gold mines to `commodity-geo.ts`
2. **Feed enrichment** — add Gold Silver Worlds + FX Empire Gold to `feeds.ts` `gold-silver` block + add `XAUUSD=X` spot to `commodities.json`
3. **Commodity AI brief** — fix InsightsPanel title + feed categories for commodity variant
4. **XAU multi-currency widget** — new sub-component in `CommoditiesPanel` showing XAU in 10 currencies

---

## Technical Approach

### Architecture

All changes are additive. No new Redis keys, no new seeder scripts, no new API routes, no new bootstrap registrations for Phases 1-3. Phase 4 requires FX symbols added to `shared/commodities.json` (auto-seeded by existing `seedCommodityQuotes()`).

**Gold Standard compliance**: The commodity quote seeder already runs on 5-min interval with 2h TTL. Any FX symbols added to `shared/commodities.json` are automatically picked up by `loadSharedConfig('commodities.json')` in both `ais-relay.cjs` and `scripts/seed-commodity-quotes.mjs` — no seeder code changes needed.

### Implementation Phases

#### Phase 1: Mine Data Enrichment

**File**: `src/config/commodity-geo.ts`

Add these 10 mines to `MINING_SITES[]`, following the existing pattern. All are `mineral: 'gold'`, `status: 'producing'` unless noted:

| Mine | Country | Operator | Lat/Lng | Annual Output |
|------|---------|----------|---------|---------------|
| Muruntau | Uzbekistan | Navoi Mining & Metallurgy | 41.56, 64.58 | ~2.8 Moz/yr |
| Kibali | DRC | Barrick Gold / AngloGold JV | 3.07, 29.76 | ~800 Koz/yr |
| Sukhoi Log | Russia | Polyus (development) | 58.29, 115.22 | ~2.3 Moz/yr (projected) — `status: 'development'` |
| Ahafo | Ghana | Newmont | 7.06, -2.34 | ~800 Koz/yr |
| Loulo-Gounkoto | Mali | Barrick Gold | 14.85, -11.41 | ~700 Koz/yr |
| South Deep | South Africa | Gold Fields | -26.52, 27.54 | ~300 Koz/yr |
| Kumtor | Kyrgyzstan | Centerra Gold | 41.81, 78.19 | ~500 Koz/yr |
| Yanacocha | Peru | Newmont / Buenaventura | -6.94, -78.56 | ~400 Koz/yr |
| Cerro Negro | Argentina | Newmont | -46.75, -67.50 | ~300 Koz/yr |
| Tropicana | Australia | AngloGold Ashanti / Regis | -29.30, 124.80 | ~500 Koz/yr |

These mirror the exact mines in the fork's hardcoded `GOLD_MINES[]` array that were absent from our data.

**No type changes needed**: `MineSite` already has `operator: string`, `annualOutput?: string`, and `mineral: MineralType` includes `'gold'`.

**Acceptance criteria for Phase 1:**

- [ ] All 10 mines render as golden `◆` markers on the commodity map mining layer
- [ ] Each mine popup shows `operator` and `annualOutput`
- [ ] TypeScript compiles cleanly (no new types needed)
- [ ] Muruntau + Sukhoi Log are visually present in Central Asia region (currently a blank spot)

---

#### Phase 2: Feed + Symbol Enrichment

**File 2a**: `src/config/feeds.ts` — `gold-silver` block (line ~1107)

Append two direct feeds that the fork had and we don't:
```ts
{ name: 'Gold Silver Worlds', url: rss('https://goldsilverworlds.com/feed/') },
{ name: 'FX Empire Gold', url: rss('https://www.fxempire.com/api/v1/en/markets/commodity/Gold/news/feed') },
```

Both are direct XML feeds (no Google News proxy), giving us higher-quality gold-specific content alongside the existing Kitco + GoldSeek feeds.

**File 2b**: `shared/commodities.json`

Add `XAUUSD=X` (London spot gold, Yahoo Finance):
```json
{ "symbol": "XAUUSD=X", "name": "Gold Spot", "display": "XAU SPOT" }
```

This is auto-picked up by `ais-relay.cjs` `COMMODITY_SYMBOLS` + `YAHOO_ONLY` set check (it ends in `=X`, similar treatment to `=F` futures). Verify: confirm `YAHOO_ONLY_SYMBOLS` in `server/worldmonitor/market/v1/_shared.ts` includes `XAUUSD=X` or add it.

Value: frontend can now show futures vs spot basis spread in `CommoditiesPanel` (contango/backwardation signal for gold market sentiment).

**Acceptance criteria for Phase 2:**

- [ ] `gold-silver` panel shows articles from Gold Silver Worlds + FX Empire Gold
- [ ] `XAUUSD=X` appears in commodity bootstrap data
- [ ] `XAUUSD=X` in `YAHOO_ONLY_SYMBOLS` in both `_shared.ts` and `ais-relay.cjs`
- [ ] TypeScript compiles; `npm run test:data` passes (no new bootstrap key — `XAUUSD=X` goes through existing `market:commodities-bootstrap:v1`)

---

#### Phase 3: Commodity AI Brief

**File 3a**: `src/components/InsightsPanel.ts` — line 553

Current:
```ts
${SITE_VARIANT === 'tech' ? '🚀 TECH BRIEF' : '🌍 WORLD BRIEF'}
```

Update:
```ts
${SITE_VARIANT === 'tech' ? '🚀 TECH BRIEF' : SITE_VARIANT === 'commodity' ? '⛏️ COMMODITY BRIEF' : '🌍 WORLD BRIEF'}
```

**File 3b**: `src/services/daily-market-brief.ts` — `BRIEF_NEWS_CATEGORIES` (line 97)

Make variant-aware:
```ts
const BRIEF_NEWS_CATEGORIES = SITE_VARIANT === 'commodity'
  ? ['commodity-news', 'gold-silver', 'mining-news', 'energy', 'critical-minerals']
  : ['markets', 'economic', 'crypto', 'finance'];
```

This routes the headline pool for AI summarization to the commodity feed categories (which are already populated in `newsByCategory` context) instead of finance-variant categories.

**File 3c**: `src/components/InsightsPanel.ts` — `geoContext` block (~line 398-401)

Add commodity context injection alongside the existing `full` variant theater context:
```ts
let geoContext = SITE_VARIANT === 'full'
  ? (focalSummary.aiContext || signalSummary.aiContext) + theaterContext
  : SITE_VARIANT === 'commodity'
    ? buildCommodityContext(options)  // new helper
    : '';
```

New helper `buildCommodityContext(options)` (in `daily-market-brief.ts`):

- Extract `GC=F` quote from commodity data → format as "Gold: $X,XXX (+1.2% today)"
- List top 3 commodity supply disruption headlines from `commodity-news` category
- Note active mining region risks from `gold-silver` / `mining-news` feed

This gives the LLM commodity-specific framing ("you are analyzing gold and commodities markets") instead of generic geopolitical framing.

**Acceptance criteria for Phase 3:**

- [ ] Commodity variant InsightsPanel header shows "⛏️ COMMODITY BRIEF" not "🌍 WORLD BRIEF"
- [ ] AI brief text references gold/commodities context, not generic geopolitical events
- [ ] Brief generates without errors when commodity news categories are present
- [ ] Tech variant brief unchanged

---

#### Phase 4: XAU Multi-Currency Widget

**New file**: `src/components/GoldCurrencyWidget.ts`

A sub-component (not a full Panel) embedded in `CommoditiesPanel` when `SITE_VARIANT === 'commodity'`.

Shows XAU (gold) priced in 10 currencies with live calculation:
| Currency | Symbol to add to `commodities.json` |
|----------|--------------------------------------|
| USD | — (use `GC=F` directly) |
| EUR | `EURUSD=X` |
| GBP | `GBPUSD=X` |
| JPY | `JPYUSD=X` |
| CNY | `CNYUSD=X` |
| INR | `INRUSD=X` |
| AUD | `AUDUSD=X` |
| CHF | `CHFUSD=X` |
| CAD | `CADUSD=X` |
| TRY | `TRYUSD=X` |

**Seeder impact**: Adding 9 FX pairs to `shared/commodities.json` adds 9 Yahoo calls per 5-min cycle. Current load is ~23 symbols → ~27ms total with 150ms gaps. Adding 9 more brings total to 32 symbols, adding ~1.35s per cycle. Within acceptable bounds per `yahooGate()` rate limiter. All `=X` forex symbols are Yahoo-only — add to `YAHOO_ONLY_SYMBOLS` in `_shared.ts` and `ais-relay.cjs`.

**Widget rendering**:

- Each row: flag emoji | currency code | XAU price (calculated as `gcFPrice / fxRateToUSD`) | 24h % change | 10-char sparkline
- Data source: read from commodity bootstrap `market:commodities-bootstrap:v1` which will now include both `GC=F` and the FX pairs
- Computation: `xauInCurrency = gcF.regularMarketPrice / fxPair.regularMarketPrice`
- Embedded as a collapsible section in `CommoditiesPanel` below the main metals grid

**Integration point**: `src/components/CommoditiesPanel.ts` — add `if (SITE_VARIANT === 'commodity') this.renderGoldCurrencyWidget()` in the panel's content update method.

**Acceptance criteria for Phase 4:**

- [ ] Widget shows in CommoditiesPanel for commodity variant only
- [ ] XAU/EUR, XAU/JPY, XAU/CNY etc. all populated with live prices
- [ ] 9 FX symbols seeded and present in `market:commodities-bootstrap:v1`
- [ ] All FX symbols in `YAHOO_ONLY_SYMBOLS` (both files)
- [ ] 4-file bootstrap check: `cache-keys.ts` / `bootstrap.js` / `health.js` / `gateway.ts` — no changes needed since these symbols route through the existing `commodityQuotes` bootstrap key
- [ ] `npm run test:data` passes

---

## System-Wide Impact

- **Seeder load (Phase 4)**: +9 Yahoo Finance symbols per 5-min cycle. Total commodity symbols: 32. Still within safe threshold per memory note on Yahoo 429 risk (limit ~49 calls/5min). No `Promise.all` — sequential with 150ms delays per gold standard.
- **Bootstrap key unchanged**: All new symbols (FX pairs, `XAUUSD=X`) go through the existing `market:commodities-bootstrap:v1` key. No 4-file checklist changes required.
- **Finance variant isolation**: All changes are `SITE_VARIANT === 'commodity'` guarded. The finance, tech, and full variants are unaffected.
- **Mining layer**: Adding 10 `MINING_SITES` entries increases `DeckGLMap` scatter plot point count slightly. No perf concern — `ScatterplotLayer` handles thousands of points.

---

## Acceptance Criteria

### Functional

- [ ] Commodity map shows 10 new gold mine markers (Muruntau, Kibali, Sukhoi Log, Ahafo, Loulo-Gounkoto, South Deep, Kumtor, Yanacocha, Cerro Negro, Tropicana)
- [ ] `gold-silver` panel includes Gold Silver Worlds + FX Empire Gold articles
- [ ] `XAUUSD=X` spot price appears in commodity panels alongside `GC=F` futures
- [ ] InsightsPanel shows "⛏️ COMMODITY BRIEF" on commodity variant
- [ ] AI brief pulls from commodity feed categories, not finance categories
- [ ] XAU multi-currency widget shows 10 currency pairs with live prices

### Non-Functional

- [ ] TypeScript compiles clean (`npm run typecheck` + `npm run typecheck:api`)
- [ ] `npm run test:data` passes (bootstrap key parity)
- [ ] Lint passes (`npm run lint`)
- [ ] No regression on finance/full/tech variants

### Gold Standard Seeder Compliance

- [ ] Any new `=F` or `=X` symbols added to `YAHOO_ONLY_SYMBOLS` in **both** `server/worldmonitor/market/v1/_shared.ts` and `ais-relay.cjs`
- [ ] No new seeder scripts created (symbols ride existing `seedCommodityQuotes()`)
- [ ] TTL for new symbols: inherited from existing `MARKET_SEED_TTL = 7200` (2h) — no change

---

## Dependencies & Risks

| Risk | Mitigation |
|------|-----------|
| FX Yahoo symbols (`EURUSD=X`) behave differently than futures | Test each symbol with `fetchYahooChartDirect` manually before adding; `=X` symbols are confirmed YAHOO_ONLY in existing memory |
| Sukhoi Log is `status: 'development'` — mine not yet in production | Correct in the data; tooltip should note "Under Development (est. 2.3 Moz/yr)" |
| Gold Silver Worlds / FX Empire RSS feeds may have CORS/SSL issues | `rss()` helper in `feeds.ts` wraps through Google News proxy by default; use direct URL only if it's known-stable XML |
| Phase 4 commodity brief may get stale cache from previous 'WORLD BRIEF' content | `InsightsPanel.BRIEF_CACHE_KEY` should be variant-specific, or clear on variant change. Check if it's already variant-scoped. |

---

## Success Metrics

- Gold mine coverage: 10/10 new mines visible on commodity map
- Feed diversity: `gold-silver` panel goes from 7 → 9 sources
- Brief relevance: Commodity brief prompt includes gold price context
- Currency breadth: XAU priced in 10 currencies, updated every 5 min

---

## Sources & References

### Internal References

- Commodity variant config: `src/config/variants/commodity.ts`
- Mine site geo data: `src/config/commodity-geo.ts:27` (`MineSite` interface), `line 75` (`MINING_SITES`)
- Gold feeds: `src/config/feeds.ts:1107` (`gold-silver` block)
- Commodity symbols: `shared/commodities.json`
- Seeder: `scripts/ais-relay.cjs` `seedCommodityQuotes()` ~line 1413
- Yahoo-only symbols: `server/worldmonitor/market/v1/_shared.ts` `YAHOO_ONLY_SYMBOLS`
- Brief categories: `src/services/daily-market-brief.ts:97` (`BRIEF_NEWS_CATEGORIES`)
- InsightsPanel title: `src/components/InsightsPanel.ts:553`
- Layer registry: `src/config/map-layer-definitions.ts`

### External Fork Reference

- **gold-monitor** fork (reviewed 2026-03-29): `github.com/Yazan-Abuawwad/gold-monitor` — fully independent Angular/Spring Boot app. Key learnings: 20 gold mine list (10 missing from ours), 7 gold RSS feeds (2 missing), XAU 10-currency widget pattern, gold AI brief prompt structure covering price sentiment + geopolitical supply risks + mining output.

### Seeder Gold Standard

- Memory: `feedback_seeder_gold_standard.md` — TTL ≥ 3x interval, `upstashExpire` on both failure paths, 20min retry, `inFlight` guard
- Bootstrap 4-file checklist: `worldmonitor-bootstrap-registration.md`
- Yahoo rate limit: ~49 calls/5min max; Phase 4 adds 9 symbols (safe)
