# Fear & Greed Index 2.0 — Design Brief

## Goal

Build a composite market sentiment gauge (0–100) combining **10 weighted categories** into a single score. Unlike CNN's Fear & Greed Index (~7 inputs, widely criticized for lagging and oversimplifying), this uses 10 granular categories with more inputs per category to produce a nuanced, institutional-quality reading.

---

## Composite Score

```
Final Score = Σ (Category_Score × Category_Weight)
```

Each category scores **0–100** (0 = Extreme Fear, 100 = Extreme Greed). The weighted sum produces the composite index.

### 10 Categories

| # | Category        | Weight | What It Measures |
|---|----------------|--------|------------------|
| 1 | **Sentiment**   | 10%    | CNN F&G, AAII Bull/Bear surveys, crypto sentiment |
| 2 | **Volatility**  | 10%    | VIX level, VIX term structure (contango/backwardation) |
| 3 | **Positioning** | 15%    | Put/Call ratios, options skew (CBOE SKEW) |
| 4 | **Trend**       | 10%    | SPX vs 20d/50d/200d MAs, price momentum |
| 5 | **Breadth**     | 10%    | % stocks > 200 DMA, advance/decline ratio, equal-weight divergence |
| 6 | **Momentum**    | 10%    | Sector RSI spread, rate of change |
| 7 | **Liquidity**   | 15%    | M2 growth, Fed balance sheet, SOFR rate |
| 8 | **Credit**      | 10%    | HY spreads, IG spreads, credit ETF trends |
| 9 | **Macro**       | 5%     | Fed rate, yield curve, unemployment |
| 10| **Cross-Asset** | 5%     | Gold/USD correlation, bonds vs equities |

### Score Labels

| Range | Label |
|-------|-------|
| 0–20  | Extreme Fear |
| 20–40 | Fear |
| 40–60 | Neutral |
| 60–80 | Greed |
| 80–100| Extreme Greed |

### Header Metrics (9 key stats)

| Metric | Source | Context |
|--------|--------|---------|
| CNN F&G | CNN dataviz API | 0–100 score + label |
| AAII Bear % | AAII survey | vs historical average |
| AAII Bull % | AAII survey | vs historical average |
| Put/Call Ratio | CBOE CDN CSV | vs 1yr average |
| VIX | Yahoo / FRED | % change |
| HY Spread | FRED | vs long-term average |
| % > 200 DMA | Yahoo `^MMTH` | vs recent peak |
| 10Y Yield | FRED | level |
| Fed Rate | FRED | current range |

---

## Data Sources

All sources are free with no paid API keys required.

### Already Available (read from Redis)

| Data Point | FRED Series | Used In |
|-----------|------------|---------|
| VIX | VIXCLS | Volatility |
| HY Spread (OAS) | BAMLH0A0HYM2 | Credit |
| 10Y Yield | DGS10 | Macro |
| Fed Funds Rate | FEDFUNDS | Macro |
| 10Y-2Y Spread | T10Y2Y | Macro |
| M2 Money Supply | M2SL | Liquidity |
| Fed Balance Sheet | WALCL | Liquidity |
| Unemployment | UNRATE | Macro |
| Crypto Fear & Greed | Alternative.me (macro-signals) | Sentiment |

### New FRED Series (add to `seed-economy.mjs`)

| Series | Name | Category |
|--------|------|----------|
| `BAMLC0A0CM` | ICE BofA US IG OAS | Credit |
| `SOFR` | Secured Overnight Financing Rate | Liquidity |

### New External Sources

| Source | Endpoint | Format | Auth | Reliability |
|--------|----------|--------|------|-------------|
| **CNN Fear & Greed** | `production.dataviz.cnn.io/index/fearandgreed/graphdata/{date}` | JSON | User-Agent header | MEDIUM |
| **AAII Sentiment** | `aaii.com/sentimentsurvey` (HTML scrape) | HTML | User-Agent header | LOW (blocks bots) |
| **CBOE Total P/C** | `cdn.cboe.com/.../totalpc.csv` | CSV | None | HIGH |
| **CBOE Equity P/C** | `cdn.cboe.com/.../equitypc.csv` | CSV | None | HIGH |

### Yahoo Finance Symbols (19 total)

Uses `query1.finance.yahoo.com/v8/finance/chart` — no API key, User-Agent header only.

| # | Symbol | Category | Purpose |
|---|--------|----------|---------|
| 1 | `^GSPC` | Trend, Momentum | SPX — compute 20/50/200 DMA, ROC |
| 2 | `^VIX` | Volatility | Real-time VIX |
| 3 | `^VIX9D` | Volatility | 9-day VIX for term structure |
| 4 | `^VIX3M` | Volatility | 3-month VIX for term structure |
| 5 | `^SKEW` | Positioning | CBOE SKEW index |
| 6 | `^MMTH` | Breadth | % of stocks above 200 DMA |
| 7 | `^NYA` | Breadth | NYSE Composite for breadth divergence |
| 8 | `C:ISSU` | Breadth | NYSE advances/declines/unchanged |
| 9 | `GLD` | Cross-Asset | Gold proxy |
| 10 | `TLT` | Cross-Asset | Bonds proxy |
| 11 | `SPY` | Cross-Asset, Breadth | Equity benchmark |
| 12 | `RSP` | Breadth | Equal-weight S&P 500 (vs SPY divergence) |
| 13 | `DX-Y.NYB` | Cross-Asset | USD Dollar Index |
| 14 | `HYG` | Credit | HY bond ETF trend |
| 15 | `LQD` | Credit | IG bond ETF trend |
| 16 | `XLK` | Momentum | Tech sector |
| 17 | `XLF` | Momentum | Financial sector |
| 18 | `XLE` | Momentum | Energy sector |
| 19 | `XLV` | Momentum | Healthcare sector |

**Notes:**

- `^MMTH` = % above **200-day** MA (not `^MMTW` which is 20-day)
- `C:ISSU` = NYSE advance/decline/unchanged data. **Unvalidated via `/v8/finance/chart` endpoint** — must confirm it returns advance/decline figures before relying on it. If unavailable, Breadth drops `ad_score` and reweights: `breadth_score * 0.57 + rsp_score * 0.43`
- Fallback: Finnhub candle API for ETF symbols; breadth symbols Yahoo-only

---

## Scoring Formulas

### 1. Sentiment (10%)

```
inputs: CNN_FG, AAII_Bull, AAII_Bear  (AAII is LOW reliability — blocks bots)

// Normal path (AAII available):
score = (CNN_FG * 0.4) + (AAII_Bull_Percentile * 0.3) + ((100 - AAII_Bear_Percentile) * 0.3)

// Degraded path (AAII unavailable — store aaiBull/aaiBear as null, not 0):
score = CNN_FG  // 100% weight on CNN F&G; crypto F&G from Redis as secondary signal if CNN also fails
// aaiBull and aaiBear fields: null (not 0 — zero skews score toward Extreme Fear)
```

**Reliability notes:** CNN F&G is MEDIUM reliability. If both CNN and AAII fail, use `cryptoFearGreed` from Redis (already seeded via macro-signals) as a proxy — it is directionally correlated. Mark `unavailable: true` only if all three sentiment sources are absent.

### 2. Volatility (10%)

```
inputs: VIX, VIX_Term_Structure
vix_score = clamp(100 - ((VIX - 12) / 28) * 100, 0, 100)  // VIX 12=100, VIX 40=0
term_score = contango ? 70 : backwardation ? 30 : 50
score = vix_score * 0.7 + term_score * 0.3
```

### 3. Positioning (15%)

```
inputs: Put_Call_Ratio, Options_Skew
pc_score = clamp(100 - ((PC_Ratio - 0.7) / 0.6) * 100, 0, 100)  // 0.7=greed, 1.3=fear
skew_score = clamp(100 - ((SKEW - 100) / 50) * 100, 0, 100)
score = pc_score * 0.6 + skew_score * 0.4
```

### 4. Trend (10%)

```
inputs: SPX_Price, SMA20, SMA50, SMA200
above_count = count(price > SMA20, price > SMA50, price > SMA200)
distance_200 = (price - SMA200) / SMA200
score = (above_count / 3) * 50 + clamp(distance_200 * 500 + 50, 0, 100) * 0.5
```

### 5. Breadth (10%)

```
inputs: Pct_Above_200DMA, Advance_Decline, RSP_SPY_Divergence
breadth_score = Pct_Above_200DMA  // already 0-100
ad_score = clamp((AD_Ratio - 0.5) / 1.5 * 100, 0, 100)
rsp_score = clamp(RSP_SPY_30d_diff * 10 + 50, 0, 100)
score = breadth_score * 0.4 + ad_score * 0.3 + rsp_score * 0.3
```

### 6. Momentum (10%)

```
inputs: Sector_RSI_Spread, SPX_ROC_20d
rsi_score = clamp((avg_sector_rsi - 30) / 40 * 100, 0, 100)
roc_score = clamp(SPX_ROC_20d * 10 + 50, 0, 100)
score = rsi_score * 0.5 + roc_score * 0.5
```

### 7. Liquidity (15%)

```
inputs: M2_YoY_Change, Fed_Balance_Sheet_Change, SOFR_Rate
m2_score = clamp(M2_YoY * 10 + 50, 0, 100)
fed_score = clamp(Fed_BS_MoM * 20 + 50, 0, 100)
sofr_score = clamp(100 - SOFR * 15, 0, 100)
score = m2_score * 0.4 + fed_score * 0.3 + sofr_score * 0.3
```

### 8. Credit (10%)

```
inputs: HY_Spread, IG_Spread, HY_Spread_Change_30d
hy_score = clamp(100 - ((HY_Spread - 3.0) / 5.0) * 100, 0, 100)
ig_score = clamp(100 - ((IG_Spread - 0.8) / 2.0) * 100, 0, 100)
trend_score = HY_narrowing ? 70 : HY_widening ? 30 : 50
score = hy_score * 0.4 + ig_score * 0.3 + trend_score * 0.3
```

### 9. Macro (5%)

```
inputs: Fed_Rate, Yield_Curve_10Y2Y, Unemployment_Trend
rate_score = clamp(100 - Fed_Rate * 15, 0, 100)
curve_score = T10Y2Y > 0 ? 60 + T10Y2Y * 20 : 40 + T10Y2Y * 40
unemp_score = clamp(100 - (UNRATE - 3.5) * 20, 0, 100)
score = rate_score * 0.3 + curve_score * 0.4 + unemp_score * 0.3
```

### 10. Cross-Asset (5%)

```
inputs: Gold_vs_SPY_30d, TLT_vs_SPY_30d, DXY_30d_Change
gold_signal = Gold_30d > SPY_30d ? fear : greed
bond_signal = TLT_30d > SPY_30d ? fear : greed
dxy_signal = DXY_rising ? slight_fear : slight_greed
score = weighted combination with mean reversion
```

### Computed Metrics (derived from fetched data, no extra API calls)

| Metric | Inputs | Formula | Category |
|--------|--------|---------|----------|
| SPX 20/50/200 DMA | ^GSPC closes | `smaCalc(prices, period)` | Trend |
| SPX ROC 20d | ^GSPC closes | `rateOfChange(prices, 20)` | Momentum |
| VIX Term Structure | ^VIX, ^VIX9D, ^VIX3M | `VIX/VIX3M` ratio (&lt;1 = contango) | Volatility |
| Sector RSI (14d) | XLK/XLF/XLE/XLV | Standard RSI formula | Momentum |
| Cross-asset 30d returns | GLD, TLT, SPY, DXY | `rateOfChange(prices, 30)` | Cross-Asset |
| M2 YoY change | M2SL | `(latest - 12mo_ago) / 12mo_ago` | Liquidity |
| Fed BS MoM change | WALCL | `(latest - 4wk_ago) / 4wk_ago` | Liquidity |
| HY spread trend | BAMLH0A0HYM2 | `30d change direction` | Credit |
| RSP/SPY ratio | RSP, SPY | `RSP_return_30d - SPY_return_30d` | Breadth |

---

## Seed Script: `seed-fear-greed.mjs`

Follows the existing pattern: Railway cron → fetch external APIs → compute scores → atomic publish to Redis → server handler reads from Redis.

### Redis Keys

```
market:fear-greed:v1              # Composite index + all category scores
market:fear-greed:history:v1      # Sorted set — daily snapshots for sparklines (score UNIX score, member ISO date string)
seed-meta:market:fear-greed       # Metadata (fetchedAt, recordCount, sourceVersion)
seed-lock:market:fear-greed       # Concurrency lock
```

**TTL**: 64800s (18h) — 3× the 6h cron interval. Required to survive 2 missed cron cycles (Railway downtime, deploy gaps). `runSeed()` extends this same TTL on both fetch-failure and empty-data paths.
**Cron**: `0 0,6,12,18 * * *` (every 6h)
**health.js `maxStaleMin`**: 720 (12h) — 2× interval. One missed cycle never fires a spurious WARN; the 20min self-heal from `runSeed()` retry covers transient failures.

**`composite.previous` requires a pre-write Redis GET.** Before calling `runSeed()`, read `market:fear-greed:v1` from Redis, extract `composite.score`, pass it into `publishTransform` as `previous`. `runSeed()` then overwrites the key atomically. Do NOT compute `previous` after the write — the key is already overwritten.

### API Call Budget

| Source | Calls | Rate Limited? | Auth |
|--------|-------|--------------|------|
| Yahoo Finance | 19 symbols | 150ms gaps | User-Agent only |
| CBOE CDN | 2 CSVs | No | None |
| CNN dataviz | 1 | No | User-Agent only |
| AAII | 1 | Blocks bots | User-Agent + scrape |
| Redis reads | ~10 FRED series | No | Bearer token |
| **Total** | **~33** | — | — |

**Estimated runtime**: ~3s (Yahoo sequential) + ~2s (CBOE/CNN/AAII parallel) + ~1s (Redis) = **~6s per run**

**Timeouts**: Set `AbortSignal.timeout(8000)` on AAII scrape (frequently stalls). AAII failure must not block the entire seed run — wrap in `try/catch`, log warn, continue with degraded Sentiment scoring.

### Output Schema (stored in Redis)

```json
{
  "timestamp": "2026-03-24T12:00:00Z",
  "composite": {
    "score": 38.7,
    "label": "Fear",
    "previous": 41.2
  },
  "categories": {
    "sentiment": { "score": 19, "weight": 0.10, "contribution": 1.9, "inputs": { "cnnFearGreed": 16, "cnnLabel": "Extreme Fear", "aaiBull": 30.4, "aaiBear": 52.0 }, "degraded": false },
    // degraded: true when AAII unavailable; aaiBull/aaiBear: null (not 0) when AAII fetch fails
    "volatility": { "score": 47, "weight": 0.10, "contribution": 4.7, "inputs": { "vix": 26.78, "vixChange": 11.31, "vix9d": 28.1, "vix3m": 24.5, "termStructure": "backwardation" } },
    "positioning": { "score": 34, "weight": 0.15, "contribution": 5.1, "inputs": { "putCallRatio": 1.01, "putCallAvg": 0.87, "skew": 135 } },
    "trend": { "score": 52, "weight": 0.10, "contribution": 5.2, "inputs": { "spxPrice": 5667, "sma20": 5580, "sma50": 5520, "sma200": 5200, "aboveMaCount": 3 } },
    "breadth": { "score": 40, "weight": 0.10, "contribution": 4.0, "inputs": { "pctAbove200d": 43.93, "rspSpyRatio": -2.1, "advDecRatio": 0.85 } },
    "momentum": { "score": 13, "weight": 0.10, "contribution": 1.3, "inputs": { "spxRoc20d": -3.2, "sectorRsiAvg": 38, "leadersVsLaggards": -12.5 } },
    "liquidity": { "score": 26, "weight": 0.15, "contribution": 3.9, "inputs": { "m2Yoy": 1.2, "fedBsMom": -0.8, "sofr": 5.31 } },
    "credit": { "score": 68, "weight": 0.10, "contribution": 6.8, "inputs": { "hySpread": 3.27, "igSpread": 1.15, "hyTrend30d": "narrowing" } },
    "macro": { "score": 44, "weight": 0.05, "contribution": 2.2, "inputs": { "fedRate": 3.625, "t10y2y": 0.15, "unrate": 4.1 } },
    "crossAsset": { "score": 72, "weight": 0.05, "contribution": 3.6, "inputs": { "goldReturn30d": 4.2, "tltReturn30d": 1.8, "spyReturn30d": -2.1, "dxyChange30d": -1.5 } }
  },
  "headerMetrics": {
    "cnnFearGreed": { "value": 16, "label": "Extreme Fear" },
    "aaiBear": { "value": 52, "context": "6-wk high" },
    "aaiBull": { "value": 30.4, "context": "Below avg" },
    "putCall": { "value": 1.01, "context": "vs 0.87 yr avg" },
    "vix": { "value": 26.78, "context": "+11.31%" },
    "hySpread": { "value": 3.27, "context": "vs LT avg" },
    "pctAbove200d": { "value": 43.93, "context": "Down from 68.5%" },
    "yield10y": { "value": 4.25 },
    "fedRate": { "value": "3.50-3.75%" }
  },
  "unavailable": false
}
```

---

## Implementation Plan

### Phase 1: Data Layer

1. Add `BAMLC0A0CM` and `SOFR` to `seed-economy.mjs` FRED_SERIES array
   - Note: SOFR is weekly cadence from FRED, not daily — Liquidity formula is stable between releases
2. Validate `C:ISSU` symbol returns advance/decline data via Yahoo `/v8/finance/chart` — confirm before building Breadth formula around it
3. Create `seed-fear-greed.mjs`:
   - TTL: **64800s** (18h = 3× interval)
   - AAII fetch: `AbortSignal.timeout(8000)`, wrapped in `try/catch` — failure uses degraded Sentiment scoring
   - Pre-write step: GET `market:fear-greed:v1` from Redis, extract `composite.score` as `previous`, pass via `publishTransform`
   - `runSeed()` calls `process.exit(0)` — all extra key writes (e.g. history key) must use the `extraKeys` option, NOT code after the `runSeed()` call
4. Register with **bootstrap 4-file checklist**:
   - `cache-keys.ts` — add `market:fear-greed:v1`
   - `api/bootstrap.js` — register the key
   - `health.js` — classify as `BOOTSTRAP_KEYS` (seeded, CRIT if empty); set `maxStaleMin: 720` (12h = 2× interval)
   - `gateway.ts` — wire `GetFearGreedIndex` RPC

### Phase 2: Proto + RPC

5. New proto: `proto/worldmonitor/market/v1/fear_greed.proto`
   - `GetFearGreedIndex` RPC
   - Messages for composite score, category scores, and header metrics
6. New handler: `server/worldmonitor/market/v1/get-fear-greed-index.ts`
   - Reads computed data from Redis, returns structured response

### Phase 3: Frontend Panel

7. New component: `src/components/FearGreedPanel.ts`
   - Gauge — semicircular 0–100 dial with color gradient (red→yellow→green)
   - Header grid — 9 key metrics with contextual annotations
   - Category breakdown — expandable cards per category (score, weight, contribution, bar)
   - Handle `degraded: true` on Sentiment card (show "AAII unavailable" note)
8. Register in finance variant panel config

### Phase 4: Polish

9. Historical sparklines — append daily snapshot to `market:fear-greed:history:v1` (sorted set, score = UNIX timestamp, member = ISO date + composite score JSON). Write via `extraKeys` in Phase 1 seeder. TTL: 90 days (7776000s). Frontend reads this key for trend sparkline.
10. Alerts on threshold crossings (e.g. score drops below 20)

---

## MVP Path

Build the initial version using only data we already have + easy additions:

1. **Volatility** — VIX from FRED
2. **Credit** — HY + IG spread from FRED
3. **Macro** — Fed rate + yield curve + unemployment from FRED
4. **Trend** — SPX price vs computed MAs from Yahoo
5. **Liquidity** — M2 + Fed balance sheet from FRED + SOFR
6. **Sentiment** — CNN F&G endpoint + crypto F&G (already have)
7. **Momentum** — Sector ETF returns from Yahoo
8. **Cross-Asset** — GLD/TLT/SPY/DXY returns from Yahoo
9. **Positioning** — CBOE put/call CSVs + SKEW from Yahoo
10. **Breadth** — ^MMTH + RSP/SPY divergence + C:ISSU from Yahoo

All 10 categories covered from day one. No paid sources needed.
