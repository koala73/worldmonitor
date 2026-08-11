# Data Lineage Baseline

## Legacy PokieTicker historical snapshot

| Attribute | Value |
|---|---|
| Source repository | `owengetinfo-design/PokieTicker` at `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` |
| License | MIT; attribution and license text must be preserved for any incorporated code/data use |
| Source path | `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪\data\pokieticker\pokieticker.db` |
| SHA-256 | `F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C` |
| Tables | `ohlc`, `news_raw`, `news_ticker`, `news_aligned`, Layer 0/1/2 results, tickers, batch records |
| OHLC coverage | 53,025 rows; max `date` is `2026-03-03` |
| Truth status | `HISTORICAL_SNAPSHOT` |
| Allowed use | Offline historical research, analysis backfill, test fixtures under explicit isolation |
| Prohibited representation | Current market quote, licensed real time, exchange-delayed guarantee, or fallback without an explicit historical label/reason |

## Planned WorldMonitor-native data paths

| Domain | Proposed formal path | Minimum lineage/label |
|---|---|---|
| Stock bars and quotes | Market v1 service and server-side relay | Provider, authorization/freshness status, symbol validation, observed/fetched/as-of times, fallback reason |
| Company news | Provider ticker links, WorldMonitor entity mapping, IR/exchange/regulator sources | Source URL/ID, publication time, entity link confidence, trading-session alignment |
| AIS | Existing WorldMonitor maritime/relay architecture | AIS source, packet time, fetch time, freshness and self-reported-field label |
| Port activity | PortWatch/official data adapters | Dataset release/update time, geographic scope, methodology/estimate label |
| Trade / China factory | UN Comtrade, lawful China customs imports, official local-cluster evidence | Reporting period, reporter/partner/HS, source batch, unit/currency, `OBSERVED_OFFICIAL` / `MODELLED_ESTIMATE` / `BILL_OF_LADING_OBSERVED` |

No upstream website is framed or embedded as a substitute for an owned data pipeline.

## Phase 0 recovery-audit boundary

The recovery audit copied only three non-secret project metadata files to a Codex-created temporary directory for a byte-for-byte readability check. It did not import the PokieTicker database, historical OHLC, news, credentials, or any legacy runtime file into the WorldMonitor mother repository. The resulting product data lineage therefore remains unchanged from this baseline.

## Phase 1 blocked-state boundary

## Phase 2 historical-fixture isolation

The only PokieTicker data committed in Phase 2 is a 12-row test fixture at
`tests/fixtures/market/recorded-historical-bars-v1.json`. It was derived from a
read-only query of the previously locked `ohlc` table for AAPL, MSFT, NVDA and
TSLA (three dates each). The fixture preserves the database SHA-256,
repository/commit, MIT license and `HISTORICAL_SNAPSHOT` status. It is isolated
to tests, is not read by a production handler, and explicitly says it is not a
live, delayed, or licensed real-time feed.

## Phase 1 implementation boundary

The upstream baseline is now integrated on the isolated branch, but Phase 1 did
not activate a market, news, AIS, port, trade or AI Provider. The final local
preview displayed unavailable/waiting states where credentials or live upstream
data were absent. No OHLC array, quote, trade event, AIS report or generated
news relationship was added. The PokieTicker record is only the SHA/license
trace at `third_party/PokieTicker/UPSTREAM.md`; the legacy SQLite snapshot
remains outside Git and retains `HISTORICAL_SNAPSHOT` status.

No data path was activated while upstream synchronization is blocked. In particular, the legacy backup’s nested WorldMonitor repository was inspected read-only and not copied into the formal mother workspace; its generated-file modifications are not product data and cannot serve as an upstream provenance substitute.

## Phase 3 authorized-stock path

The production candidate now has an inactive, server-only market path:
Massive REST aggregate/reference/news responses enter
`massive-stock-provider.ts`; minute aggregate messages enter
`market-stream-relay.ts`; normalized results pass the Phase 2 provenance,
symbol, timestamp and OHLC guards before they can reach Market v1 responses or
same-origin SSE. The output records provider/source URL, observed/fetched/as-of
times, freshness/delay when known, authorization status, fallback state and
license note.

No Massive credential was present during Phase 3. Therefore no actual provider
record, live price, live bar, latency measurement or stream screenshot is in
the repository evidence. Recorded AAPL/MSFT/NVDA/TSLA values are the locked
PokieTicker `HISTORICAL_SNAPSHOT` fixture used solely by automated tests; the
runtime adapter does not read that file. Any future Finnhub/Alpha Vantage value
is quote-only, explicitly labelled as a fallback and cannot become a bar
source. News remains source-linked information; its association with a symbol
does not assert a market cause.

## Phase 4 stock-workspace display boundary

The Phase 4 browser workspace does not add a market-data source. It consumes
only Market v1 envelopes; when that client returns `NOT_CONFIGURED`, no
historical fixture, cached sample, shared-symbol series, generated company
metadata, invented news particle or prediction crosses into the UI. The D3
chart's empty state is therefore a data-lineage result, not a placeholder that
can later be mistaken for a price chart.

The eight first-choice ticker chips are product navigation preferences, not
data records. A user search is a Provider query whose empty output stays empty.
Any future visible bar/quote/news item must retain its provider, source URL or
ID, observed/fetched/as-of fields, delay/freshness, fallback state and license
note all the way from the Phase 3 server adapter to the Phase 4 display.
