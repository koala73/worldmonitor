# Phase 2 — data contract and truthful disabled-state evidence

**Phase branch:** `integration/pokieticker-maritime-china-factory`
**Upstream baseline:** `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`
**Implementation commit:** pending; backfilled by the next documentation receipt.

## Delivered contract

- Added the eight required Market v1 RPCs: `SearchStocks`, `GetStockBars`,
  `GetStockQuote`, `ListStockNews`, `GetStockEventTimeline`,
  `AnalyzeStockRange`, `GetStockForecast`, and `FindSimilarStockEvents`.
- Added `ProviderStatus`, `DataProvenance`, `StockBar`, `StockQuote`, stock
  news/event records, range-analysis and forecast types to the protobuf API.
- Every new response includes provider identity/status, source identifiers,
  observed/fetched/as-of times, delay/freshness, fallback and license fields.
- Implemented strict stock symbol and range validation, a cache-key builder
  containing `provider:symbol:interval:range`, and bar invariants that reject
  cross-symbol, duplicate-time, negative-volume and invalid-OHLC data.
- Implemented an intentionally no-data handler for the no-key state. It returns
  `PROVIDER_STATUS_NOT_CONFIGURED`, empty collections or absent value objects,
  and never generates a sample price, K line, news event, forecast or cause.
- Generated the client, server, request validator and OpenAPI from the proto;
  no generated source was edited by hand.

## Commands and exit codes

| Command | Exit | Result |
|---|---:|---|
| `npm exec --yes --package=@bufbuild/buf -- buf format -w proto` | 0 | New protocols formatted; unrelated full-tree formatting was mechanically reversed before commit. |
| `buf lint` (whole proto tree) | 100 | Existing baseline failures: unused imports and intelligence `go_package` inconsistencies outside Phase 2. Not counted as pass. |
| `buf lint --path` for each of nine new market protocols | 0 | New contract protocols valid. |
| `buf generate` using sebuf `v0.11.1` | 0 | Market client/server/OpenAPI generation completed. |
| Project post-generation validation/OpenAPI scripts | 0 | Request validation and OpenAPI injectors completed. |
| `npm run lint:api-contract` | 0 | Gateway/generation contract clean. |
| `npm run typecheck:all` | 0 | Root and API types passed. |
| `npm exec -- tsx --test tests/stock-data-contract.test.mts` | 0 | Six contract tests passed. |
| `npm run build:full` | 0 | Production build passed on Windows; only existing chunk-size warnings observed. |

## Toolchain receipt

- Buf: `1.66.1`, started through an isolated npm execution.
- sebuf generators: `v0.11.1`, built with portable Go `1.26.0` in
  `D:\使用AI专属文件夹\global-intelligence-earth\_codex_phase2_tools`.
- The first attempt via `proxy.golang.org` failed because that endpoint could
  not be reached. The successful scoped installation used the Makefile's
  direct-GitHub strategy with a module mirror for dependencies. No project or
  system-wide Go installation was changed.

## Historical-fixture receipt

The test fixture contains three real rows each for AAPL, MSFT, NVDA and TSLA
from the preserved PokieTicker SQLite `ohlc` table. Its database SHA-256 is
`F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C`, and its
maximum source date is `2026-03-03`. It is explicitly
`HISTORICAL_SNAPSHOT`, test-only, and not served by any product endpoint.

## Visual-evidence boundary

Phase 2 is a contract/server phase; it does not introduce a stock workspace.
No mock or fixture page is presented as production visual evidence. The first
stock-page screenshot is deferred to the Phase 3/4 real-data and native-workspace
acceptance gates. The executable HTTP route is covered by the six-test contract
suite, including its HTTP 200 disabled response and HTTP 400 invalid-symbol path.
