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

## Phase 9 operational-control implementation

| Operational lane | Control-center state without an executor | What becomes visible only after an authenticated executor reports it | Explicit prohibition |
|---|---|---|---|
| Stock REST gap repair / minute stream | `NOT_CONFIGURED` on desktop missing keys; `SERVER_MANAGED_UNKNOWN` in web | executor success/failure time, rate-limit/quota and symbol-specific provenance | Do not treat scheduler completion, a quote, cache from another symbol or a retry click as a verified K line |
| News ingest / Layer 1 analysis | no executor, queue/dead-letter are `未观测` | source-preserving article batch, model/version/time/sample and queue/dead-letter metrics | Do not turn relevance, sentiment or alignment into causal price proof |
| AIS relay | no executor, messages/vessels/freshness are `未观测` | relay health and only validated source/timestamp/range observations | Do not infer cargo, origin, buyer, port call, ETA or B/L |
| PortWatch / Comtrade / China Customs | no executor/import, release and batch metrics are `未观测` | provider release or lawful import metadata, scope, period and permitted aggregate records | Do not use a missing response as zero trade, or aggregate data as factory/ship facts |
| Model evaluation | no executor, version/training/sample/backtest are `未观测` | separately versioned evaluation metadata and evidence-bearing metrics | Do not show a model-quality/training claim without its actual record |

The control surface intentionally does not expose a secret, a tail string, a
hash usable for offline guessing, a vault value, a server token or a browser
Provider key. `SELF_HOSTED_MODE=true` is a server-side mode that disables cloud
fallback; it does not grant a Provider plan or bypass licensing.

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

## Phase 8 layout and posture capability matrix

| Capability | First-use native behavior | Condition for an observed/live-facing label | Hard prohibition | Manual action / secret location |
|---|---|---|---|---|
| Full dashboard priority | Existing full panel ownership places Markets/stock workspace first and posture tools last | Not data-bearing; user-created order always wins once saved | Never replace a user layout or create a parallel dashboard to force a new order | Clear/reset layout only through the existing user interface |
| Military correlation/posture | Retained at tail, collapsed, with readiness notice | Its own Provider/source/time record or official release supports any factual statement | Never turn a layer toggle, correlation card, AIS point or stale cache into a real-time military observation | Optional OpenSky relay values stay in Desktop/server protected store: `VITE_OPENSKY_RELAY_URL`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` |
| Server military-flight source | Readiness notice says it awaits a sourced/timestamped response | Server returns a permitted record with source and valid observation time | Never call an empty/error state, static list or heuristic classification a live flight feed | Confirm server authorization/provider terms and response provenance; no browser secret |
| Aviation positions | Retained at tail, collapsed, with no header `LIVE` by default | Fresh provider-attributed position no older than five minutes and not future-dated; header says `OBSERVED`, not an entitlement claim | Never let a map-layer toggle alone show `LIVE`; never present stale/delayed data as real time | Optional OpenSky relay as above, server-side/desktop only |
| Airport/flight operational metadata | Airline notice describes it separately from positions | Authorized Provider response carries source/update time and applicable cadence | Never merge airport, price, news or tracking data into one real-time claim | `AVIATIONSTACK_API` stays in protected desktop/server store; validate licence first |

Phase 8 reads only presence/validity state through the existing runtime
configuration boundary. It does not expose plaintext secrets, tail hashes,
provider payloads or client-side keys.

## Phase 10 desktop runtime capability matrix

| Capability | Packaged / observed state | Condition for data-bearing success | Hard prohibition | Secret / licensing boundary |
|---|---|---|---|---|
| Native application shell | Installed Tauri 2 application, branded window and duplicate-safe launcher verified | Not data-bearing; native process and local sidecar are independently observable | Never use a bare release executable, legacy Express service or iframe as a substitute for the packaged app | No Provider key required |
| Local API Node runtime | Official Node 22.14.0 package checksum/binary hash verified; `LICENSE` shipped with sidecar; loopback-only sidecar started | Local sidecar's own source-bearing endpoint result | Never call sidecar start, a port listener or a package checksum a market/news/AIS Provider success | Node license carried with packaged runtime; no frontend secret |
| Market/stock display | Fail-closed visible error with no market Provider | Licensed response with matching symbol/provider/exchange/observed-or-as-of time/delay and display/rebroadcast right | Never fill failure with an arbitrary K-line, shared cache, quote-only OHLC repair or `实时` label | Protected desktop/server Provider store only; no `VITE_*` secret |
| AIS/maritime display | No provider observation established by desktop delivery | Authorized AIS relay result with source/time/freshness/range fields | Never infer cargo, B/L, buyer, port call or route fact from sidecar availability | `AISSTREAM_API_KEY` server/relay protected store only |
| Provider control center | Native entry exists, but no executor is asserted | Registered protected executor returns auditable result and provenance | Never let a button or desktop installation imply a request/success | Existing protected settings path only |

Phase 10 did not add a Provider credential, endpoint impersonation, client-side
secret or live-data claim. The native window's `加载市场数据失败` result is an
intentional absence-of-observation display, not a zero-price or no-market fact.

## Phase 11 acceptance effect on Provider states

| Provider-facing area | Phase 11 verified behavior | What it does **not** establish |
|---|---|---|
| Finance market workspace | Complete Finance browser and visual paths pass while no-provider display stays fail-closed. Variant boot cannot silently fall through to a generic chart. | A quote, OHLC bar, exchange entitlement, real-time label, symbol observation or display/rebroadcast permission. |
| AIS / maritime | Sidecar and data suites verify backoff, timeout, stale-health and accepted-frame boundaries. | A current AIS position, vessel identity, cargo, bill of lading, port call, destination or trade fact. |
| News / correlation | Storage failure, hydration and source-setting paths are exercised without changing attribution language. | A causal claim from event co-occurrence, sentiment or headline relevance. |
| Map visual fixtures | Local deterministic features are limited to an explicit E2E harness and named seed inputs. | A basemap, conflict observation, Provider response or production-source endorsement. |

Phase 11 adds no key, endpoint, subscription, entitlement or client-side
secret. Every row needing a source-bearing response remains disabled/unknown
until its protected Provider action is completed.

## Phase 12 publication effect on Provider states

Publishing an integration branch or opening a Draft PR changes source-control
visibility only. It does not enable a Provider, create a credential, modify an
entitlement, start a feed, or change any disabled/no-observation state. The PR
must preserve every source/time/delay/license requirement already recorded in
this matrix; a remote commit and passing CI are not Provider evidence.

## Phase 12 publication transport block

The absence of a successful Git push/PR is a source-control transport state,
not a Provider state. It neither downgrades nor upgrades any provider row. In
particular, do not compensate for a blocked publication by exposing a secret,
enabling a feed, changing a data label or substituting test evidence for a
source-bearing response.

## Phase 12 completed publication effect on Provider states

The previous source-control transport block is resolved: the integration
branch was pushed normally and Draft PR
[#1](https://github.com/daking32168-byte/worldmonitor/pull/1) was created.
That outcome changes no Provider row. No key, plan, entitlement, display right,
redistribution right, observation, queue, source time or freshness evidence was
added during publication.

| Publication-time item | Final Phase 12 state | Truth-preserving consequence |
|---|---|---|
| Market bars/news/model Providers | Still unconfigured unless separately owner-provisioned | Stock charts and event analysis must remain unavailable/fail-closed without a symbol-matching source-bearing response; no historical/delayed result may be labelled real-time. |
| AIS/maritime Providers | Still unconfigured unless separately owner-provisioned | No AIS observation proves cargo, buyer, bill of lading, discharge, origin or shipment value. |
| Company-monitoring worker | Not advertised by public health | Keep the health capability dark until an actual Railway deployment and health response are recorded. |
| Source registry licensing | 533 active hosts; 519 marked `terms-review` | A registry entry or passing source check is not a licence. Owner/legal review remains required before restricted display/rebroadcast. |
| npm dependency advisory | One moderate advisory observed | No Provider state changes; do not apply an unsafe forced upgrade solely to hide the advisory. |

The Draft PR is source-control review evidence only. It is not Provider
activation, a successful request, production deployment or a data-bearing
acceptance result.

## Phase 12 health-correction effect on Provider states

| Capability | Current public state | What is still required before promotion |
|---|---|---|
| FRED rates seeder | Dark in public `/api/health`; strict status remains available only through the operator `api/seed-health.js` surface | A real scheduled deployment, protected seed execution, persisted coverage/freshness evidence and a successful operator health response. Historical or delayed FRED data must retain its actual observation/retrieval timing. |
| Company-monitoring worker | Dark in public health | A real Railway deployment and source-bearing health result; generated OpenAPI coverage alone is not runtime availability. |
| Market / K-line Providers | Unchanged and fail-closed when unconfigured | Symbol-specific licensed bars with exchange, interval, observed/as-of time, delay/real-time entitlement and display/redistribution scope. No generated contract or CI run supplies a price. |

The OpenAPI operation count rising to 222 records documented interfaces, not
222 available data feeds. Cross-platform generation, a sub-950 KB machine
artifact and passing schema tests do not change any Provider credential,
licence, entitlement, delay label or source-bearing observation.

The independent dashboard metadata correction likewise changes presentation
identity only. Removing upstream pricing/founder/social claims does not create
a Provider, licence, account, payment state, feed or current observation.

## Phase 12 run 6 correction effect on Provider states

The failed docs-stat and HTML-build jobs carried no source-bearing response.
Regenerating the public-health count and separating official variant discovery
links from the independent shell changes neither credential nor entitlement.

| Corrected surface | Provider-state effect | Required truth boundary |
|---|---|---|
| Tracked public-health statistics | None; generated count now matches the already-correct public list of 257 capabilities | A count is documentation, not deployment or observation evidence. FRED and company monitoring remain dark. |
| Independent base `hreflang` | None; zero upstream official alternates | The independent dashboard must not claim upstream service identity or availability. |
| Official variant discovery links | None; two links are generated only on the separately declared official variant page | Canonical/discovery metadata does not prove a quote, market bar, AIS fix, news event, licence or live endpoint. |
| GitHub run 6 | None | Five successful workflows and ten successful Test jobs cannot promote a Provider; the overall Test failure remains recorded. |

Market/K-line data therefore remains fail-closed without symbol-specific,
licensed and time-labelled source responses. Nothing in this correction may be
displayed as real-time market data or deterministic news causality.

## Phase 12 run 7 correction effect on Provider states

| Corrected contract | Provider-state effect | Retained boundary |
|---|---|---|
| Eight stock OpenAPI operations and descriptions | None | Described symbol/time/news fields are interfaces, not observed prices or articles. |
| Six arbitrary-symbol MCP parity exclusions | None | `fetch-on-miss: high-cardinality-input` records why fixed-universe MCP cache tools cannot truthfully cover arbitrary symbols. |
| Forecast and similar-event parity exclusions | None | `deferred-to-future-tool` matches their disabled runtime; no prediction/model result is synthesized. |
| Eight stock cache tiers | None | Explicit cache policy cannot turn an absent or historical response into licensed real-time data; keys remain symbol-qualified. |
| Public `VITE_SELF_HOSTED_MODE` allowance | None | This boolean posture flag is not a credential. All Provider/API secrets remain forbidden from the client bundle. |
| GitHub run 7 | None | Five standalone workflows passed and Test failed; neither result provisions an account, entitlement, deployment or observation. |

Market/K-line Providers remain `NOT_CONFIGURED` or their accurately labelled
licensed/delayed state until an owner supplies lawful credentials and display/
redistribution entitlement. AIS, cargo, news-cause and trade/factory states are
unchanged and no fallback data was added.
