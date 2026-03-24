# Fear & Greed Index 2.0 — Reverse Engineering Brief

## Overview

A composite market sentiment gauge (0–100) combining **10 weighted categories** into a single score. The original CNN Fear & Greed Index uses ~7 inputs and is widely criticized for lagging and oversimplifying. This "2.0" version by @investingluc uses 10+ granular inputs to produce a more nuanced reading.

**Example reading**: 38.7 (Fear) — while CNN was at 16 (Extreme Fear) and SPY was only ~6% off ATH.

---

## Architecture (Reverse-Engineered from Screenshots)

### Composite Score Formula

```
Final Score = Σ (Category_Score × Category_Weight)
```

Each category scores **0–100** (0 = Extreme Fear, 100 = Extreme Greed).
The weighted sum produces the composite index.

### 10 Categories with Weights

| # | Category       | Weight | Score Example | Contribution | What It Measures |
|---|---------------|--------|---------------|-------------|------------------|
| 1 | **Sentiment**  | 10%    | 19            | 1.9         | CNN F&G, AAII Bull/Bear surveys, social sentiment |
| 2 | **Volatility** | 10%    | 47            | 4.7         | VIX level, VIX term structure (contango/backwardation) |
| 3 | **Positioning**| 15%    | 34            | 5.1         | Put/Call ratios, options skew, CFTC positioning |
| 4 | **Trend**      | 10%    | 52            | 5.2         | SPX vs 20d/50d/200d MAs, price momentum |
| 5 | **Breadth**    | 10%    | 40            | 4.0         | % stocks > 200 DMA, advance/decline ratio, new highs/lows |
| 6 | **Momentum**   | 10%    | 13            | 1.3         | Sector leaders vs laggards, RSI, rate of change |
| 7 | **Liquidity**  | 15%    | 26            | 3.9         | Bid-ask spreads, market depth, funding rates |
| 8 | **Credit**     | 10%    | 68            | 6.8         | HY spreads, IG spreads, CDS indices, credit conditions |
| 9 | **Macro**      | 5%     | 44            | 2.2         | Fed rate, yield curve, economic surprise index |
| 10| **Cross-Asset**| 5%     | 72            | 3.6         | Gold/USD correlation, bonds vs equities, commodity signals |

**Verification**: 1.9 + 4.7 + 5.1 + 5.2 + 4.0 + 1.3 + 3.9 + 6.8 + 2.2 + 3.6 = **38.7** ✓

### Key Metrics Displayed in Header

| Metric       | Value      | Context              |
|-------------|------------|----------------------|
| CNN F&G     | 16         | Extreme Fear         |
| AAII Bear   | 52%        | 6-week high          |
| AAII Bull   | 30.4%      | Below average        |
| Put/Call    | 1.01       | vs 0.87 yr avg       |
| VIX         | 26.78      | +11.31%              |
| HY Spread   | 3.27%      | vs 3,298 LT avg      |
| % > 200D    | 43.93%     | Down from 68.5%      |
| 10Y Yield   | 4.25%      | —                    |
| Fed Rate    | 3.50-3.75% | Hawkish/hold         |

### UI Components

1. **Gauge** — Semicircular 0–100 dial with color gradient (red→yellow→green)
2. **Header Grid** — 9 key metrics in 3×3 grid with contextual annotations
3. **Category Radar** — Spider/radar chart of all 10 category scores
4. **Score Distribution** — Horizontal bar chart per category (color-coded)
5. **Category Breakdown** — Expandable cards per category (score, weight, contribution, mini bar)

---

## Data Source Audit: What We Have vs What We Need

### ✅ ALREADY HAVE (in worldmonitor)

| Data Point | Source | Service | Notes |
|-----------|--------|---------|-------|
| VIX level | FRED (VIXCLS) | EconomicService | Daily, used in MacroSignals |
| HY Spread (OAS) | FRED (BAMLH0A0HYM2) | EconomicService | Daily |
| 10Y Yield | FRED (DGS10) | EconomicService | Daily |
| Fed Funds Rate | FRED (FEDFUNDS) | EconomicService | Daily |
| 10Y-2Y Spread | FRED (T10Y2Y) | EconomicService | Yield curve inversion |
| Crypto Fear & Greed | Alternative.me | MacroSignals | Daily, 0-100 |
| Stock prices (SPX, QQQ) | Yahoo Finance / Finnhub | MarketService | Real-time |
| Sector ETF performance | Yahoo Finance | MarketService | Real-time |
| ETF flows (BTC) | Yahoo Finance | MarketService | Daily |
| M2 Money Supply | FRED (M2SL) | EconomicService | Weekly |
| Fed Balance Sheet | FRED (WALCL) | EconomicService | Weekly |
| CPI | FRED (CPIAUCSL) | EconomicService | Monthly |
| Supply Chain Pressure | FRED (GSCPI) | EconomicService | Monthly |
| BIS Policy Rates | BIS API | EconomicService | Quarterly |

### ❌ MISSING — Need to Add (ALL FREE, no API keys needed)

| Data Point | Category | Free Source | Endpoint | Format | Reliability |
|-----------|----------|------------|----------|--------|-------------|
| **CNN Fear & Greed** | Sentiment | CNN dataviz API | `https://production.dataviz.cnn.io/index/fearandgreed/graphdata` | JSON | HIGH — stable for years, widely used |
| **AAII Bull/Bear** | Sentiment | AAII public page | `https://www.aaii.com/sentimentsurvey` (scrape) | HTML | MEDIUM — weekly update, scrape needed |
| **Put/Call Ratio** | Positioning | CBOE CDN | `https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv` | CSV | HIGH — daily CSV, no auth |
| **Equity Put/Call** | Positioning | CBOE CDN | `https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/equitypc.csv` | CSV | HIGH — daily CSV, no auth |
| **CBOE SKEW Index** | Positioning | Yahoo Finance | `^SKEW` via chart API | JSON | HIGH — standard Yahoo symbol |
| **VIX 9-Day** | Volatility | Yahoo Finance | `^VIX9D` via chart API | JSON | HIGH — standard Yahoo symbol |
| **VIX 3-Month** | Volatility | Yahoo Finance | `^VIX3M` via chart API | JSON | HIGH — standard Yahoo symbol |
| **IG Spread (OAS)** | Credit | FRED | `BAMLC0A0CM` series | JSON | HIGH — add to existing FRED_SERIES |
| **SOFR Rate** | Liquidity | FRED | `SOFR` series | JSON | HIGH — add to existing FRED_SERIES |
| **Sector RSI** | Momentum | Yahoo Finance | XLK/XLF/XLE/XLV/XLI/XLU (computed) | JSON | HIGH — existing Yahoo pattern |
| **Cross-Asset** | Cross-Asset | Yahoo Finance | GLD/TLT/SPY/DX-Y.NYB (computed) | JSON | HIGH — existing Yahoo pattern |
| **SPX Trend** | Trend | Yahoo Finance | `^GSPC` (compute 20/50/200 DMA) | JSON | HIGH — existing Yahoo pattern |
| **Breadth Proxy** | Breadth | Yahoo Finance | RSP vs SPY (equal-weight divergence) | JSON | HIGH — regular ETF symbol |
| **NYSE Composite** | Breadth | Yahoo Finance | `^NYA` via chart API | JSON | HIGH — standard Yahoo symbol |
| **HYG/LQD ETFs** | Credit | Yahoo Finance | HYG, LQD (credit ETF trend) | JSON | HIGH — regular ETF symbols |

**Key insight**: Perplexity Computer Use = browser-based scraping. Every source above is a public URL with no login/key required. The CBOE CSVs are the goldmine — free daily put/call data that most people don't know about.

### 🟡 PARTIALLY HAVE (Need Enhancement)

| Data Point | Category | Current State | Enhancement Needed |
|-----------|----------|--------------|-------------------|
| Trend (SPX vs MAs) | Trend | Have prices, no MA computation | Compute 20/50/200 DMA server-side |
| Sector rotation | Momentum | Have sector ETFs | Compute relative strength, RSI |
| Credit conditions | Credit | Have HY spread | Add IG spread (BAMLC0A0CM from FRED) |
| Macro signals | Macro | 7-signal composite exists | Restructure into F&G category format |

---

## Scoring Logic (Proposed)

Each category maps raw data to a **0–100 score** where:
- **0–20**: Extreme Fear
- **20–40**: Fear
- **40–60**: Neutral
- **60–80**: Greed
- **80–100**: Extreme Greed

### Category Scoring Formulas

#### 1. Sentiment (10%)
```
inputs: CNN_FG, AAII_Bull, AAII_Bear
score = (CNN_FG * 0.4) + (AAII_Bull_Percentile * 0.3) + ((100 - AAII_Bear_Percentile) * 0.3)
```

#### 2. Volatility (10%)
```
inputs: VIX, VIX_Term_Structure
vix_score = clamp(100 - ((VIX - 12) / 28) * 100, 0, 100)  // VIX 12=100, VIX 40=0
term_score = contango ? 70 : backwardation ? 30 : 50
score = vix_score * 0.7 + term_score * 0.3
```

#### 3. Positioning (15%)
```
inputs: Put_Call_Ratio, Options_Skew
pc_score = clamp(100 - ((PC_Ratio - 0.7) / 0.6) * 100, 0, 100)  // 0.7=greed, 1.3=fear
skew_score = clamp(100 - ((SKEW - 100) / 50) * 100, 0, 100)
score = pc_score * 0.6 + skew_score * 0.4
```

#### 4. Trend (10%)
```
inputs: SPX_Price, SMA20, SMA50, SMA200
above_count = count(price > SMA20, price > SMA50, price > SMA200)
distance_200 = (price - SMA200) / SMA200
score = (above_count / 3) * 50 + clamp(distance_200 * 500 + 50, 0, 100) * 0.5
```

#### 5. Breadth (10%)
```
inputs: Pct_Above_200DMA, Advance_Decline, New_Highs_Lows
breadth_score = Pct_Above_200DMA  // already 0-100
ad_score = clamp((AD_Ratio - 0.5) / 1.5 * 100, 0, 100)
hl_score = clamp(NH / (NH + NL) * 100, 0, 100)
score = breadth_score * 0.4 + ad_score * 0.3 + hl_score * 0.3
```

#### 6. Momentum (10%)
```
inputs: Sector_RSI_Spread, SPX_ROC_20d
rsi_score = clamp((avg_sector_rsi - 30) / 40 * 100, 0, 100)
roc_score = clamp(SPX_ROC_20d * 10 + 50, 0, 100)
score = rsi_score * 0.5 + roc_score * 0.5
```

#### 7. Liquidity (15%)
```
inputs: M2_YoY_Change, Fed_Balance_Sheet_Change, SOFR_Rate
m2_score = clamp(M2_YoY * 10 + 50, 0, 100)
fed_score = clamp(Fed_BS_MoM * 20 + 50, 0, 100)
sofr_score = clamp(100 - SOFR * 15, 0, 100)
score = m2_score * 0.4 + fed_score * 0.3 + sofr_score * 0.3
```

#### 8. Credit (10%)
```
inputs: HY_Spread, IG_Spread, HY_Spread_Change_30d
hy_score = clamp(100 - ((HY_Spread - 3.0) / 5.0) * 100, 0, 100)
ig_score = clamp(100 - ((IG_Spread - 0.8) / 2.0) * 100, 0, 100)
trend_score = HY_narrowing ? 70 : HY_widening ? 30 : 50
score = hy_score * 0.4 + ig_score * 0.3 + trend_score * 0.3
```

#### 9. Macro (5%)
```
inputs: Fed_Rate, Yield_Curve_10Y2Y, Unemployment_Trend
rate_score = clamp(100 - Fed_Rate * 15, 0, 100)
curve_score = T10Y2Y > 0 ? 60 + T10Y2Y * 20 : 40 + T10Y2Y * 40
unemp_score = clamp(100 - (UNRATE - 3.5) * 20, 0, 100)
score = rate_score * 0.3 + curve_score * 0.4 + unemp_score * 0.3
```

#### 10. Cross-Asset (5%)
```
inputs: Gold_vs_SPY_30d, TLT_vs_SPY_30d, DXY_30d_Change
gold_signal = Gold_30d > SPY_30d ? fear : greed
bond_signal = TLT_30d > SPY_30d ? fear : greed
dxy_signal = DXY_rising ? slight_fear : slight_greed
score = weighted combination with mean reversion
```

---

## Implementation Plan

### Phase 1: Data Layer (Backend)

1. **New FRED series** to add to `seed-economy.mjs`:
   - `BAMLC0A0CM` (IG OAS Spread)
   - `SOFR` (Secured Overnight Financing Rate)

2. **New data fetchers** in server handlers:
   - CBOE Put/Call ratio (Yahoo Finance: `^PCALL` or compute from options)
   - AAII survey data (web scrape or RSS)
   - CNN Fear & Greed (undocumented endpoint)
   - % stocks above 200 DMA (Finviz or computed)
   - VIX term structure (Yahoo: `^VIX`, `^VIX9D`, `^VIX3M`)
   - NYSE advance/decline data
   - CBOE Skew Index (`^SKEW` from Yahoo)

3. **Computed metrics** (server-side):
   - SPX 20/50/200 DMA from historical prices
   - Sector RSI calculations
   - Cross-asset correlation (rolling 30d)
   - M2 year-over-year change
   - Fed balance sheet month-over-month change

### Phase 2: Proto + RPC

4. **New proto**: `proto/worldmonitor/market/v1/fear_greed.proto`
   - `GetFearGreedIndex` RPC
   - Messages for each category score, inputs, and composite

5. **New handler**: `server/worldmonitor/market/v1/get-fear-greed-index.ts`
   - Fetches all inputs, computes scores, caches result (5-min TTL)

### Phase 3: Frontend Panel

6. **New component**: `src/components/FearGreedPanel.ts`
   - Gauge (SVG semicircle, animated)
   - Metric grid (3×3 key stats)
   - Radar chart (SVG, 10 axes)
   - Score distribution bars
   - Expandable category breakdown cards

7. **Register** in finance variant panel config

### Phase 4: Polish

8. Historical tracking (store daily snapshots for trend)
9. Sparklines per category (7d/30d history)
10. Alerts on threshold crossings

---

## Effort Estimate by Source Availability

| Effort Level | Items |
|-------------|-------|
| **Easy** (already have data, just read Redis) | VIX, HY spread, Fed rate, yield curve, M2, Fed BS, unemployment, crypto F&G |
| **Easy** (add to existing FRED_SERIES array) | IG spread (BAMLC0A0CM), SOFR |
| **Easy** (Yahoo Finance, existing pattern) | SPX trend/MAs, VIX9D/VIX3M term structure, SKEW, sector RSI, cross-asset (GLD/TLT/DXY), breadth proxy (RSP), NYSE composite |
| **Easy** (free CSV, no auth) | CBOE put/call ratios (totalpc.csv, equitypc.csv) |
| **Easy** (free JSON API) | CNN Fear & Greed (production.dataviz.cnn.io) |
| **Medium** (HTML scrape, weekly) | AAII Bull/Bear survey |

**Everything is free. Zero paid sources needed. Zero new API keys.**

---

## Seed Script Plan: `seed-fear-greed.mjs`

Following the gold standard pattern: Railway cron → fetch external APIs → atomic publish to Redis → server handler reads from Redis.

### Redis Keys

```
market:fear-greed:v1              # Composite index + all category scores (PRIMARY)
seed-meta:market:fear-greed       # Metadata (fetchedAt, recordCount, sourceVersion)
seed-lock:market:fear-greed       # Concurrency lock
```

**TTL**: 21600s (6h) — same as macro-signals, survives Yahoo outages
**Cron**: Every 6h (`0 0,6,12,18 * * *`)
**sourceVersion**: `yahoo-fred-cnn-aaii`

### Data Fetches — Exact Endpoints

#### Group 1: Yahoo Finance (sequential, 150ms gaps)

Already proven pattern in `seed-economy.mjs`. Uses `query1.finance.yahoo.com/v8/finance/chart`.

| # | Symbol | Data Needed | Category | Notes |
|---|--------|------------|----------|-------|
| 1 | `^GSPC` (SPX) | 1y daily closes | Trend, Momentum | Compute 20/50/200 DMA, ROC |
| 2 | `^VIX` | Current + 1y | Volatility | Already have via FRED but need real-time |
| 3 | `^VIX9D` | Current close | Volatility | 9-day VIX for term structure |
| 4 | `^VIX3M` | Current close | Volatility | 3-month VIX for term structure |
| 5 | `GLD` | 1y daily closes | Cross-Asset | Gold proxy, compute 30d return |
| 6 | `TLT` | 1y daily closes | Cross-Asset | Bonds proxy, compute 30d return |
| 7 | `SPY` | 1y daily closes | Cross-Asset, Breadth | Equity benchmark |
| 8 | `DX-Y.NYB` | 1y daily closes | Cross-Asset | USD Dollar Index |
| 9 | `HYG` | 1y daily closes | Credit | HY bond ETF (proxy for spreads trend) |
| 10 | `LQD` | 1y daily closes | Credit | IG bond ETF (proxy for spreads trend) |
| 11 | `XLK` | 1y daily closes | Momentum | Tech sector |
| 12 | `XLF` | 1y daily closes | Momentum | Financial sector |
| 13 | `XLE` | 1y daily closes | Momentum | Energy sector |
| 14 | `XLV` | 1y daily closes | Momentum | Healthcare sector |
| 15 | `XLI` | 1y daily closes | Momentum | Industrials sector |
| 16 | `XLU` | 1y daily closes | Momentum | Utilities (defensive) |

**Total Yahoo calls**: 16 × 150ms gap = ~2.4s sequential
**Fallback**: Finnhub candle API (`stock/candle`) for each symbol

#### Group 2: FRED Series (already seeded, just READ from Redis)

These are already being seeded by `seed-economy.mjs`. The fear-greed seed script reads them from Redis rather than re-fetching.

| Series | Category | Redis Key |
|--------|----------|-----------|
| `VIXCLS` | Volatility | `economic:fred:v1:VIXCLS:0` |
| `BAMLH0A0HYM2` | Credit (HY) | `economic:fred:v1:BAMLH0A0HYM2:0` |
| `DGS10` | Macro | `economic:fred:v1:DGS10:0` |
| `FEDFUNDS` | Macro | `economic:fred:v1:FEDFUNDS:0` |
| `T10Y2Y` | Macro | `economic:fred:v1:T10Y2Y:0` |
| `M2SL` | Liquidity | `economic:fred:v1:M2SL:0` |
| `WALCL` | Liquidity | `economic:fred:v1:WALCL:0` |
| `UNRATE` | Macro | `economic:fred:v1:UNRATE:0` |

**No API calls needed** — pure Redis reads via pipeline.

#### Group 3: New FRED Series (add to `seed-economy.mjs` FRED_SERIES array)

| Series | Name | Category | Why |
|--------|------|----------|-----|
| `BAMLC0A0CM` | ICE BofA US IG OAS | Credit | IG spread for credit scoring |
| `SOFR` | Secured Overnight Financing Rate | Liquidity | Short-term funding conditions |

**Action**: Add these 2 to the existing `FRED_SERIES` array in `seed-economy.mjs`. They'll be seeded automatically with the same 26h TTL.

#### Group 4: CNN Fear & Greed Index (NEW endpoint)

```javascript
// CNN's undocumented API — widely used by data projects
const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const resp = await fetch(url, {
  headers: { 'User-Agent': CHROME_UA },
  signal: AbortSignal.timeout(8000),
});
// Returns: { fear_and_greed: { score: 16, rating: "extreme fear", ... }, ... }
```

**Extracts**: `score` (0-100), `rating` (string), `previous_close`, `1_week_ago`, `1_month_ago`, `1_year_ago`
**Category**: Sentiment
**Reliability**: Good — CNN has maintained this endpoint for years
**Fallback**: Use crypto F&G from Alternative.me as proxy

#### Group 5: AAII Sentiment Survey (NEW endpoint)

```javascript
// AAII publishes weekly survey data
// Option A: RSS/XML feed
const url = 'https://www.aaii.com/sentimentsurvey';
// Parse HTML for current bull/bear/neutral percentages

// Option B: Use the AAII API (free, no key required)
const url = 'https://www.aaii.com/files/surveys/sentiment.xls';
// Excel file with historical data — parse last row
```

**Extracts**: `bullish%`, `bearish%`, `neutral%`, `bullBearSpread`
**Category**: Sentiment
**Reliability**: Medium — may need HTML scraping, XLS breaks sometimes
**Fallback**: Weight CNN F&G more heavily if AAII unavailable

#### Group 6: Market Breadth (NEW — multiple free signals)

```javascript
// Signal 1: RSP vs SPY divergence (breadth proxy)
// RSP = Invesco S&P 500 Equal Weight ETF
// If RSP outperforms SPY → broad participation (healthy breadth)
// If SPY outperforms RSP → narrow leadership (poor breadth)
// Already in Yahoo Finance calls above (symbols RSP, SPY)

// Signal 2: SPX distance from 200 DMA
// SPX price vs SMA200 → already computed in trend section
// pctAbove200d ≈ (SPX / SMA200 - 1) * 100 as rough proxy

// Signal 3: NYSE Composite (^NYA) breadth
// Already in Yahoo Finance calls above
// Compare NYSE Composite ROC vs SPX ROC → breadth divergence

// Signal 4 (FUTURE): Actual % stocks above 200 DMA from StockAnalysis
// https://stockanalysis.com/markets/breadth/ — scrape if needed later
```

**Best approach**: RSP/SPY + SPX/SMA200 + NYSE divergence — 3 signals, all from existing Yahoo calls
**Category**: Breadth
**Reliability**: HIGH — no scraping needed, pure Yahoo Finance data

#### Group 7: Put/Call Ratio — CBOE CDN CSVs (NEW — FREE, no auth)

```javascript
// CBOE publishes daily put/call ratio CSVs on their CDN — no auth, no scraping
const CBOE_URLS = {
  total: 'https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv',
  equity: 'https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/equitypc.csv',
  index: 'https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/indexpc.csv',
};

// CSV format: DATE,CALLS,PUTS,TOTAL,P/C RATIO
// Parse last row for current day, last 30 rows for history
const resp = await fetch(CBOE_URLS.equity, {
  headers: { 'User-Agent': CHROME_UA },
  signal: AbortSignal.timeout(8000),
});
const csv = await resp.text();
const rows = csv.trim().split('\n').slice(1); // skip header
const latest = rows[rows.length - 1].split(',');
const pcRatio = parseFloat(latest[4]); // P/C RATIO column
```

**Extracts**: Daily total P/C ratio, equity P/C ratio, index P/C ratio + 1yr history
**Category**: Positioning
**Reliability**: HIGH — CBOE CDN, free public data, no auth needed
**This is the goldmine source — most F&G clones use this**

#### Group 8: Crypto Fear & Greed (already in macro-signals)

```javascript
// Already fetched in seed-economy.mjs fetchMacroSignals()
// Just READ from Redis: economic:macro-signals:v1
// Extract: signals.fearGreed.value (0-100)
```

**Category**: Sentiment (supplement to CNN F&G)
**No additional API calls needed**

### Computed Metrics (in seed script, no external calls)

| Metric | Inputs | Formula | Category |
|--------|--------|---------|----------|
| SPX 20/50/200 DMA | ^GSPC closes | `smaCalc(prices, period)` | Trend |
| SPX ROC 20d | ^GSPC closes | `rateOfChange(prices, 20)` | Momentum |
| VIX Term Structure | ^VIX, ^VIX9D, ^VIX3M | `VIX/VIX3M` ratio (<1 = contango) | Volatility |
| Sector RSI (14d) | XLK/XLF/XLE/XLV/XLI/XLU | Standard RSI formula | Momentum |
| Cross-asset 30d returns | GLD, TLT, SPY, DXY | `rateOfChange(prices, 30)` | Cross-Asset |
| M2 YoY change | M2SL observations | `(latest - 12mo_ago) / 12mo_ago` | Liquidity |
| Fed BS MoM change | WALCL observations | `(latest - 4wk_ago) / 4wk_ago` | Liquidity |
| HY spread trend | BAMLH0A0HYM2 | `30d change direction` | Credit |
| RSP/SPY ratio | RSP, SPY | `RSP_return_30d - SPY_return_30d` | Breadth |

### Total External API Calls Per Seed Run

| Source | Calls | Rate Limited? | Auth |
|--------|-------|--------------|------|
| Yahoo Finance | 17 (16 symbols + RSP) | 150ms gaps | None |
| CNN dataviz | 1 | No | None |
| AAII | 1 | No | None |
| Redis reads | ~10 (FRED series pipeline) | No | Bearer token |
| **Total** | **~29** | — | — |

**Estimated runtime**: ~5s (Yahoo sequential) + ~2s (CNN/AAII parallel) + ~1s (Redis) = **~8s per run**

### Output Schema (stored in Redis)

```json
{
  "timestamp": "2024-03-20T12:00:00Z",
  "composite": {
    "score": 38.7,
    "label": "Fear",
    "previous": 41.2
  },
  "categories": {
    "sentiment": { "score": 19, "weight": 0.10, "contribution": 1.9, "inputs": { "cnnFearGreed": 16, "cnnLabel": "Extreme Fear", "aaiBull": 30.4, "aaiBear": 52.0 } },
    "volatility": { "score": 47, "weight": 0.10, "contribution": 4.7, "inputs": { "vix": 26.78, "vixChange": 11.31, "vix9d": 28.1, "vix3m": 24.5, "termStructure": "backwardation" } },
    "positioning": { "score": 34, "weight": 0.15, "contribution": 5.1, "inputs": { "putCallRatio": 1.01, "putCallAvg": 0.87 } },
    "trend": { "score": 52, "weight": 0.10, "contribution": 5.2, "inputs": { "spxPrice": 5667, "sma20": 5580, "sma50": 5520, "sma200": 5200, "aboveMaCount": 3 } },
    "breadth": { "score": 40, "weight": 0.10, "contribution": 4.0, "inputs": { "pctAbove200d": 43.93, "rspSpyRatio": -2.1 } },
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

## Quick-Win MVP

Build an initial version using **only data we already have + easy computations**:

1. **Volatility** — VIX from FRED ✅
2. **Credit** — HY Spread from FRED ✅
3. **Macro** — Fed Rate + Yield Curve + Unemployment from FRED ✅
4. **Trend** — SPX price vs computed MAs from Yahoo ✅
5. **Liquidity** — M2 + Fed Balance Sheet from FRED ✅
6. **Sentiment** — Crypto F&G as proxy (already have) + CNN F&G endpoint
7. **Momentum** — Sector ETF returns (already have)
8. **Cross-Asset** — Compute from existing Yahoo price feeds

This gives us **8 of 10 categories** immediately. Breadth and Positioning need new data sources but can use proxies (RSP/SPY ratio, hardcoded P/C neutral).
