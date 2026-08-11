# Phase 5 — 新闻证据、交易日对齐与非因果分析边界

**Date:** 2026-08-11
**Working branch:** `integration/pokieticker-maritime-china-factory`
**Implementation commit:** `7efd2e4a55f547e53943281b62ece403af8674e3`
(`feat(market): add evidence-linked stock news alignment`)

## Delivered boundary

Phase 5 adds an explicit Market v1 contract for source-linked stock news, its
exchange-time representation and a deliberately separate analysis result:

- `StockNewsAlignment` carries `exchange_timezone`,
  `published_at_exchange_tz`, `aligned_trading_date`, `alignment_rule`, and
  `market_session_at_publish`.
- `StockNewsAnalysis` carries availability/status/reason, model sentiment,
  relevance, causal confidence, model/provider/version/prompt identity and
  repeated actual-return records. A no-key response is explicitly
  `NOT_CONFIGURED` and `NEWS_SENTIMENT_UNAVAILABLE`; it is not a neutral,
  positive, negative, relevant or causal result.
- `StockRangeAnalysis` now returns verified start/end closes, the range return,
  total volume and validated bar count only when a symbol-matching validated
  bar series exists. Its causal note says that these price/volume facts do not
  establish a cause.

`Massive` company-news records are admitted only after the existing
symbol-match, URL and timestamp guards. The source URL and UTC publication
time remain attached before alignment is added. No historical PokieTicker
database, static article, fixture or synthetic particle is used in runtime.

## Calendar and causality checks

The current deterministic implementation applies the named NYSE/Nasdaq US
equity calendar. Tests prove these rules:

| Published time / condition | Result | Rule |
|---|---|---|
| Pre-market weekday (08:30 New York) | Same trading date | `PRE_MARKET_SAME_TRADING_DATE` |
| Regular session (12:15 New York) | Same trading date/minute context | `REGULAR_SESSION_SAME_TRADING_DATE` |
| Friday 18:30 New York | Following Monday | `AFTER_HOURS_NEXT_TRADING_DATE` |
| Weekend | Following exchange trading date | `NON_TRADING_DAY_NEXT_TRADING_DATE` |
| Christmas 2026 closure | Monday 2026-12-28 | `NON_TRADING_DAY_NEXT_TRADING_DATE` |

This is intentionally **not** a claim that every global primary exchange has
already been mapped. A future non-US listing must supply its primary exchange
calendar and timezone; it must not inherit the US rule as a silent default.

The UI wording is bounded to source/trading-date evidence. It may describe an
item as a possible influence or consistent with a time period only after a
versioned evidence-analysis provider returns a result; it never converts news
relevance, model sentiment, a matched timestamp, or T0/T1/T3/T5/T10 return
into an asserted market cause.

## Automated gates

| Command / check | Result |
|---|---|
| `npm exec --package=@bufbuild/buf@1.66.1 -- buf lint --path worldmonitor/market/v1/stock_data.proto` from `proto` | PASS (0) |
| `npm run typecheck:all` | PASS (0) |
| Focused Market/Phase 5 suite (`stock-news-evidence`, `stock-data-contract`, `stock-realtime-adapter`, `stock-workspace-route`) | PASS (20/20) |
| Scoped Biome lint over Phase 5 source/API/UI/tests | PASS (0) |
| `npm run test:dom` | PASS (293 tests) |
| `npm run lint:api-contract` | PASS (0) |
| `npm run sources:check` | PASS (0) |
| `npm run build:full` | PASS (0) |
| `npm run lint` and safe HTML guard | PASS (0); pre-existing 33 warnings / 9 infos remain outside this diff |

The first TypeScript attempt identified unsupported `Array.prototype.at` for
the repository target; the implementation was changed to indexed access before
all succeeding gates. An initial Buf invocation from the repository root used
the wrong configuration directory; it was rerun from `proto` and generated the
recorded API outputs. Full lint also required the bundled Node/npm directories
on `PATH`; after that environment-only correction it passed. None of these
three corrections suppressed a check or changed unrelated source.

## Local browser acceptance without a Provider

`phase5-news-evidence-no-provider-1440x900-final.png` records
`http://127.0.0.1:4184/stocks/AAPL` with the server in its no-key state:

- the dedicated workspace scroller has `overflow-y: auto` and
  `scrollHeight=1104`, `clientHeight=860`;
- the chart says there is no verified K-line;
- synthetic-candle marker count is zero;
- provider news item count is zero; and
- the disabled research panels do not present a fabricated classification,
  return, model verdict or event particle.

This proves the fail-closed browser state only. It does **not** claim a real
price, a live K-line, a Provider article, a model analysis, latency, display
rights or commercial redistribution rights.

## Manual boundary still pending

No `MASSIVE_API_KEY`, market display/rebroadcast entitlement, model-provider
credential, model-content authorization or deployment secret was requested,
received or stored. Before provider-backed analysis is enabled, the operator
must select an authorized model provider and its allowed financial/news use,
store the server-only secret outside Git/chat, and record the actual model
version, prompt version, source links and returned timestamps. That future
action is separate from this no-key contract and test completion.
