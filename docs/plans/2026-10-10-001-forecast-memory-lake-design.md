# Forecast memory lake: learn from the past, project the future

Status: design for owner review, 2026-10-10. Written at origin/main `d49477575b`. Nothing here is built.

Appendices (same directory, `2026-10-10-001-forecast-memory-lake/`): the 5 inventories this design rests on. `inventory-seeders-1.md` and `-2.md` cover the 217 `scripts/seed-*.mjs` ingesters, `inventory-ais-relay.md` the relay's 31 feeds, `inventory-server.md` the 40 request-time fetchers and Convex, `inventory-retained.md` the production measurements, and `inventory-upstreams.md` the archive depth and licence of 45 upstream sources.

## 1. The outcome

WorldMonitor ingests a few hundred feeds. The owner's requirement is that this data serve one purpose beyond the live dashboard: understand the past and project the future, with a probability, across everything we monitor, not a hand-picked list of questions.

The accuracy program (#8990) showed that the current forecaster cannot do this. Probabilities come from hand-set rules, no model has ever learned from an outcome, and the questions were chosen so the rules had something to say. 95% of resolved published forecasts were VOID. The program fixed the measurement: every forecast now has a fixed rule, a base-rate comparison, a replayable run and a public audit. It did not touch how forecasts are made.

Three layers are missing:

1. **Memory.** Almost everything we ingest is overwritten within hours. We cannot learn from a past we did not keep.
2. **Learning.** Nothing fits anything to history. The "correlation and corroboration" across domains the owner describes is exactly what a model learns from a long record.
3. **Open-ended projection.** 7 detectors emit forecasts on a handful of families. Every series we track should be a candidate target, and the system should decide where it has something to say.

This document designs the first layer in full, because it decides the other 2, and sets the shape of layers 2 and 3 so the lake is built for them.

The decisive constraint carries over from #8990: a projection is only a forecast if we can later check it against a feed we hold. The lake makes that cheap for hundreds of series instead of a few.

## 2. What we hold today

The inventories measured production on 2026-10-09. The short version: we keep more than we thought in one place, and far less than we need everywhere else.

### 2.1 The one real archive: forecast run snapshots in R2

Every `seed-forecasts` run since 2026-03-15 has written `deep-snapshot.json` to `seed-data/forecast-traces/`. There are 4,837 of them, 33.9 GB, about 24 a day over 209 days without a gap. Each holds the raw payload of the 31 Redis keys the detectors read, about 3 MB per run: CII scores, chokepoints, UCDP events, unrest events, cyber threats, GPS jamming hexes, news digest and insights, sanctions pressure, thermal escalation, theater posture, military inputs, prediction markets, every market quote family, BIS rates, shipping rates, correlation cards, 10 FRED series and the critical-signal bundle. Each carries the code revision that produced it. (Verified by reading one snapshot from April, July and October.)

This is 7 months of WorldMonitor's fused state at hourly resolution. It was written for replay, not for learning, but it is the same thing. It is the seed of the lake, and it is already paid for: the whole trace prefix is 72.7 GB, with the rest in world-state and per-forecast files.

Two cautions. The prefix now deletes after 400 days, so the oldest runs leave in April 2027 unless copied. And `conflict:acled:v1`, one of the 31 inputs, is filled by GDELT, not ACLED; the forecast docs' claim that snapshots hold ACLED events is wrong and will be corrected with this design.

### 2.2 Everything else

| Store | Depth | Note |
|---|---|---|
| R2 resolution receipts | since 2026-07-09, 1,265 files, 5 MB | the labelled-outcome store; kept indefinitely |
| Redis `forecast:resolutions:v1` | 1,408 rows since 2026-07-15 | hot ledger |
| Convex `intelHistory` | 37,216 rows, ingested since 2026-07-30 | 3 domains (conflict from GDELT, energy news, cross-Strait), 512-d embeddings, pruned at 180 days |
| Regional snapshots | 90 days, 8 regions, every 6 h | the only derived-state time series |
| Resilience history | restarts at every scorer version; 22 versions | the longest unbroken run is 56 days |
| CII trend history | 3 days | the only CII time series |
| News: evidence archive / accumulator / story track | 15 / 8 / 7 days | no headline older than 15 days exists outside the snapshots |
| PizzINT venue readings | 90 days | |
| GDELT dyad tension | 90 days | |
| Cross-Strait activity, China Stock Connect, China policy events | 365 / 180 / 180 days, carried across runs | |
| Market: breadth 252 sessions; SGE premiums 750 days; alert ledger persistent | | |

Every other seeded key is a snapshot that the next run overwrites: about 190 of the 217 seeders, and all 31 relay feeds. Two of the highest-signal raw streams never reach Redis at all: AIS vessel positions and Telegram message text live in relay memory and die on restart. Prediction-market prices pass through and are not kept. Travel-advisory levels, theater posture, corridor risk, NOTAM closures, OREF waves beyond 7 days and the per-country news threat summary are overwritten within hours.

Request-time feeds (the API layer) are worse: the news digest, the largest ingest we run, persists nothing beyond 15 days; the CII scorer keeps 3 days; NGA navigational warnings, SEC submissions, earnings surprises and insider filings are never recorded.

## 3. What upstream archives give us

The owner's point stands: WorldMonitor is months old, its inputs are not. Of the 45 sources researched, these matter most for backfill (full table and URLs in `inventory-upstreams.md`):

| Source | Archive | Granularity | Licence | Revisions |
|---|---|---|---|---|
| GDELT 2.0 events, mentions, GKG | 2015-02-18 | 15 min | unrestricted, any use | append-only |
| GDELT 1.0 events | 1979 | daily | unrestricted | append-only |
| UCDP GED + Candidate | 1989; candidate monthly | event, day | CC BY 4.0 | every version addressable in the API |
| IMF PortWatch chokepoints and ports | 2018-12 / 2019 | daily, 28 chokepoints, ~1,850 ports | IMF terms, commercial OK | model estimates, treat as revisable |
| gpsjam.org | 2022-02-14 | daily H3 res-4 | not stated; ask | manifest flags suspect days |
| EIA, FRED/ALFRED | decades | weekly/daily | public domain / commercial OK | ALFRED gives true vintages |
| USGS, NASA FIRMS, GDACS, NWS (IEM), ERA5 | decades | event / hourly | open | FIRMS NRT replaced after months |
| UNHCR, IDMC, ReliefWeb | 1951 / 2008 / 1996 | year, month, report | CC BY 4.0 / terms | annual revisions |
| OFAC SDN, EU consolidated list | 1994 / 2019 | per change | public | append-only change logs |
| Polymarket, Kalshi | 2020 / 2021 | market; resolved price history at 12 h | not stated | settled markets are immutable |
| VIEWS conflict forecasts | runs since 2021 | country-month | not stated | each run immutable |
| IODA | 2019 (Google), 2022 (BGP, probing) | 5 to 30 min | CAIDA AUA for raw | |
| Yahoo Finance | decades | daily | no commercial use without permission | adjusted prices rewritten |
| Cloudflare Radar | 2020; outages from 2022-09 | 15 min | CC BY-NC 4.0 | |

Three tiers follow:

- **Backfill now, licence-clean:** GDELT, UCDP, PortWatch, gpsjam (confirm), EIA, FRED/ALFRED, USGS, FIRMS, GDACS, ERA5, UNHCR, OFAC and EU sanctions, central-bank yield curves and CPI series we already pull in full.
- **Collect forward only:** AIS, Telegram, X, OREF, NOTAMs, theater posture, advisories, corridor risk, Polymarket intraday, URLhaus, AbuseIPDB. The tap in section 5 starts their history on day 1.
- **Licence-restricted:** Cloudflare Radar, Yahoo, abuse.ch, EM-DAT, OpenSky, ADS-B Exchange, ACLED via HAPI. Store privately for modelling only, never as a published target, and record the licence on every row. We hold no ACLED access; the conflict backbone is UCDP plus GDELT plus our own news archive.

## 4. Storage

Redis stays the hot cache for the dashboard. It is the wrong shape for memory: 389,240 keys, TTLs everywhere, no vintages, and every seeder treats a key as a slot.

The lake is a separate R2 bucket, `worldmonitor-lake`, holding Parquet files partitioned by dataset and date. Reasons:

- We already run R2 and its S3 client (`scripts/_r2-storage.mjs`). No egress fees. About 15 USD per TB-month.
- The data is small. Country-day aggregates over a decade are tens of gigabytes. Even raw GDELT events since 2015 are about 40 GB zipped.
- DuckDB reads Parquet on R2 directly and runs backtests over a decade on one machine. Training and analysis need no cluster.
- A separate bucket keeps the trace prefix's 400-day lifecycle rules away from the lake. The lake has no deletion rule.
- Not Convex: a document store with per-row vector cost; `intelHistory` stays as the semantic retrieval layer and gets its backfill from the lake. Not Axiom: a log store with a 14-day request-log retention and partial results on wide windows.

If a product surface later needs sub-second queries across years, ClickHouse goes in front of the same Parquet. Not now.

## 5. The lake

### 5.1 Datasets

Four kinds of rows, one schema discipline:

1. **Observations.** What a feed said. One dataset per feed family (`gdelt_events`, `ucdp_events`, `portwatch_chokepoints`, `gpsjam_hex`, `market_quotes`, `fred_series`, …). Columns: entity keys (country, chokepoint, symbol, hex, series id), `event_time`, value columns, `observed_at`, `source`, `source_version`, `licence`, `producer`.
2. **Derived state.** What WorldMonitor computed from observations: CII components, chokepoint disruption scores, GPS zone hex counts, theater posture, cross-source signals, regime labels, funnel counts. Columns as above plus `code_revision` and `inputs_digest`.
3. **Forecasts.** Every forecast any engine produced, published or shadow: question, target reference (dataset, entity, operator, threshold, horizon, deadline), probability, `engine`, `engine_version`, `decision_time`, features digest.
4. **Outcomes.** Resolutions with evidence, copied from the ledger and receipts, plus the base rate in force at decision time.

### 5.2 Two columns that make learning honest

- **`observed_at`**, distinct from `event_time`. A UCDP event dated 2024-03-02 appears in the Candidate release weeks later and is recoded in the annual GED. A model trained on the final value learns from the future. Backfilled rows carry the upstream's publication time where it exists (GDELT file timestamp, UCDP version date, ALFRED vintage, EIA release date) and `event_time` plus the documented lag otherwise. Training reads only rows with `observed_at` at or before the decision time.
- **`code_revision`** on every derived row. Live and backcast rows must come from the same code or the model trains on one distribution and runs on another. The replay tool and `deployRevision` tag from #9058 already enforce this for forecasts; the lake extends it to every derived metric.

### 5.3 Layout

`lake/<dataset>/dt=YYYY-MM-DD/part-<producer>-<n>.parquet`, Hive partitioning, one manifest per dataset with schema version, licence and row counts. Writers append; a daily compaction job merges small files. A `catalog.json` lists datasets, entities, units and the targets each dataset can resolve (section 7).

### 5.4 Writing from the live pipeline: the tap

3 hooks cover every producer:

- `runSeed()` in `scripts/_seed-utils.mjs`, which every seeder calls.
- `envelopeWrite()` in `scripts/ais-relay.cjs`, which every relay loop calls.
- The 2 API-layer producers: `list-feed-digest.ts` (news) and `get-risk-scores.ts` (CII).

Each hook writes the canonical payload once, as gzipped JSONL to `lake/raw/<key>/dt=…/`, with `{key, fetchedAt, producer, deployRevision, sourceVersion, sha256}`. A payload whose digest equals the previous write is skipped, which removes most of the volume (many keys are rewritten unchanged). The write is fire-and-forget with a bounded retry and never blocks or fails the seed; health reports that the tap runs, not whether it is complete, per the running-not-quality rule. The compaction job parses raw JSONL into the typed observation datasets.

For the 2 in-memory streams: the relay writes a 5-minute AIS frame (density grid, chokepoint crossings, military and tanker candidates, gap counts) rather than raw positions, and Telegram and X items by id with our labels, with text retained for 30 days pending the terms review in section 10.

Estimated raw volume after deduplication: 0.3 to 1 GB a day compressed, 100 to 350 GB a year. Cost is single-digit dollars a month.

## 6. Backfill

Three sources, run in parallel.

### 6.1 Our own traces (weeks 2 to 3)

Parse the 4,837 deep snapshots into the lake: 31 feeds, hourly, 2026-03-15 to now, plus every run's forecasts, world state and publish telemetry. This is a one-off DuckDB or Node job over R2. It gives 7 months of WorldMonitor-as-seen inputs and derived state with code revisions, before any upstream call is made. Copy the snapshots themselves to the lake bucket so the 400-day rule cannot take them.

Also export: Convex `intelHistory` (37,216 rows), regional snapshots and regime history (90 days), resilience history across all 22 versions, PizzINT readings, the market-alert ledger, breadth and SGE series, and the resolution receipts and ledger.

### 6.2 Upstream archives (weeks 2 to 5)

In priority order, each as a resumable job with as-of columns and a licence tag:

1. **GDELT 2.0 events and GKG, 2015 to now.** Country-day and dyad-day aggregates by CAMEO root, Goldstein, tone, and the article index. Use BigQuery for the aggregate backfill (partitioned tables, a few dollars) and the bulk files we already materialise going forward.
2. **UCDP GED 1989 to 2025 and every Candidate version.** Event rows with the version they first appeared in.
3. **PortWatch chokepoints 2018-12 to now; ports 2019 to now.** The chokepoint feed is the base for every shipping target.
4. **gpsjam 2022-02 to now**, daily hex files, rolled up to the shipping-zone boxes the GPS detector uses.
5. **EIA weekly petroleum, FRED/ALFRED series, central-bank curves, world CPI.** With vintages where ALFRED has them.
6. **USGS, FIRMS, GDACS, NWS via IEM, ERA5 anomalies**, UNHCR and IDMC, OFAC and EU change logs.
7. **Polymarket and Kalshi resolved markets** with 12-hour price history: the labelled set for the LLM engine and the benchmark for every market-adjacent target.
8. **VIEWS published runs since 2021**: the external benchmark for conflict targets.

Sources with no public history start at the tap.

### 6.3 Backcast WorldMonitor's derived state (weeks 4 to 6)

Run the live derived-metric code over backfilled inputs: CII components, chokepoint disruption scores, GPS zone counts, thermal escalation, chokepoint flows, cross-source signals. First over March to October 2026, where the traces hold the true values, and diff. That diff is the code-drift test: where the backcast disagrees with what production computed, either the code depends on something the lake lacks or the computation is not a pure function of its inputs. Fix or document before extending the backcast to 2015 for the GDELT-based components and to 2019 for shipping.

The current forecast detectors run the same way. Their outputs become features and a baseline engine, not the product.

## 7. Targets, base rates and the open-ended generator

### 7.1 The catalog is derived, not written

A target is a series in the lake, an entity, an operator, a threshold and a horizon:

`<dataset>.<field>(<entity>) <op> <threshold> within <horizon>` or `at <deadline>`

The generator enumerates the catalog from `catalog.json`: every country for `gdelt_events.protest_count` and `ucdp.fatalities`, every chokepoint for `portwatch.transits`, every zone for `gpsjam.bad_hexes`, every tracked series for prices, storage levels, yields, outages, sirens, designations, arrivals. Thresholds come from each series' own distribution (quantiles of the trailing year, multiples of the trailing mean), not from hand-set constants. Politics enters as measurable events, UCDP, GDELT 14x, OREF waves, sanctions designations, leadership and election records, never as a copied market price.

A target exists only if the lake holds the series that resolves it. That is the whole admission rule.

### 7.2 Base rates first

The first product of the lake is a base rate for every target: how often it fired over its history, by season and by regime where the data supports it. Published next to every forecast and used as the skill baseline, replacing the pooled actual rate in `scripts/_forecast-scorecard.mjs` with a per-target prior. This alone makes every forecast defensible and ends the manufactured-skill failure recorded in #9012 and #9033.

Two switches flip here: `CONFLICT_COUNT_FEED_AVAILABLE` and `UNREST_COUNT_FEED_AVAILABLE` in `scripts/_forecast-resolution.mjs` are false because the count feeds depended on ACLED. Lake-backed GDELT and UCDP count series populate those feeds, and conflict and unrest forecasts return to hard resolution instead of the judged lane. (GDELT counts are reported events, not ground truth; the target says so.)

### 7.3 Learned models

For each target family, a conditional model over lagged lake features: start with regularised logistic regression and gradient boosting, walk-forward by time, grouped by entity. Features are the backcast derived state and raw observations across domains, which is where cross-domain correlation is learned rather than assumed. The score is Brier skill against the target's base rate, with the family bootstrap interval the scorecard already computes. A family is promoted to publication only when its walk-forward interval lies above 0. Short horizons on measurable series are where this will work first; long-horizon political outcomes will mostly stay at base rate, and the system should say so.

### 7.4 The LLM engine

A second engine: retrieval over the lake and the news archive, a forecasting prompt per target, a probability out. Published work gets retrieval-augmented LLM forecasters near crowd accuracy on some questions; our data is the retrieval. The resolved Polymarket and Kalshi set is its training and evaluation corpus. It runs through the same ledger with its own `engine` tag and is held to the same promotion rule. It replaces the deferred #5093 ensemble.

### 7.5 What the user sees

Forecasts where an engine's probability departs from the base rate by a margin, across every domain the lake covers, each with its base rate, its engine, its track record by family, and the series that will resolve it. Where the engines have nothing to add, the surface shows the base rate and says there is no signal. "Under audit" and the family minimums from #9072 stay as they are.

## 8. Phases

| Phase | Weeks | Deliverable | Acceptance |
|---|---|---|---|
| 0 Stop the loss | 1 | bucket, schema v1, tap in the 3 hooks, compaction job, health key | every canonical write lands in the lake within 1 h; 7 continuous days; a day replayed from the lake reproduces the Redis payloads |
| 1 Recover | 2 to 3 | traces, Convex, regional, resilience, receipts parsed into the lake | 31 feeds hourly from 2026-03-15; row counts match snapshot counts |
| 2 Backfill | 2 to 5 | tier-1 archives with `observed_at` and licence | coverage table per source; as-of columns populated; licence tag on every dataset |
| 3 Backcast | 4 to 6 | derived state recomputed by live code; drift report | March to October diff within tolerance or each difference explained; series extended to archive depth |
| 4 Base rates | 5 to 7 | catalog, base rates, methodology, hard count resolution for conflict and unrest | every published forecast shows its base rate; the 2 feed switches on with populated feeds |
| 5 Engines | 7 to 12 | learned models and the LLM engine in shadow, walk-forward backtests, promotion rule | shadow scorecard by engine and family; first families promoted on a positive interval |
| 6 Product | after | country history (#4276), trend signals (#5744), history API and playback, all reading the lake | |

Phases 1 and 2 run in parallel. Phase 0 ships before anything else because every day without the tap is a day of lost history on the feeds no archive can replace.

## 9. What this subsumes

- #4276 country timeline: its snapshot writer becomes a lake reader.
- #5745 and #5744 intel-history widening and trend signals: backfill from the lake; baselines from the lake.
- #4930 bets 3 to 6, #5093, #5094: become sections 7.3 and 7.4, scored through the same ledger.
- #8969 judged and cumulative horizons, #9049 commodity thresholds: thresholds and horizons come from the series' own history.
- #7582 CII v9 momentum, which "needs 2 years of history that won't exist at launch": the backcast supplies it.

## 10. Decisions for the owner

1. **Bucket.** Separate `worldmonitor-lake` bucket (recommended) or a prefix in `worldmonitor-data`.
2. **Restricted sources.** Keep Cloudflare Radar, Yahoo, abuse.ch and EM-DAT in the lake for internal modelling with a licence tag and never as a published target (recommended), or drop them. For energy and market targets, resolve on EIA and FRED, which are public domain, and keep Yahoo as a signal.
3. **GDELT backfill path.** BigQuery for the 2015 to 2026 aggregates (recommended), or bulk files into our own storage.
4. **AIS retention.** 5-minute frames of density, crossings and candidates (recommended), or raw positions.
5. **Telegram and X text.** Retain text 30 days and labels indefinitely, pending a terms check; or ids and labels only.
6. **Budget.** Storage and compute are single-digit dollars a month at this scale; the cost is engineering time, about 12 weeks to phase 5.
7. **Transition.** Keep the current detectors publishing until a family is promoted (recommended), or freeze publication to base rates during the build.

## 11. Risks

- **Lookahead leakage** is the failure that produces a backtest that lies. Section 5.2 is the control; the backtest harness must refuse any feature without `observed_at`.
- **Reported-event series measure coverage.** GDELT counts rise when media attention rises. Targets on them say what they measure, and UCDP fatalities remain the ground-truth conflict target.
- **Backcast drift.** If the live metric code is not a pure function of lake inputs, the backcast is a different series. Phase 3's diff against the traces catches it before any model trains.
- **Thin positives.** Many targets fire rarely. The family minimums already in the scorecard keep rare families from publishing on noise; the generator must not fill the page with near-certain non-events (#9012).
- **Licence.** A published target resolved on a non-commercial source is a breach. The licence column and the admission rule are the control.
- **Operational load.** 3 tap hooks touch every producer. The tap is fire-and-forget and digest-deduplicated so it cannot slow or fail a seed; phase 0's acceptance test is the proof.
