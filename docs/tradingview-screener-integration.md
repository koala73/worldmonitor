# TradingView Screener Integration Guide

**Purpose:** Reference document for extending WorldMonitor's finance hub with TradingView Screener data.

---

## Table of Contents

1. [Overview](#overview)
2. [Libraries](#libraries)
3. [What Data Is Available](#what-data-is-available)
4. [Architecture Fit (Gold Standard)](#architecture-fit-gold-standard)
5. [Integration Patterns](#integration-patterns)
6. [Panel Extensions](#panel-extensions)
7. [Field Reference](#field-reference)
8. [Query Cookbook](#query-cookbook)
9. [Rate Limiting & Production Notes](#rate-limiting--production-notes)
10. [Implementation Checklist](#implementation-checklist)

---

## Overview

TradingView exposes an undocumented but stable `/screener` API at `https://scanner.tradingview.com/{market}/scan`. Two open-source libraries wrap it:

| Library | Language | Repo |
|---------|----------|------|
| `tradingview-screener` | Python | `../TradingView-Screener/` |
| `tradingview-screener-ts` | TypeScript | https://github.com/Anny26022/TradingView-Screener-ts |

Both provide:

- 3,000+ fields across stocks, crypto, forex, futures, bonds
- SQL-like `Query` builder with filter, sort, paginate
- 87 markets/exchanges (geographic + asset class)
- Timeframe variants per field (1m → 1M)
- No API key required for delayed/public data

The TypeScript library is the one relevant for WorldMonitor. It has full parity with the Python version (41/41 operations pass) plus a self-hosted REST server option.

---

## Libraries

### TypeScript: `tradingview-screener-ts`

```bash
npm install tradingview-screener-ts
```

```typescript
import { Query, col, And, Or } from 'tradingview-screener-ts'

const [total, rows] = await new Query()
  .set_markets('crypto')
  .select('name', 'close', 'volume', 'market_cap_basic', 'change')
  .order_by('market_cap_basic', false)
  .limit(50)
  .get_scanner_data()
// rows: [{ ticker: 'BINANCE:BTCUSDT', name: 'Bitcoin', close: 62000, ... }]
```

**Key types:**
```typescript
interface ScreenerRowDict { s: string; d: unknown[] }
interface ScreenerDict    { totalCount: number; data: ScreenerRowDict[] | null }

// get_scanner_data returns:
[number, Record<string, unknown>[]]
// [totalCount, [{ ticker, col1, col2, ... }, ...]]
```

**Timeframe variants:** append `|{tf}` to any field name.
```typescript
'close'       // daily
'close|1'     // 1-minute
'close|5'     // 5-minute
'close|60'    // 1-hour
'close|240'   // 4-hour
'close|1W'    // weekly
'close|1M'    // monthly
```

**All filter methods on `col()`:**
```typescript
col('close').gt(100)              col('close').ge(100)
col('close').lt(100)              col('close').le(100)
col('close').eq(100)              col('close').ne(100)
col('close').between(10, 50)      col('close').not_between(10, 50)
col('type').isin(['stock'])       col('type').not_in(['etf'])
col('tags').has(['value'])        col('tags').has_none_of(['etf'])
col('close').crosses(col('EMA20'))
col('close').crosses_above(col('EMA20'))
col('close').crosses_below(col('EMA20'))
col('close').above_pct(col('SMA200'), 0.05)
col('close').below_pct(col('SMA200'), 0.05)
col('name').like('Apple%')        col('name').not_like('Apple%')
col('eps').empty()                col('eps').not_empty()
col('date').in_day_range(0, 0)    col('date').in_week_range(0, 2)
```

---

## What Data Is Available

### By Asset Class

| Market Key | Fields | With Timeframes | Notes |
|------------|--------|-----------------|-------|
| `america` | 1,003 | 3,514 | US stocks |
| `crypto` | 525 | 3,094 | BTC/ETH/etc. |
| `forex` | 439 | 2,950 | FX pairs |
| `cfd` | 439 | 2,950 | CFDs |
| `futures` | 394 | 394 | Commodities, index futures |
| `bonds` | 153 | 180 | Government/corporate bonds |
| `coin` | 518 | 3,029 | Spot crypto |

### Data Categories Available

| Category | Example Fields |
|----------|---------------|
| **Price / OHLCV** | `close`, `open`, `high`, `low`, `volume` |
| **Change** | `change` (%), `change_abs` ($), `change_from_open`, `gap` |
| **Market cap** | `market_cap_basic` |
| **Technicals** | `RSI`, `MACD.macd`, `MACD.signal`, `MACD.hist`, `BB.upper`, `BB.lower`, `BB.mid` |
| **Moving averages** | `EMA5`, `EMA20`, `EMA50`, `EMA100`, `EMA200`, `SMA20`, `SMA50`, `SMA200` |
| **Volume analysis** | `relative_volume_10d_calc`, `Value.Traded`, `average_volume_10d_calc` |
| **Fundamentals** | `price_earnings_ttm`, `earnings_per_share_basic_ttm`, `dividend_yield_recent`, `book_value_per_share` |
| **52-week** | `price_52_week_high`, `price_52_week_low`, `High.All`, `Low.All` |
| **VWAP** | `VWAP` |
| **Classification** | `type`, `typespecs`, `sector`, `industry`, `country`, `exchange`, `currency` |
| **Status** | `active_symbol`, `is_primary`, `update_mode` |
| **Indices** | `index` (which indices the stock belongs to) |
| **Analyst ratings** | `Recommend.All`, `Recommend.MA`, `Recommend.Other` |
| **Beta/risk** | `beta_1_year` |
| **Pre/post market** | `premarket_change`, `premarket_volume`, `postmarket_change` |
| **Earnings** | `earnings_release_next_trading_date_fq`, `earnings_per_share_forecast_next_fq` |
| **Crypto-specific** | `24h_vol_change`, `circulating_supply`, `total_supply`, `24h_close_change` |

---

## Architecture Fit (Gold Standard)

WorldMonitor's data flow: `Railway seeds Redis → Vercel reads Redis → Frontend RPC`

TradingView Screener calls belong in the **Railway AIS relay** (`scripts/ais-relay.cjs`), alongside existing CoinGecko/Yahoo/Finnhub calls.

```
Railway ais-relay.cjs
  └── seedTvStockScreener()     → market:tv-screener:stocks:v1    (TTL 5m)
  └── seedTvCryptoScreener()    → market:tv-screener:crypto:v1    (TTL 5m)
  └── seedTvForexScreener()     → market:tv-screener:forex:v1     (TTL 5m)
  └── seedTvTechnicals()        → market:tv-technicals:v1         (TTL 5m)
  └── seedTvEarningsCalendar()  → market:tv-earnings:v1           (TTL 1h)
  └── seedTvSectorSummary()     → market:tv-sectors:v1            (TTL 5m)

Vercel RPC handlers (read-only from Redis):
  └── list-tv-stock-screener.ts
  └── list-tv-crypto-screener.ts
  └── list-tv-forex-screener.ts
  └── get-tv-technicals.ts
  └── list-tv-earnings.ts
  └── list-tv-sectors.ts

Frontend → circuit breaker → RPC → Redis
```

**No TradingView calls from Vercel edge.** All upstream calls are Railway-side.

The TS library (`tradingview-screener-ts`) runs inside the Railway relay Node.js process.

---

## Integration Patterns

### Seed Script Pattern (matches existing `seed-crypto-quotes.mjs`)

```javascript
// scripts/seed-tv-stock-screener.mjs
import { Query, col } from 'tradingview-screener-ts';
import { runSeed, CHROME_UA } from './_seed-utils.mjs';

const TV_KEY = 'market:tv-screener:stocks:v1';
const CACHE_TTL = 300; // 5 minutes

async function seedTvStockScreener() {
  const [total, rows] = await new Query()
    .select(
      'name', 'close', 'change', 'volume', 'market_cap_basic',
      'relative_volume_10d_calc', 'RSI', 'sector', 'country'
    )
    .where(
      col('market_cap_basic').gt(1_000_000_000),
      col('active_symbol').eq(true),
      col('is_primary').eq(true)
    )
    .order_by('Value.Traded', false)
    .limit(100)
    .get_scanner_data();

  if (!rows.length) throw new Error('TradingView returned no stock data');

  await runSeed(TV_KEY, { rows, total }, CACHE_TTL);
}

seedTvStockScreener().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
```

### Relay Integration Pattern

```javascript
// In scripts/ais-relay.cjs — add to seedAllMarketData():

const { Query, col } = require('tradingview-screener-ts');

async function seedTvStockScreener() {
  try {
    const [total, rows] = await new Query()
      .select('name', 'close', 'change', 'volume', 'market_cap_basic', 'RSI', 'sector')
      .where(col('market_cap_basic').gt(1_000_000_000), col('is_primary').eq(true))
      .order_by('Value.Traded', false)
      .limit(100)
      .get_scanner_data();

    if (rows.length > 0) {
      await redisSet('market:tv-screener:stocks:v1', JSON.stringify({ rows, total }), 'EX', 300);
      console.log(`[TV Screener] Seeded ${rows.length} stocks`);
    }
  } catch (err) {
    console.error('[TV Screener] Failed:', err.message);
  }
}
```

### Server Handler Pattern (read-only from Redis)

```typescript
// server/worldmonitor/market/v1/list-tv-stock-screener.ts
import { getCachedJson } from '@/_shared/redis';
import type { ListTvStockScreenerRequest, ListTvStockScreenerResponse } from '@generated/...';

const CACHE_KEY = 'market:tv-screener:stocks:v1';

export async function listTvStockScreener(
  _req: ListTvStockScreenerRequest
): Promise<ListTvStockScreenerResponse> {
  const data = await getCachedJson<{ rows: TvStockRow[]; total: number }>(CACHE_KEY, true);
  return { stocks: data?.rows ?? [], total: data?.total ?? 0 };
}
```

---

## Panel Extensions

### 1. Stock Screener Panel

**New panel idea:** Filterable table of top stocks by market cap, volume, RSI.

**Data needed:**
```typescript
new Query()
  .select('name', 'close', 'change', 'change_abs', 'volume',
          'market_cap_basic', 'RSI', 'relative_volume_10d_calc',
          'sector', 'country', 'exchange')
  .where(
    col('market_cap_basic').gt(1_000_000_000),  // >$1B market cap
    col('is_primary').eq(true),
    col('active_symbol').eq(true)
  )
  .order_by('Value.Traded', false)
  .limit(100)
```

**Fields per row:**

- Ticker, Name, Price, Change %, Volume, Market Cap, RSI, Rel. Volume, Sector

---

### 2. Enhanced Crypto Panel

**Upgrade existing CryptoPanel** with TradingView data (richer than CoinGecko):

```typescript
new Query()
  .set_markets('crypto')
  .select('name', 'close', 'change', 'change|1W', 'volume',
          'market_cap_basic', 'RSI', 'Recommend.All',
          'relative_volume_10d_calc', '24h_vol_change')
  .order_by('market_cap_basic', false)
  .limit(50)
```

**New fields vs current:** Analyst recommendation, multi-timeframe change, RSI, relative volume.

---

### 3. Sector Performance Panel

**Real-time sector heatmap** (US stock sectors + international):

```typescript
// One query per sector, or use sector field + aggregate
new Query()
  .select('sector', 'change')
  .where(
    col('market_cap_basic').gt(500_000_000),
    col('type').isin(['stock']),
    col('exchange').not_in(['OTC']),
    col('is_primary').eq(true)
  )
  .order_by('Value.Traded', false)
  .limit(2000)
// Then group by 'sector' and average 'change' on the Railway side
```

**Sectors available:** Technology, Healthcare, Financials, Consumer Cyclical, Industrials, Communication Services, Consumer Defensive, Energy, Basic Materials, Real Estate, Utilities.

---

### 4. Forex Panel

**New panel:** Major currency pairs with 24h change.

```typescript
new Query()
  .set_markets('forex')
  .select('name', 'close', 'change', 'change_abs', 'volume',
          'RSI', 'MACD.macd', 'EMA20', 'BB.upper', 'BB.lower')
  .set_tickers(
    'FX:EURUSD', 'FX:GBPUSD', 'FX:USDJPY', 'FX:USDCHF',
    'FX:AUDUSD', 'FX:USDCAD', 'FX:NZDUSD', 'FX:USDHKD',
    'FX:USDCNH', 'FX:EURGBP'
  )
  .get_scanner_data()
```

---

### 5. Commodity Futures Panel

**Upgrade existing CommoditiesPanel** with futures data:

```typescript
new Query()
  .set_markets('futures')
  .select('name', 'close', 'change', 'change_abs', 'volume',
          'open', 'high', 'low', 'price_52_week_high', 'price_52_week_low')
  .set_tickers(
    'NYMEX:CL1!',  // WTI Crude Oil
    'NYMEX:NG1!',  // Natural Gas
    'COMEX:GC1!',  // Gold
    'COMEX:SI1!',  // Silver
    'CBOT:ZW1!',   // Wheat
    'CBOT:ZC1!',   // Corn
    'CBOT:ZS1!',   // Soybeans
    'NYMEX:HO1!',  // Heating Oil
    'NYMEX:RB1!',  // RBOB Gasoline
    'COMEX:HG1!',  // Copper
    'COMEX:PL1!',  // Platinum
    'COMEX:PA1!',  // Palladium
  )
  .get_scanner_data()
```

---

### 6. Technical Signals Panel

**New panel:** Stocks/crypto with notable technical setups.

```typescript
// Golden cross: EMA50 crossed above EMA200
new Query()
  .select('name', 'close', 'change', 'EMA50', 'EMA200', 'volume', 'RSI')
  .where(
    col('EMA50').crosses_above(col('EMA200')),
    col('volume').gt(500_000),
    col('market_cap_basic').gt(500_000_000)
  )
  .limit(20)
  .get_scanner_data()

// Oversold (RSI < 30) with positive change
new Query()
  .select('name', 'close', 'change', 'RSI', 'volume', 'market_cap_basic')
  .where(
    col('RSI').between(20, 30),
    col('change').gt(0),
    col('volume').gt(1_000_000)
  )
  .limit(20)
  .get_scanner_data()

// Strong buy recommendations
new Query()
  .select('name', 'close', 'Recommend.All', 'RSI', 'MACD.macd')
  .where(col('Recommend.All').between(0.5, 1.0))
  .order_by('Recommend.All', false)
  .limit(20)
  .get_scanner_data()
```

---

### 7. Earnings Calendar Panel

**New panel:** Upcoming earnings dates.

```typescript
new Query()
  .select('name', 'close', 'change', 'market_cap_basic',
          'earnings_release_next_trading_date_fq',
          'earnings_per_share_forecast_next_fq',
          'earnings_per_share_basic_ttm')
  .where(
    col('earnings_release_next_trading_date_fq').in_day_range(0, 7),
    col('market_cap_basic').gt(1_000_000_000)
  )
  .order_by('market_cap_basic', false)
  .limit(50)
  .get_scanner_data()
```

---

### 8. Relative Strength / Hot Sectors

**Ideas for the AI Forecasts panel or new "Market Pulse" panel:**

```typescript
// Top movers today
new Query()
  .select('name', 'close', 'change', 'volume', 'relative_volume_10d_calc', 'sector')
  .where(
    col('change').gt(5),                         // up 5%+
    col('volume').gt(1_000_000),
    col('relative_volume_10d_calc').gt(2)        // 2x normal volume
  )
  .order_by('change', false)
  .limit(20)
  .get_scanner_data()

// Pre-market movers
new Query()
  .select('name', 'close', 'premarket_change', 'premarket_volume', 'market_cap_basic')
  .where(
    col('premarket_change').not_empty(),
    col('premarket_volume').gt(100_000),
    col('market_cap_basic').gt(500_000_000)
  )
  .order_by('premarket_change', false)
  .limit(20)
  .get_scanner_data()
```

---

### 9. Bond / Yield Panel

**New panel:** Government bond yields.

```typescript
new Query()
  .set_markets('bonds')
  .select('name', 'close', 'change', 'yield', 'duration', 'country')
  .set_tickers(
    'TVC:US10Y',   // US 10-year yield
    'TVC:US02Y',   // US 2-year yield
    'TVC:US30Y',   // US 30-year yield
    'TVC:DE10Y',   // German 10Y
    'TVC:GB10Y',   // UK 10Y
    'TVC:JP10Y',   // Japan 10Y
    'TVC:IT10Y',   // Italy 10Y
    'TVC:CN10Y',   // China 10Y
  )
  .get_scanner_data()
```

---

## Field Reference

### Price & Volume

| Field | Description | Type |
|-------|-------------|------|
| `close` | Current/closing price | price |
| `open` | Opening price | price |
| `high` | Day high | price |
| `low` | Day low | price |
| `volume` | Volume | number |
| `Value.Traded` | Dollar volume traded | fundamental_price |
| `average_volume_10d_calc` | 10-day avg volume | number |
| `relative_volume_10d_calc` | Relative volume vs 10d avg | number |

### Change

| Field | Description | Type |
|-------|-------------|------|
| `change` | % change today | percent |
| `change_abs` | Absolute $ change | price |
| `change_from_open` | % change from open | percent |
| `gap` | Gap % from prev close | percent |
| `premarket_change` | Pre-market % change | percent |
| `postmarket_change` | After-hours % change | percent |

### Technicals

| Field | Description | Type |
|-------|-------------|------|
| `RSI` | RSI(14) | number |
| `RSI[1]` | RSI prev bar | number |
| `MACD.macd` | MACD line | number |
| `MACD.signal` | Signal line | number |
| `MACD.hist` | Histogram | number |
| `BB.upper` | Bollinger upper | price |
| `BB.lower` | Bollinger lower | price |
| `BB.mid` | Bollinger mid (SMA20) | price |
| `VWAP` | VWAP | price |
| `stochastic_k` | Stochastic %K | number |
| `stochastic_d` | Stochastic %D | number |
| `ATR` | Average True Range | number |
| `Recommend.All` | Combined TV rating (-1 to 1) | number |
| `Recommend.MA` | MA recommendation | number |
| `Recommend.Other` | Oscillator recommendation | number |

### Moving Averages

| Field | Description |
|-------|-------------|
| `EMA5`, `EMA10`, `EMA20` | Exponential MAs |
| `EMA50`, `EMA100`, `EMA200` | Longer-term EMAs |
| `SMA5`, `SMA10`, `SMA20` | Simple MAs |
| `SMA50`, `SMA100`, `SMA200` | Longer-term SMAs |
| `HullMA9` | Hull MA |
| `VWMA` | Volume-weighted MA |

### Fundamentals (Stocks)

| Field | Description | Type |
|-------|-------------|------|
| `market_cap_basic` | Market cap | fundamental_price |
| `price_earnings_ttm` | P/E ratio | number |
| `earnings_per_share_basic_ttm` | EPS (TTM) | fundamental_price |
| `dividend_yield_recent` | Dividend yield % | percent |
| `dividends_yield_current` | Current dividend yield | percent |
| `book_value_per_share` | Book value/share | fundamental_price |
| `price_book_fq` | Price/Book | number |
| `price_sales_current` | Price/Sales | number |
| `debt_to_equity` | Debt/Equity ratio | number |
| `return_on_equity` | ROE % | percent |
| `gross_margin` | Gross margin % | percent |
| `net_income_margin` | Net margin % | percent |
| `beta_1_year` | Beta vs market | number |
| `price_52_week_high` | 52-week high | price |
| `price_52_week_low` | 52-week low | price |
| `number_of_employees` | Headcount | number |
| `sector` | Sector classification | text |
| `industry` | Industry | text |

### Crypto-Specific

| Field | Description | Type |
|-------|-------------|------|
| `market_cap_basic` | Market cap | fundamental_price |
| `24h_vol_change` | 24h volume change % | percent |
| `circulating_supply` | Circulating supply | number |
| `total_supply` | Total supply | number |
| `24h_close_change` | 24h close change % | percent |

### Classification

| Field | Description |
|-------|-------------|
| `name` | Ticker symbol |
| `description` | Company/asset name |
| `type` | `stock`, `fund`, `dr`, `bond`, `crypto` |
| `typespecs` | Sub-type array: `['common']`, `['etf']`, `['etn']` |
| `exchange` | Exchange: `NASDAQ`, `NYSE`, `BINANCE`, etc. |
| `country` | Country code |
| `currency` | Quote currency |
| `update_mode` | `streaming`, `delayed_streaming_900` |
| `is_primary` | Primary listing (not ADR/secondary) |
| `active_symbol` | Traded today |

---

## Query Cookbook

### Top 50 Most Traded US Stocks

```typescript
const [total, rows] = await new Query()
  .select('name', 'description', 'close', 'change', 'volume', 'market_cap_basic', 'sector')
  .where(
    col('is_primary').eq(true),
    col('active_symbol').eq(true),
    col('exchange').not_in(['OTC'])
  )
  .order_by('Value.Traded', false)
  .limit(50)
  .get_scanner_data()
```

### Top Crypto by Market Cap

```typescript
const [total, rows] = await new Query()
  .set_markets('crypto')
  .select('name', 'close', 'change', 'market_cap_basic', 'volume', 'RSI')
  .order_by('market_cap_basic', false)
  .limit(50)
  .get_scanner_data()
```

### S&P 500 Components

```typescript
const [total, rows] = await new Query()
  .set_index('SP;SPX')
  .select('name', 'close', 'change', 'volume', 'market_cap_basic', 'sector', 'RSI')
  .order_by('market_cap_basic', false)
  .limit(505)
  .get_scanner_data()
```

### Sector Performance (US)

```typescript
// Fetch all large-cap stocks with sector; aggregate by sector on Railway side
const [total, rows] = await new Query()
  .select('sector', 'change', 'market_cap_basic')
  .where(
    col('market_cap_basic').gt(500_000_000),
    col('type').isin(['stock']),
    col('is_primary').eq(true),
    col('exchange').not_in(['OTC']),
    col('sector').not_empty()
  )
  .limit(2000)
  .get_scanner_data()

// Group and average on Railway:
const sectorChange = Object.entries(
  rows.reduce((acc, r) => {
    const s = r.sector as string
    if (!acc[s]) acc[s] = { sum: 0, count: 0 }
    acc[s].sum += (r.change as number) ?? 0
    acc[s].count++
    return acc
  }, {} as Record<string, { sum: number; count: number }>)
).map(([name, { sum, count }]) => ({ name, change: sum / count }))
```

### Forex Major Pairs

```typescript
const [total, rows] = await new Query()
  .set_markets('forex')
  .set_tickers(
    'FX:EURUSD', 'FX:GBPUSD', 'FX:USDJPY', 'FX:USDCHF',
    'FX:AUDUSD', 'FX:USDCAD', 'FX:NZDUSD', 'FX:EURGBP',
    'FX:EURJPY', 'FX:GBPJPY'
  )
  .select('name', 'close', 'change', 'change_abs', 'high', 'low', 'RSI')
  .get_scanner_data()
```

### Commodity Futures

```typescript
const [total, rows] = await new Query()
  .set_markets('futures')
  .set_tickers(
    'NYMEX:CL1!', 'NYMEX:NG1!', 'COMEX:GC1!', 'COMEX:SI1!',
    'CBOT:ZW1!', 'CBOT:ZC1!', 'CBOT:ZS1!', 'COMEX:HG1!'
  )
  .select('name', 'close', 'change', 'high', 'low', 'volume')
  .get_scanner_data()
```

### Multi-Timeframe Screener (1D + 1W change)

```typescript
const [total, rows] = await new Query()
  .select('name', 'close', 'change', 'change|1W', 'change|1M',
          'RSI', 'RSI|1W', 'volume', 'market_cap_basic')
  .where(col('market_cap_basic').gt(1_000_000_000))
  .order_by('Value.Traded', false)
  .limit(50)
  .get_scanner_data()
```

### Upcoming Earnings (7 Days)

```typescript
const [total, rows] = await new Query()
  .select('name', 'close', 'change', 'market_cap_basic',
          'earnings_release_next_trading_date_fq',
          'earnings_per_share_forecast_next_fq')
  .where(
    col('earnings_release_next_trading_date_fq').in_day_range(0, 7),
    col('market_cap_basic').gt(1_000_000_000)
  )
  .order_by('market_cap_basic', false)
  .limit(50)
  .get_scanner_data()
```

### Technical Breakouts

```typescript
// Price above 52-week high
const [total, rows] = await new Query()
  .select('name', 'close', 'change', 'volume', 'price_52_week_high')
  .where(
    col('close').above_pct(col('price_52_week_high'), 1.0),  // AT or above 52wk high
    col('volume').gt(1_000_000)
  )
  .order_by('change', false)
  .limit(20)
  .get_scanner_data()

// Golden cross (EMA50 > EMA200)
const [total2, rows2] = await new Query()
  .select('name', 'close', 'change', 'EMA50', 'EMA200', 'volume')
  .where(
    col('EMA50').crosses_above(col('EMA200')),
    col('volume').gt(500_000)
  )
  .limit(20)
  .get_scanner_data()
```

### Oversold / Strong Buy Setups

```typescript
// RSI oversold with positive change
const [total, rows] = await new Query()
  .select('name', 'close', 'change', 'RSI', 'Recommend.All')
  .where(
    col('RSI').between(20, 35),
    col('change').gt(0),
    col('volume').gt(500_000),
    col('market_cap_basic').gt(500_000_000)
  )
  .limit(20)
  .get_scanner_data()
```

---

## Rate Limiting & Production Notes

### TradingView API Behavior

- **No documented rate limits.** In practice, bans are possible with high-frequency polling.
- **Auth:** Unauthenticated requests get delayed data (15-min for some exchanges). Pass a valid TradingView session cookie for real-time.
- **Max limit:** Up to 100,000 rows technically possible but not recommended.
- **No retry logic built-in** — implement your own for 429/5xx.

### WorldMonitor-Specific Recommendations

| Concern | Recommendation |
|---------|---------------|
| **Polling interval** | 5 min (matches existing `MARKET_SEED_INTERVAL_MS = 300_000`) |
| **TTL** | 5 min for price data, 1h for earnings/fundamentals |
| **Per-call limits** | 100 rows for screener, 500 for index components |
| **CoinGecko overlap** | Keep CoinGecko for crypto token panels (richer DeFi/AI/Other data); TradingView for top-N crypto |
| **Finnhub/Yahoo overlap** | TradingView can supplement stock quotes; keep Finnhub/Yahoo as primary for existing panels |
| **Railway concurrency** | Run TV calls sequentially inside `seedAllMarketData()`, not `Promise.all` |
| **Circuit breaker** | Add a `tvScreenerBreaker` alongside existing stock/crypto breakers |
| **No auth initially** | Delayed data is fine for WorldMonitor's use case |
| **User-Agent** | Library automatically mimics Chrome headers; do not override |

### Sample Relay Integration Timing

Assuming existing relay runs `seedAllMarketData()` every 5 min with 3 existing CoinGecko calls:

| Seed Function | Avg Duration | CoinGecko? |
|---------------|-------------|------------|
| `seedCryptoQuotes` | ~1s | Yes |
| `seedStablecoins` | ~1s | Yes |
| `seedCryptoSectors` | ~1.5s | Yes |
| `seedTokenPanels` | ~1.5s | Yes |
| `seedTvStocks` (new) | ~0.5s | No (TradingView) |
| `seedTvCrypto` (new) | ~0.5s | No (TradingView) |
| `seedTvForex` (new) | ~0.5s | No (TradingView) |

TradingView calls are independent of CoinGecko rate limits. Each call completes in 200-800ms.

---

## Implementation Checklist

### Phase A: Stock Screener Panel

- [ ] `npm install tradingview-screener-ts` in Railway relay package
- [ ] Add `seedTvStockScreener()` to `scripts/ais-relay.cjs`
- [ ] Add `market:tv-screener:stocks:v1` to `server/_shared/cache-keys.ts`
- [ ] Create `proto/worldmonitor/market/v1/list_tv_stock_screener.proto`
- [ ] Create `server/worldmonitor/market/v1/list-tv-stock-screener.ts`
- [ ] Register in `handler.ts` and `service.proto`
- [ ] Run `buf generate`
- [ ] Add `tvStocksBreaker` to `src/services/market/index.ts`
- [ ] Create `TvStockScreenerPanel` in `src/components/MarketPanel.ts`
- [ ] Register panel in `src/config/panels.ts`
- [ ] Wire in `panel-layout.ts` and `data-loader.ts`
- [ ] Add to `api/bootstrap.js` and `cache-keys.ts` BOOTSTRAP_TIERS
- [ ] Add cache tier to `server/gateway.ts`
- [ ] Sync `scripts/shared/` if needed
- [ ] `npm run typecheck && npm run test:data` → all pass

### Phase B: Sector Performance Upgrade

- [ ] Add `seedTvSectorSummary()` to relay (aggregates by sector server-side)
- [ ] Upgrade existing `HeatmapPanel` to use TradingView sector data
- [ ] Keep existing `get-sector-summary` handler as fallback

### Phase C: Forex Panel

- [ ] Add `seedTvForexPairs()` to relay
- [ ] New `ForexPanel` component
- [ ] Register in `FINANCE_PANELS`

### Phase D: Enhanced Commodity Futures

- [ ] Add `seedTvCommodityFutures()` (replaces/supplements Yahoo commodities)
- [ ] Upgrade `CommoditiesPanel` rendering with futures data

### Phase E: Earnings Calendar Panel

- [ ] Add `seedTvEarningsCalendar()` (TTL 1h, not 5min)
- [ ] New `EarningsCalendarPanel` component
- [ ] Show next 7 days of earnings for large-cap stocks

---

## Appendix: Useful TradingView Market Identifiers

### Major US Indices (for `set_index()`)

| Symbol | Index |
|--------|-------|
| `SP;SPX` | S&P 500 |
| `DJ;DJI` | Dow Jones |
| `NASDAQ;NDX` | Nasdaq 100 |
| `SP;MID` | S&P MidCap 400 |
| `SP;SML` | S&P SmallCap 600 |
| `RUSSELL;RUT` | Russell 2000 |

### Futures Tickers

| Ticker | Commodity |
|--------|-----------|
| `NYMEX:CL1!` | WTI Crude Oil |
| `NYMEX:NG1!` | Natural Gas |
| `COMEX:GC1!` | Gold |
| `COMEX:SI1!` | Silver |
| `COMEX:HG1!` | Copper |
| `COMEX:PL1!` | Platinum |
| `CBOT:ZW1!` | Wheat |
| `CBOT:ZC1!` | Corn |
| `CBOT:ZS1!` | Soybeans |
| `CME:ES1!` | S&P 500 E-mini |
| `CME:NQ1!` | Nasdaq E-mini |
| `CME:RTY1!` | Russell 2000 E-mini |
| `EUREX:FDAX1!` | DAX Futures |
| `SGX:CN1!` | CSI 300 Futures |

### Government Bonds / Yields

| Ticker | Description |
|--------|-------------|
| `TVC:US02Y` | US 2-Year Yield |
| `TVC:US10Y` | US 10-Year Yield |
| `TVC:US30Y` | US 30-Year Yield |
| `TVC:DE10Y` | German 10-Year Bund |
| `TVC:GB10Y` | UK Gilt 10-Year |
| `TVC:JP10Y` | Japan JGB 10-Year |
| `TVC:IT10Y` | Italy BTP 10-Year |
| `TVC:FR10Y` | France OAT 10-Year |
| `TVC:CN10Y` | China 10-Year |

### Forex Pairs

| Ticker | Pair |
|--------|------|
| `FX:EURUSD` | EUR/USD |
| `FX:GBPUSD` | GBP/USD |
| `FX:USDJPY` | USD/JPY |
| `FX:USDCHF` | USD/CHF |
| `FX:AUDUSD` | AUD/USD |
| `FX:USDCAD` | USD/CAD |
| `FX:NZDUSD` | NZD/USD |
| `FX:USDCNH` | USD/CNH (offshore RMB) |
| `FX:USDINR` | USD/INR |
| `FX:USDBRL` | USD/BRL |
| `FX:USDTRY` | USD/TRY |
| `FX:USDRUB` | USD/RUB |
| `FX:USDZAR` | USD/ZAR |

---

*Document generated 2026-03-20. TradingView API is undocumented and subject to change. Field availability and market identifiers should be verified against the library's live metadata endpoint before production use: `GET /api/v1/metadata/fields?universe={market}`*
