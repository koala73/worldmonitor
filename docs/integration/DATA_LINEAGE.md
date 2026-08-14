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

## Phase 5 news-to-market evidence boundary

A future provider article enters Market v1 only after symbol, source URL and
UTC publication-time validation. `StockNewsAlignment` then retains both the
original UTC time and an exchange-local time, named alignment rule, session and
aligned trading date. For the current US equity implementation, the calendar is
NYSE/Nasdaq; unknown/non-US primary exchanges are not silently treated as US.

`StockNewsAnalysis` is a separate lineage branch. Without an authorized model
provider it records an explicit unavailable status and no evidence-derived
sentiment, relevance, category, causal confidence or realized return. When
future analysis is enabled, the provider/model/prompt/version/generated time,
source links and actual return calculations must be retained. The actual return
branch itself may read only validated symbol-specific bars, never a fixture,
forecast or cross-symbol cache. The consumer wording remains “possible
influence” or “consistent with the period” at most; no lineage field can prove
causation.

## Phase 6 maritime and supply-chain boundary

The native maritime page has three deliberately separate lineage branches:

1. **AIS observation branch.** `scripts/ais-relay.cjs` may receive AISStream
   messages only after a server-side key is configured. Maritime v1 provides
   the candidate report fields; the browser retains only valid MMSI, name/type
   when provided, latitude, longitude, speed, heading/course and report time
   inside the selected bbox. It records/labels receipt and freshness when the
   upstream response supplies them. It cannot produce cargo, origin, buyer,
   value, final discharge, bill-of-lading, destination, ETA, draft or IMO facts
   that the contract has not supplied.
2. **Port activity and warning branch.** SupplyChain/PortWatch values are
   source aggregates with their own dataset release/update cadence, geographic
   scope and method. An official navigation warning remains a separately
   sourced alert. Neither is transformed into point AIS or cargo evidence.
3. **Route-intelligence branch.** Shipping v2 returns a model/registry route
   assessment with input country/cargo categories and source status. It is
   labelled as an estimate and cannot be joined to an AIS MMSI as an actual
   vessel trajectory or shipment fact.

During Phase 6 no relay snapshot or Provider response was configured. The
observed browser lineage is therefore `NOT_CONFIGURED` / no verified snapshot;
the zero-marker display means no verified record was received, not zero ships
in the real world.

## Phase 7 China industrial-cluster export lineage

Phase 7 has four non-interchangeable branches:

1. **Official cluster-recognition branch.** The reviewed registry holds the
   official/local source URL, publisher, publication-date availability and
   administrative scope for an industrial cluster. It establishes recognition
   only. The MIIT 2024 reference entries have no assumed product/HS mapping and
   are marked `statisticsEligible=false`.
2. **HS-mapping branch.** A cluster may request trade only after a separately
   recorded, reviewed HS source supports the mapping. The Huidong and Putian
   footwear entries use HS 64. This mapping is a product-class boundary, not a
   company-, town-, port- or shipment-level observation.
3. **Observed aggregate trade branch.** The client asks the existing
   same-origin Comtrade boundary and accepts only a returned China reporter
   `156`, selected period and selected HS-prefix record with a finite
   non-negative value. It retains country destination and provider provenance
   when returned. It is historical/aggregate at its source cadence, never live
   customs clearance, and may not be re-labelled as a particular factory,
   export port, ship or container.
4. **Port and B/L branch.** Potential port ranking, if later enabled, is a
   documented `MODELLED_ESTIMATE` with lawful inputs/method/confidence/error.
   An observed port or bill-of-lading fact requires its own authorized,
   timestamped provider record. AIS/news/context cannot substitute for either.

During Phase 7, no authorized aggregate response, port dataset or commercial
B/L record was configured. The observed browser lineage is consequently a
source/HS view with no value-bearing trade row and no shipment facts; it does
not mean that the underlying real-world trade or shipping volume is zero.

## Phase 8 layout ownership and aviation observation lineage

Phase 8 introduces no new data Provider. Its lineage is deliberately split:

1. **Layout ownership branch.** `VARIANT_DEFAULTS.full` supplies only the
   first-use ordering. `panel-order` is an explicit user-owned preference and
   is not rewritten by the Phase 8 migration. The collapse seed applies once
   only when no order exists; it is a presentation preference, not a data
   status.
2. **Provider-readiness branch.** Military and aviation notices read only the
   existing protected runtime configuration's presence/validity state. They do
   not read, hash, return or render any secret. `NOT_CONFIGURED` means no
   verified observation is currently available; it does not state that no real
   aircraft or military activity exists.
3. **Aviation observation branch.** A position becomes an `OBSERVED` header
   badge only after it supplies a non-empty Provider source and valid
   `observedAt` not later than the client clock and no older than five minutes.
   The map-layer enabled flag is merely a request state and cannot enter this
   lineage. Missing, stale, future-dated or blank-source records remain
   unlabelled/no-observation.

No Phase 8 branch proves cargo, mission, intent, ownership, military action,
passenger status or a causal event. Separate authoritative records would be
needed for any such assertion.

## Phase 9 provider-operation and scheduler lineage

Phase 9 adds an operational-control lineage, not a new data source:

1. **Configuration-presence branch.** The web surface can only state that a
   protected desktop key is present/valid or that a server-managed configuration
   is not observable. It receives no secret plaintext, tail, content-derived
   fingerprint or token. Configuration readiness is not Provider health.
2. **Scheduler branch.** Existing dashboard callbacks may record their own
   completion/failure time. That only proves a local callback outcome; it does
   not populate `lastExecutorSuccessAt`, Provider provenance, a K-line,
   freshness, queue count or data value.
3. **Executor branch.** A future server/sidecar executor must pass the
   operation's idempotency, lock, minimum retry and rate-limit controls, then
   return an explicit result. Success/failure/rate-limit time, quota, queue,
   dead-letter, AIS-message and vessel metrics remain absent until that result
   exists. A failure preserves the separate last-success time and cannot
   silently replace data with an empty set.
4. **Self-host deployment branch.** `SELF_HOSTED_MODE=true` is a
   server-configuration lineage input that forces cloud fallback off. The
   local control API remains guarded by `LOCAL_API_TOKEN`; the browser cannot
   infer a third-party Provider account, licence, database content or operator
   identity from either switch.

Thus Phase 9 creates no factual market, news, AIS, port, trade, Customs or
model record. Any future such record must independently carry Provider/source,
observed/fetched/as-of time, delay/freshness, fallback reason and licence
boundary before it reaches a user-facing claim.

## Phase 10 desktop-package and local-sidecar lineage

Phase 10 adds an executable-delivery lineage, not a data-provider lineage:

1. **Artifact branch.** The source Tauri configuration, frontend `dist` output
   and first-party sidecar files produce a local NSIS installer. Its SHA-256,
   size and installed binary path identify an artifact, but establish no fact
   about external data.
2. **Runtime branch.** The official Node archive checksum, copied executable
   checksum and bundled MIT LICENSE establish the integrity and license posture
   of the local interpreter. They do not establish a stock price, source
   response, Provider account or entitlement.
3. **Local-service branch.** A branded native process starts the first-party
   local API sidecar on a loopback-selected port. The process/path/port evidence
   proves local availability only. It cannot make a failed, empty, stale or
   unconfigured upstream request become a market/AIS/news/trade observation.
4. **Display branch.** In the observed no-provider installation, the market
   panel produced `加载市场数据失败` and premium views requested authentication.
   This empty/degraded state remains the terminal display lineage. No K-line,
   event, sentiment, price, vessel or trade value crosses it without the
   independent source-bearing branches established in earlier phases.

The desktop package never carries a frontend Provider secret. Existing desktop
keychain injection reported zero secrets during verification; any future
protected secret remains a configuration prerequisite, not data provenance.

## Phase 11 acceptance and test-fixture lineage

Phase 11 adds no external-data lineage. Its acceptance inputs are code,
versioned source fixtures, local browser rendering, recorded command output and
golden-image comparisons:

1. **Fixture branch.** The map harness owns named deterministic features and a
   tile-free test-only style. These are test inputs, not Provider records, and
   never cross into production routes or provider-facing labels.
2. **Runtime-boundary branch.** Valid URL coordinates, user-pan clearing,
   storage-unavailable analytics handling and syntax-valid pre-paint selection
   preserve rendering. They do not attach source, timestamp or license to any
   bar, event, vessel, headline or factory entity.
3. **Acceptance branch.** E2E, DOM, sidecar, contract, lint, type and build
   logs prove behavior at their recorded run time. A passing screenshot proves
   only that a local deterministic render matched its reviewed baseline.
4. **Provider branch remains closed.** A data-bearing market, AIS, news, cargo,
   trade or factory assertion still needs a separately licensed source-bearing
   response with observation/as-of time, delay and provenance. No Phase 11
   artifact substitutes for that route.

## Phase 12 publication-provenance lineage

Phase 12 adds version-control provenance only:

1. **Local branch evidence.** The integration branch name, commit parents,
   remote URLs and `origin/main` ancestry are source-control metadata recorded
   in `phase12-publication-preflight.md`.
2. **Connected-GitHub evidence.** Repository permission/default-branch
   metadata and the independent upstream-main commit lookup establish where a
   Draft PR may be opened; they do not establish product-data lineage.
3. **No data-bearing branch.** A pushed commit, PR URL or CI result must never
   be treated as a market observation, K-line, AIS message, shipment/cargo
   fact, news causal conclusion, trade statistic or factory fact. Those
   branches remain closed until their separate source-bearing records exist.

## Phase 12 transport-block lineage

The block adds operational provenance, not product data: the recorded facts
are HTTPS reset/connection failures, the SSH `publickey` denial, the successful
read-only owner-main verification and the absence of the remote integration
branch. These are release-transport observations only. They cannot be reused
as evidence for a financial price, K-line, AIS/vessel/cargo event, news causal
claim, trade value, factory status or Provider entitlement.

## Phase 12 completed publication lineage

The source-control transport branch now has a complete, independently checked
chain:

1. **Local source object.** The clean acceptance worktree identified published
   source commit `ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401` and protected
   owner-fork base `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`.
2. **Native Git transfer.** A normal non-force refspec created only
   `origin/integration/pokieticker-maritime-china-factory`. Its temporary
   endpoint routing came from GitHub's official `/meta` Git list and changed no
   durable repository/network configuration.
3. **Connector verification.** The authenticated GitHub integration fetched
   the exact remote commit, then created Draft PR
   [#1](https://github.com/daking32168-byte/worldmonitor/pull/1) with the same
   head and protected base SHA.
4. **Evidence artifact.** The final local gate log is versioned at
   `docs/integration/evidence/phase12-full-prepush-20260814.log`, SHA-256
   `9E87ECA6E4CE73E9F51A5E406C7AB58042D604074BC1C6741D95DDF7EF09347A`.

This lineage terminates at source-control publication. It does not cross into
market/AIS/news/trade/factory/model data lineage. No Provider secret, response,
observed/as-of time or entitlement was created, and a Draft PR cannot supply
those missing facts.

## Phase 12 correction lineage

The corrective chain adds two kinds of engineering evidence without creating
product-data observations:

1. **Health-claim correction.** Commit
   `b33b927cf0f368766114883ab73bae5598a77ed8` removes a planned FRED seeder
   from public health. The operator-only seed state remains the only admissible
   source for unavailable/partial/ready coverage, and no seed response is
   invented.
2. **Contract regeneration.** Commit
   `afc315b8992946e91aacee150da753ab0d7955ea` repairs Windows path handling
   and regenerates OpenAPI from the locked proto/toolchain inputs. The
   resulting 222 operations and 204 GET operations describe interfaces; they
   are not observations or availability claims.
3. **Machine-artifact preservation.** Equality-checked `$ref` reuse produces a
   949,508-byte public JSON artifact. The test expands every transformed ref
   and compares the result with the original specification; it does not alter
   source, observed/as-of, retrieval, delay or licence fields.
4. **Failure preservation.** The old remote health/proto failures and the
   134-failure Windows full-suite log remain in the record. Only a fresh remote
   corrected-head workflow can establish Ubuntu CI status.
5. **Identity separation.** Commit
   `6611394a8992bdebd9764cbef1790b3c6e644ea5` removes upstream service identity
   from the independent shell's machine metadata. This is attribution
   correction, not evidence that any Provider or paid upstream feature is
   available.

No item in this correction chain is a K-line bar, quote, AIS position, cargo
fact, news cause, trade value, factory observation, Provider entitlement or
deployment health response. Those data lineages remain closed until their own
lawful source-bearing records exist.

## Phase 12 GitHub run 6 correction lineage

The authenticated GitHub integration ties run 6 to exact remote source head
`7ec5ddc74b2d9e5a473b36a2c986214bc88fcd81`. Five standalone workflows and
ten Test jobs passed; Test run `31795261786` still concluded failure because
docs-stats job `94750848892` and unit job `94750911768` failed. This mixed
result is retained without aggregation into a green claim.

The descendant correction has an auditable, non-product-data chain:

1. public health source already contained 257 advertised capabilities;
2. `scripts/docs-stats.mjs` regenerated the tracked statistic from 258 to 257;
3. the independent HTML contract supplied zero upstream alternates;
4. the official variant renderer inserted its own two self-canonical discovery
   links and rejected any independent-base regression;
5. 31 focused tests and a real 2,506-module production build passed locally;
6. the raw seven-gate log was normalized to LF, stripped only of terminal
   alignment whitespace at line ends, and hashed at
   `451690CAD92CC814C3C95F3FE3394AC8C637D0A95AA4E21149E3764F1F1D18D0`.

This lineage establishes generated-metadata consistency only. It contains no
market price, K-line candle, exchange timestamp, AIS observation, cargo
manifest, news cause, trade value, factory report, Provider licence, secret or
deployment-health response. Fresh GitHub workflows must evaluate the new
source commit before Phase 12 remote acceptance can advance.

## Phase 12 GitHub run 7 correction lineage

The GitHub connector binds run 7 to exact remote head `f7c1dcf`. Five
standalone workflows passed; Test run `31796115465` failed in unit job
`94753533996`. That Linux suite's 14 failures are retained, not averaged with
23,000 passing tests into a success claim.

The correction lineage is deterministic and non-observational:

1. nine Market v1 proto files receive 27 human descriptions;
2. locked Buf/sebuf tools regenerate Market and unified OpenAPI artifacts;
3. the public JSON generator groups only canonical-equal complete property
   schemas whose local refs produce positive net savings;
4. tests expand every new ref, preserve every inline 2xx response and
   deep-compare the whole result to the source;
5. stock route-cache and MCP parity registries receive explicit entries while
   retaining per-symbol/high-cardinality and disabled-model boundaries;
6. independent product facts omit official offers, metadata URL evaluation is
   lazy, and source counts match the actual 533-host inventory;
7. a second generation produces the identical binary diff hash
   `74e05228739cd512b88a9b6801e927817c2bdaac`;
8. correction commit `ef876ff5561f0c6659ec5151c135f840956944bb`
   records the source chain after the Unicode hook passes.

This chain contains schema descriptions and control metadata only. It creates
no market observation, quote, candle, event/news fact, exchange timestamp,
Provider entitlement, AIS position/cargo fact, causal conclusion, trade value,
factory observation, secret or deployment result. Fresh GitHub CI remains the
required Linux acceptance authority.
