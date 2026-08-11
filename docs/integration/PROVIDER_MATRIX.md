# Provider Truth Matrix

This matrix is the source of truth for UI labels, API contracts, caching and fallback behavior. `LIVE` or `REALTIME_LICENSED` must never be inferred from a non-empty response.

**Phase 0 closure check (2026-08-11):** no Provider credential, plan, contractual real-time authorization, or live data path was added. Every listed capability remains at the status below until code and Provider verification prove otherwise.

**Phase 1 implementation check:** upstream synchronization, branding and build
work introduced no Provider credential, fallback, K-line payload, quote endpoint,
AIS message or trade record. The final local preview showed honest
unavailable/waiting states. All capability statuses below remain unchanged until
a later adapter contract and authorization prove otherwise.

**Phase 1 preflight check (blocked):** the current block is local source synchronization, not a Provider credential. No Provider, fallback, K-line payload, quote endpoint, AIS message, or trade record was introduced while the upstream fetch gate is unavailable.

| Capability | Provider / source | Current status | What may be displayed | What may not be displayed |
|---|---|---|---|---|
| US stock real-time bars/quotes | Massive or equivalent licensed provider | `NOT_CONFIGURED` | Configuration requirement and disabled state | Real-time/minute price or a synthetic bar |
| Stock fallback quotes | WorldMonitor Finnhub chain | `NOT_CONFIGURED` pending key/plan verification | Disabled state or provider contract when configured | Licensed-real-time status without contractual proof |
| Stock fallback quotes | WorldMonitor Alpha Vantage chain | `NOT_CONFIGURED` pending key/plan verification | Disabled state or documented delayed/EOD capability | Real-time status without plan evidence |
| Legacy stock OHLC/news | PokieTicker SQLite snapshot | `HISTORICAL_SNAPSHOT` | Historical research bars, snapshot date, source and fallback reason | Current/live quote, exchange-real-time, or guaranteed freshness |
| Yahoo chart endpoint used by legacy app | Unlicensed dynamic endpoint | `DELAYED_UNVERIFIED` at most | Only if retained after legal/provider review, with actual fetched time and non-guaranteed delay | Default commercial/rebroadcast real-time source |
| AIS vessel messages | AISStream | `NOT_CONFIGURED` | Setup instructions; when configured, AIS-reported position/heading/speed/destination field plus freshness | Cargo, production origin, buyer or actual discharge as an AIS fact |
| Port activity | IMF PortWatch | `NOT_CONFIGURED` / dataset cadence pending | Dataset timestamp and port activity/estimate | Second-by-second AIS or bill-of-lading fact |
| National/product trade | UN Comtrade | `NOT_CONFIGURED` pending key/configuration | Periodic reported trade with source, period and units | Industrial-town-to-specific-vessel certainty |
| China customs regional trade | User-lawfully-exported data | `NOT_CONFIGURED` | Imported official-statistics batches with lineage | Unverified scraped or inferred figures as official facts |
| Bill of lading | Contracted commercial provider | `NOT_CONFIGURED` | `BILL_OF_LADING_OBSERVED` only after a contract-backed source returns records | Specific shipper/consignee/vessel shipment chain without authorization |
| AI news analysis | Supported model provider | `NOT_CONFIGURED` | Explicit heuristic/insufficient-data result and model metadata if configured | A fixed model narrative as fact or causal proof |

## Required response fields

Every market, news, AIS, port and trade response must carry: `provider`, `providerStatus`, `sourceUrl` or `sourceId`, `observedAt`, `fetchedAt`, `asOf`, `delaySeconds` when known, `freshnessSeconds`, `isFallback`, `fallbackReason`, and `licenseNote`.

No Phase 0 artifact includes a Provider secret, an OHLC array, a fabricated price series, or an iframe to an upstream application.
