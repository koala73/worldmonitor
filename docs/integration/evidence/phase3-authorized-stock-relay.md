# Phase 3 — Authorized Stock Relay Evidence

**Date:** 2026-08-11
**Working branch:** `integration/pokieticker-maritime-china-factory`
**Implementation commit:** pending backfill after the implementation commit
**Scope:** server-only provider adapter/relay, market session/status integrity,
symbol isolation, no-key/no-entitlement behavior and automated gates.

## Delivered boundary

- `massive-stock-provider.ts` maps documented Massive aggregate, reference and
  news responses through Phase 2 contracts. It requires exact requested-symbol
  agreement and never selects another ticker's array.
- `market-stream-relay.ts` owns the Massive stock WebSocket on the server and
  forwards normalized, subscribed symbol-specific messages over same-origin SSE.
  The upstream API key is not serialized to a client event.
- `api/market/stream.ts` returns `503 PROVIDER_STATUS_NOT_CONFIGURED` without
  `MASSIVE_API_KEY`; a present key without the explicit commercial-entitlement
  flag returns `409 DELAYED_UNVERIFIED`. These are deliberate, honest denied
  states, not an empty successful stream.
- US equity session calculation handles weekends, full named closures and
  early closes. Bar validation rejects cross-symbol data, duplicate timestamps,
  invalid OHLC/volume and a six-bar identical traded flatline.
- Existing Finnhub/Alpha Vantage paths are quote-only fallbacks. They cannot
  fabricate, replace or fill a Massive bar series.

## Commands and results

| Command / check | Exit | Result |
|---|---:|---|
| Connected GitHub app: read `daking32168-byte/worldmonitor` and `koala73/worldmonitor` | 0 | Both repositories readable; origin reports admin/maintain/push permission and upstream reports read-only access. |
| `git -c http.version=HTTP/1.1 fetch --no-tags origin main` | 0 | Origin SHA remained `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`. |
| `git -c http.version=HTTP/1.1 fetch --no-tags upstream main` | 0 | Upstream SHA remained `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`. |
| `npm run typecheck:all` | 0 | Type check passed. |
| `node --import tsx --test tests/stock-data-contract.test.mts tests/stock-realtime-adapter.test.mts` | 0 | 14 of 14 tests passed. |
| Phase-scoped Biome lint over Phase 3 source/API/test paths | 0 | No lint error in the Phase 3 diff. |
| `npm run security:vite-env-secrets -- --strict-local` | 0 | No client/Vite secret exposure found. |
| `npm run lint:api-contract` after registering SSE exception | 0 | 149 API files, 114 manifest entries and 96 query parameters validated. |
| `npm run sources:generate` | 0 | Windows path guard fix caused the generator to execute and refresh source artifacts. |
| `npm run sources:check` | 0 | 533 active hosts; 293 structured/API, 268 feed, 30 operational-status; 519 terms-review. |
| `npm run build:full` | 0 | Production build completed; only normal dynamic-import/chunk-size warnings observed. |
| `npm run lint` whole tree | 1 | Existing upstream-wide diagnostics remain outside this Phase 3 diff; this is not recorded as a Phase 3 pass. The scoped gate above passed. |

## Truthfulness and manual live-acceptance boundary

No `MASSIVE_API_KEY`, plan receipt, credentials, browser login, paid-service
acceptance or display/rebroadcast authorization was provided to this task. For
that reason this evidence does **not** claim any current price, real-time
latency, delayed-feed interval, working production chart or browser screenshot.
The historical fixture checks only the adapter's ability to preserve distinct
valid shapes; it never flows through a production handler.

Before the status may become `REALTIME_LICENSED`, the user must complete the
manual action described in `MANUAL_ACTIONS.md`. Then a visible acceptance run
must save provider provenance/timestamps and screenshots for AAPL, MSFT, NVDA,
TSLA, AMZN, GOOGL, META and BABA. It must verify that each chart's own symbol,
prices and time range are returned by the authorized feed. News can be linked
to a time window and source, but must not be labelled as the proven cause of a
price movement.
