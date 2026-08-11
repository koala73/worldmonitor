# Provider Truth Matrix

This matrix is the source of truth for UI labels, API contracts, caching and fallback behavior. `LIVE` or `REALTIME_LICENSED` must never be inferred from a non-empty response.

**Phase 0 closure check (2026-08-11):** no Provider credential, plan, contractual real-time authorization, or live data path was added. Every listed capability remains at the status below until code and Provider verification prove otherwise.

**Phase 1 implementation check:** upstream synchronization, branding and build
work introduced no Provider credential, fallback, K-line payload, quote endpoint,
AIS message or trade record. The final local preview showed honest
unavailable/waiting states. All capability statuses below remain unchanged until
a later adapter contract and authorization prove otherwise.

**Phase 2 contract check:** all new stock RPC responses now carry `provider`,
`providerStatus`, `sourceUrl`, `sourceId`, `observedAt`, `fetchedAt`, `asOf`,
`delaySeconds`, `freshnessSeconds`, `isFallback`, `fallbackReason`, and
`licenseNote`. With no configured contract-backed Provider they return only
`NOT_CONFIGURED` provenance and no market values. `MARKET_CLOSED` is a defined
future status for a verified exchange-calendar/provider path, not a status
guessed by the current disabled handler.

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

## Phase 3 provider implementation check

| Capability | Implemented adapter behavior | Runtime status without a secret/entitlement | Upgrade condition | Hard prohibition |
|---|---|---|---|---|
| Massive stock bars, reference search and company news | Server-only REST adapter with per-symbol cache key, response-symbol verification, range mapping and provenance envelope | `NOT_CONFIGURED`; no returned bars | Store `MASSIVE_API_KEY` only in a server/platform secret store and complete a successful provenance-bearing request | Do not use the historical test fixture, another symbol's bars or a static array as a fallback |
| Massive minute stream | Server-only Massive WebSocket relay to same-origin SSE, ref-counted subscriptions, reconnect/backoff and per-symbol ring/cache keys | `NOT_CONFIGURED` when no key; `DELAYED_UNVERIFIED` with key but no entitlement flag | Confirm commercial display/rebroadcast rights, then set `MASSIVE_REALTIME_DISPLAY_AND_REDISTRIBUTION_CONFIRMED=true` in server-side configuration | No browser key, no claimed real-time badge and no opened stream before confirmation |
| Finnhub / Alpha Vantage | Existing provider paths may be reached only by the Phase 3 live handler as an explicit quote fallback | `NOT_CONFIGURED` unless separately configured; any returned fallback is `DELAYED_UNVERIFIED` or `MARKET_CLOSED` | Configure a suitable plan and validate actual provider response/provenance | Never use fallback quotes to invent or refill OHLC bars |
| PokieTicker SQLite | Read-only Phase 2 fixture derivation only; no Phase 3 runtime import | `HISTORICAL_SNAPSHOT` in tests only | None; it is deliberately excluded from runtime feed selection | Never label as current, delayed, licensed or exchange-real-time |

## Phase 4 UI consumption check

| UI capability | Native behavior without an authorized Provider | Condition for value-bearing display | Hard prohibition |
|---|---|---|---|
| `/stocks` priority selector | Shows only the eight predeclared navigation choices and the current symbol | A selected symbol may call Market v1; returned value display still follows the response envelope | A chip is not evidence of a current quote, a valid global listing or market availability |
| Global stock search | Empty result/explicit availability message | Provider returns a validated result with provenance | Never synthesize, cache-share or scrape a company result client-side |
| K-line, price and volume | Explicit empty chart / absent quote plus Provider status | Symbol-matching validated bars/quote from Market v1 with rendered provider/freshness state | Never show the PokieTicker fixture, a static sample, another symbol's array or an unlicensed response as a live chart |
| News particles and links | Empty state | Provider-returned news with source link and publication time | Never manufacture particles, source links or claim a news item caused price movement |
| Categories, range analysis, similar results, forecast, story | Disabled or explicitly unavailable | Phase 5 evidence and any required server response/model provenance | Never call relevance, sentiment, correlation or a simulated return a fact/causal prediction |

The Phase 4 workspace has no client-side Provider credential. Its only market
client is the existing same-origin Market v1 client; the browser does not call
Massive directly and no iframe renders either upstream application.

## Phase 5 evidence-analysis implementation check

| Capability | Implemented boundary | Runtime status without authorization | Upgrade condition | Hard prohibition |
|---|---|---|---|---|
| Provider ticker/company news | Massive server-side source validation plus source URL/UTC preservation and US exchange-time alignment | `NOT_CONFIGURED`; UI receives no invented article or particle | Configure a licensed news-capable market account and validate symbol/source/timestamp/entitlement on returned records | Do not associate common words with a ticker, invent a source or call a timestamp match a cause |
| Exchange calendar alignment | Named NYSE/Nasdaq trading calendar for current US equity handling | Deterministic no-key calculation only; no claim that it covers all listings | Supply primary exchange and timezone/calendar mapping per non-US instrument | Never silently apply the US calendar to an unknown global primary exchange |
| Model sentiment/relevance/category/causal confidence | Typed evidence-analysis contract with provider/model/prompt/version fields and explicit unavailable state | `NOT_CONFIGURED` / `NEWS_SENTIMENT_UNAVAILABLE`; no score or label is a measured result | Select an authorized analysis provider, accept applicable financial/news content terms, keep its key server-side, and persist actual returned model metadata | Never expose a client key or show sentiment/relevance/correlation as fact or causality |
| Realized T0/T1/T3/T5/T10 return | Typed output only, based on validated symbol-specific price bars | Unavailable when no verified price series exists | Provider returns validated priced bars at the requested horizons with retained provenance | Never substitute a fixture, another symbol, a forecast or a synthetic return |

## Phase 6 maritime capability matrix

| Capability | Current implementation | Provider status without key | UI wording and prohibited inference | Future secret/configuration location |
|---|---|---|---|---|
| AIS snapshot observation | Maritime v1 request through server relay, current focus bbox validation and MMSI/time filters | `NOT_CONFIGURED` / no verified snapshot | Show no vessels; AIS proves only received self-reported broadcast fields, never cargo/origin/buyer/value/discharge/BOL | Relay secret store: `AISSTREAM_API_KEY`; server runtime: `WS_RELAY_URL` and relay auth secret |
| AISStream beta transport | Existing `scripts/ais-relay.cjs`, server-only relay boundary | Disabled without `AISSTREAM_API_KEY` | Never label beta/no-SLA feed as a guaranteed real-time service; never expose key in browser | Relay process/platform secret store only |
| PortWatch chokepoint activity | Existing SupplyChain/PortWatch cache contract | Unavailable/partial if no current cache or upstream response | Preserve dataset cadence/scope; do not convert a missing response to zero traffic or minute-by-minute AIS | Existing server-side PortWatch seeder/cache configuration only |
| Official navigation warnings | Existing supply-chain/warning surface | Empty/unavailable if no official record | A warning is source-labelled information, not vessel position or cargo fact | Server-side approved source configuration only |
| Shipping v2 route intelligence | Existing model/registry route request | Explicit unavailable/error when response absent | “模型/登记册估计”，not actual vessel trajectory, arrival or cargo movement | Existing server-side service credentials if/when required |

Phase 6 added no credential and no client-side environment variable. A non-empty
response may not be labelled LIVE unless its Provider, observation/fetch time,
freshness/delay and applicable authorization are present. The user is not asked
for a key to continue Phase 7 code work.
## Phase 7 China factory/trade capability matrix

| Capability | Native behavior without an authorized Provider or reviewed data file | Condition for value-bearing display | Hard prohibition | Server-side secret/configuration location |
|---|---|---|---|---|
| Official cluster registry | Shows source URL, publisher/date availability, administrative scope and reviewed HS mapping only where present | A reviewed official/local source and separately sourced HS mapping are recorded for that cluster | Never infer product/HS, production volume or export facts from a cluster name | Versioned reviewed registry and import template; no secret |
| Country-level China HS trade | Explicit unavailable/no-record state | Same-origin Comtrade result validates reporter `156`, selected year, selected HS prefix, provider and response provenance | Never present national aggregate as town/company/port/shipment data; never replace absence with samples/zero | Existing server-side `COMTRADE_API_KEYS`; no browser key |
| Lawful China Customs aggregate import | Disabled until an owner supplies an authorized aggregate file/source with period/method | Reviewed lawful aggregate with source, release date, HS/period/scope and licence recorded | Never scrape/rebroadcast restricted records or call an aggregate a real-time manifest | Server-side approved ingestion/configuration only; no front-end secret |
| Potential/observed port ranking | `MODELLED_ESTIMATE` unavailable; no rank emitted | A documented method plus lawful joint port/trade inputs, confidence and error bounds; observed port needs its own authoritative source | Never infer port, ship, container, buyer, route or discharge from HS/country/cluster | Server-side approved source configuration only |
| Bill-of-lading / shipment records | Explicitly unconfigured and zero records | Commercial provider contract/entitlement returns a record with provider, timestamp and permitted display fields | Never claim B/L, vessel, container, buyer or cargo facts from AIS, news, a cluster or aggregate trade | Server/platform secret store, provider-specific variable assigned only after contract |

Phase 7 added no credential, client-side environment variable, direct browser
provider request, or iframe. A value may be labelled observed only when its own
source, period, scope and freshness/delay are present; historical data remains
historical and cannot be called live.
