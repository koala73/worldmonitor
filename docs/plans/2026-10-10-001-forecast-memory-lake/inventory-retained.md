# WorldMonitor: history retained in production (measured 2026-10-09, ~22:45 UTC)

All reads were read-only. Credentials came from `loadEnvFile()` in `scripts/_seed-utils.mjs`, loaded inside scratchpad scripts and run with cwd `a clean checkout of origin/main` (origin/main d49477575b). The Redis wrapper (`./redis-lib.mjs`) rejects any command that is not on a read-only allowlist. No secret values were printed.

## Summary

| Store | Deepest retained history | Size | Retention mechanism |
|---|---|---|---|
| R2 `seed-data/forecast-traces/2026/` | 2026-03-15 → 2026-10-09 (209 days, every day present) | 183,269 objects, 72.7 GB, 5,767 runs | Bucket lifecycle rule, 400 days per year prefix (docs/panels/forecast.mdx:442) |
| R2 `seed-data/forecast-resolutions/` | 2026-07-09 → 2026-10-09 (93 days) | 1,265 receipts, 5.0 MB | None (lifecycle rules must not cover it) |
| Convex `intelHistory` | occurredAt 2026-04-25 → 2026-10-09; ingested since 2026-07-30 (72 days) | 37,216 rows (conflict 35,905; energy 1,142; military 169) | 180-day prune by `ingestedAt` (`convex/intelHistory.ts:68`) |
| Redis `forecast:resolutions:v1` | generatedAt from 2026-07-15 | 1,408 rows, 4.5 MB, no TTL | Hot ledger, rows leave once archived |
| Redis `forecast:predictions:history:v1` | 8.4 days (2026-10-01 13:02 → 2026-10-09 22:00) | 200 runs (LTRIM cap) | LTRIM 200 + 45 d TTL |
| Redis `forecast:evidence:v1` (judged lane's news archive) | 15.0 days (2026-09-24 22:29 → 2026-10-09 22:29) | 15,666 members + 15,660 record keys | 15 d per-record TTL |
| Redis `digest:accumulator:v1:full:en` | 8.0 days (2026-10-01 22:34 → 2026-10-09 22:29) | 9,087 members | 8 d member prune, 2 d key TTL |
| Redis `intelligence:snapshot:v1:*` | 89.8 days (2026-07-11 → 2026-10-09) | 5,762 keys (8 regions) + 5,754 by-id keys | ~90 d per-key TTL |

## 1. R2 bucket `worldmonitor-data`

Method: `getR2StorageClient(resolveR2StorageConfig(process.env))` from `scripts/_r2-storage.mjs` (S3 mode), `ListObjectsV2` with `Delimiter: '/'` for the prefix tree, then a full paginated listing (MaxKeys 1000) of each prefix, grouped client-side. Dates are object `LastModified` unless stated otherwise. Scripts: `./r2-top.mjs`, `r2-stats.mjs`, `r2-traces2.mjs`.

### Top level

| Prefix | Objects | Bytes | Notes |
|---|---|---|---|
| `forecast-runs/` | 1 | 43 B | `forecast-runs/probe/test.json` only (2026-03-15) |
| `seed-data/` | see below | | |

### `seed-data/`

| Prefix / object | Objects | Total bytes | Oldest | Newest |
|---|---|---|---|---|
| `seed-data/forecast-traces/` | 183,274 | 72.71 GB | 2026-03-15 | 2026-10-09 |
| `seed-data/forecast-resolutions/` | 1,265 | 5.01 MB | 2026-07-09 | 2026-10-09 |
| `seed-data/military-bases-final.json` (single object) | 1 | 35.6 MB | 2026-03-05 | 2026-03-05 |

### `forecast-traces` by year

| Year prefix | Objects | Bytes | Notes |
|---|---|---|---|
| `2024/` | 3 | 0.01 MB | Test fixtures (`run-001`, `run-test-123`), written 2026-08-31 to 2026-10-03 |
| `2026/` | 183,269 | 72.71 GB | Real runs, 209 distinct days |
| `_test-probe.json`, `probe/` | 2 | ~0 | Probes |

### `forecast-traces/2026/` by month

| Month | Objects | GB | Runs | Days present |
|---|---|---|---|---|
| 03 (from 03-15) | 55,436 | 4.69 | 1,177 | 17 |
| 04 | 19,965 | 10.50 | 712 | 30 |
| 05 | 20,514 | 9.97 | 732 | 31 |
| 06 | 20,083 | 9.62 | 715 | 30 |
| 07 | 20,582 | 10.97 | 735 | 31 |
| 08 | 20,823 | 11.51 | 742 | 31 |
| 09 | 20,165 | 11.99 | 720 | 30 |
| 10 (to 10-09) | 5,701 | 3.46 | 214 | 9 |

About 24 runs per day, about 11-12 GB per month.

### `forecast-traces/2026/` by file within a run

| File | Objects | GB |
|---|---|---|
| `deep-snapshot.json` | 4,837 | 33.93 |
| `world-state.json` | 5,278 | 12.35 |
| `deep-world-state.json` | 4,819 | 12.13 |
| `fast-world-state.json` | 4,830 | 8.02 |
| `impact-expansion-debug.json` | 4,832 | 3.16 |
| `forecasts/*.json` | 113,792 | 2.09 |
| `forecast-eval.json` | 4,645 | 0.32 |
| `simulation-package.json` | 4,752 | 0.24 |
| `summary.json` | 5,741 | 0.13 |
| `fast-summary.json` / `deep-summary.json` | 4,830 / 4,819 | 0.11 / 0.11 |
| `simulation-outcome.json` | 4,698 | 0.08 |
| `manifest.json` | 5,745 | 0.03 |
| `path-scorecards.json` | 4,818 | 0.02 |
| `run-status.json` | 4,832 | 0.003 |

`deep-snapshot.json` holds licensed third-party data, ACLED and news among it, and must stay private (docs/panels/forecast.mdx:442).

### `forecast-resolutions` by month (key date prefix `YYYY-MM-DD/`)

| Month | Receipts | MB |
|---|---|---|
| 2026-07 (from 07-09) | 203 | 0.58 |
| 2026-08 | 331 | 0.97 |
| 2026-09 | 461 | 2.25 |
| 2026-10 (to 10-09) | 269 | 1.21 |

There is also one stray duplicate at `seed-data/forecast-resolutions/forecast-resolutions/2026-07-09/...` (a doubled prefix). Receipt keys are `<date>/<forecastId>@<generatedAt>-<resolvedAt>.json`.

Retention: "Since 2026-10-09, the dated run directories under the trace prefix are deleted after 400 days, with one lifecycle rule per year (2024 to 2027) ... a rule for 2028 must be added before 2028-01-01. The rules must not cover the resolution receipts" (docs/panels/forecast.mdx:442). I did not read the bucket lifecycle configuration.

## 2. Redis history-like keys

Method: `DBSIZE` reported 389,240 keys. Instead of seven pattern scans (about 2,700 calls), I ran one `SCAN 0 MATCH * COUNT 1000` pass (380 calls, 305,778 key names; the gap from DBSIZE is keys that expired during the scan) and filtered names client-side with `/history|:accumulator:|archive|timeline|series|daily|snapshot/i`. That matched 19,149 keys. For each key I read `TYPE` and `TTL`, the size (`ZCARD`/`LLEN`/`STRLEN`/`HLEN`), and the timestamps:
- zset: score of the first and last member (`ZRANGE 0 0` / `-1 -1 WITHSCORES`);
- list: `LINDEX 0` and `LINDEX -1`, scanned for timestamps;
- string: up to the first 300 KB (`GETRANGE`), scanned for 13-digit epoch-ms values and ISO dates (heuristic; "first 300KB" marks partial reads);
- hash: field names.
Families with thousands of keys were measured from timestamps embedded in the key names plus sampled keys. Scripts: `./redis-scan.mjs`, `redis-measure.mjs`, `fam.mjs`, `resil.mjs`. Raw output: `./singles-out.txt`.

No key matched `*timeline*` or `*archive*`.

### Judged forecast lane's news archive (precise)

The resolver reads `forecast:evidence:v1`, not the accumulator. `readJudgedNewsArchiveForLedger` calls `readForecastEvidenceArchive`, which reads `FORECAST_EVIDENCE_KEY` (`scripts/seed-forecast-resolutions.mjs:2801-2896`). The `JUDGED_ARCHIVE_KEY = 'digest:accumulator:v1:full:en'` constant (line 70) is still used by `readDigestAccumulatorArchive` (line 3031). The evidence archive is filled from `digest:accumulator:v1:full:en` (`FORECAST_EVIDENCE_SOURCE_KEY`, `scripts/_forecast-evidence-archive.mjs:26`).

| Key | Type | Size | TTL | Span |
|---|---|---|---|---|
| `forecast:evidence:v1` | zset (score = lastSeen ms) | 15,666 members | 15.0 d | 2026-09-24 22:29 → 2026-10-09 22:29 = **15.0 days** |
| `forecast:evidence:record:v1:<hash>` | string per story | 15,660 keys | 15 d each (`FORECAST_EVIDENCE_TTL_S`) | same window |
| `forecast:evidence:coverage:v1` | string | 381 B | 15.0 d | marker spans 2026-09-23 → 2026-10-09 |
| `digest:accumulator:v1:full:en` | zset | 9,087 members | 2.0 d key TTL | 2026-10-01 22:34 → 2026-10-09 22:29 = **8.0 days** (member prune `ACCUMULATOR_RETENTION_MS` = 8 d) |
| all 105 `digest:accumulator:v1:<variant>:<lang>` | zset | 350,488 members total | ~2 d | oldest member 2026-09-29 15:07 |
| `story:track:v1:<hash>` | hash, 16 fields | 19,477 keys | `STORY_TTL` 7 d (sample 4.2 d left) | rolling 7 days |

The design consequence is that no news text older than 15 days exists in Redis. Older news exists only inside `deep-snapshot.json` in R2 traces (from 2026-03-15) and as titles and links in Convex `intelHistory` conflict rows (GDELT events, from 2026-07-29).

### Other history-like keys

| Key / family | Type | Size | TTL | Retained span |
|---|---|---|---|---|
| `intelligence:snapshot:v1:<region>:<ts>` (8 regions) | string, ~5 KB | 5,762 keys | ~90 d each | 2026-07-11 → 2026-10-09 = 89.8 d (from key-name timestamps) |
| `intelligence:snapshot-by-id:v1:<id>` | string, ~7.7 KB | 5,754 keys | ~90 d each | same as above |
| `intelligence:regime-history:v1:{global,mena,europe,east-asia,latam}` | list | 100 / 100 / 59 / 2 / 2 | none | global and mena 2026-08-03 → 10-09; europe 07-31 → 10-09; east-asia and latam 2 entries in Aug |
| `intelligence:pizzint:history:v1:{besttime,pizzint}:<date>` | hash, per day | 11 + 8 day keys | ~90 d | besttime 09-28 → 10-09, pizzint 10-01 → 10-09 (about 500 fields/day besttime) |
| `risk:scores:sebuf:trend-history:v8:<bucket>` | string, ~10 KB | 427 keys | 3 d (`CII_TREND_HISTORY_TTL`) | ~71 h of 10-minute buckets |
| `resilience:history:v<N>:<CC>` | zset, score YYYYMMDD | 4,327 keys over 22 versions plus legacy unversioned keys | none | Each scorer version restarts history. Current v23: 196 keys, 2026-10-08 → 10-09. Longest: v22 (08-14 → 10-08), v20 (06-24 → 08-12), v13 (04-29 → 06-01). Legacy `resilience:history:<CC>`: 2026-04-05 |
| `market:stock-analysis-history:item:*` | string, ~3 KB | 2,195 keys | ~14 d (sample) | key names 2026-07-10 → 10-09 |
| `market:stock-analysis-history:index:v{3,5}:<sym>:{core,news}` | zset | e.g. NVDA:news 32 members | ~90 d | NVDA:news 08-26 → 10-09; NVDA:core 07-29 → 10-06 |
| `market:stock-analysis-ledger:*` (not matched by the patterns; included for completeness) | zset index + records | 29,039 keys | ~17 d (sample index) | key names 2026-04-08 → 10-09 (184 d) |
| `market:breadth-history:v1` | string | 10.9 KB | 29.4 d | 2026-04-11 → 10-08 |
| `market:correlation-series:v1` | string | 91 KB | 7 d | 09-22 → 10-09 |
| `market:physical-premium-history:v1:{gold,silver}` | list | 24 each | none | 08-28 → 10-09 |
| `supply_chain:transit-summaries:history:v1:<chokepoint>` (13 keys) | string, ~38 KB | 13 keys | ~0 d (rewritten each run) | 2026-04-12 → 10-09 (~180 daily points each) |
| `thermal:escalation:history:v1` | string | 18.8 MB | 29.9 d | first 300 KB: 09-19 → 10-09 |
| `military:surges:history:v1` | string | 170 KB | 7 d | 720 timestamps, all 10-09 16:45 → 22:40 |
| `displacement:cross-border:history:v1` | string | 9.2 KB | 29.9 d | 2024-12-31 → 2026-10-09 (annual points) |
| `economic:china:corridor-directional-history:v1` | list | 16 | 14 d | 10-09 only |
| `consumer-prices:basket-series:<cc>:<basket>:{7d,30d,90d}` (48 keys) | string | 0.9-6.5 KB | 0.2 d | 90d series: 07-11 → 10-09 |
| `bls:series:v1` | string | 6.9 KB | 2.4 d | 2021-01 → 2026-10 |
| `correlation:market-alerts:snapshot:v1` | string | 21 KB | 1 d | 10-07 → 10-09 |
| `natural:events:{nhc-snapshot,source-snapshots}:v1` | string | 221 KB / 76 KB | 0.7 d | current snapshot (timestamps are event dates) |
| `sanctions:source-snapshots:v1` | string | 1.25 MB | 2.1 d | no timestamps in the first 300 KB |
| `relay:oref:history:v1` | string | 238 B | 3.8 d | 10-06 only |
| `intel-history:ingest-health:*:v1` (3 keys) | string | <1 KB | 7 d | health markers for the Convex appenders |
| `research:trending:v1:*:daily:50` (3 keys) | string | ~14 KB | 0.1 d | current only |
| `digest:sent:v1:*` (not matched by the patterns; noted) | string | 13,762 keys | ~7 d | send dedupe markers |
| `preview:a3d761ad:digest:accumulator:v1:full:en` | not measured | | | preview-deploy copy |

`rss:feed:*` and `rl:*` keys matched only because of the word "daily" in a URL; they are excluded.

## 3. Forecast records

| Key | Type | Size | TTL | Measured |
|---|---|---|---|---|
| `forecast:resolutions:v1` | string `{_seed, data:{<id@generatedAt>: row}}` | 4,532,010 B | none | **1,408 rows** (`_seed.recordCount` and `seed-meta:forecast:resolutions.recordCount`, fetchedAt 2026-10-09 06:05). **Oldest generatedAt 2026-07-15 00:04 UTC**, the minimum over the 118 rows in the first 300 KB. Rows are stored in insertion order, so the oldest rows are at the front. Not verified over the full 4.5 MB value, which I did not download. The earliest R2 receipt is 2026-07-09, so rows from 07-09 to 07-14 have already left the hot ledger. |
| `forecast:predictions:history:v1` (written by `appendHistorySnapshot`, `scripts/seed-forecasts.mjs:5021`; `HISTORY_MAX_RUNS = 200`, `HISTORY_TTL_SECONDS` = 45 d) | list | **200 entries**, ~2.6 KB each | 45.0 d | head generatedAt 2026-10-09 22:00, **oldest (tail) 2026-10-01 13:02** = 8.4 days |
| `forecast:bets:history:v1` | list | 96 entries, ~31 KB each | 44.3 d | 2026-07-12 09:32 → 2026-10-09 05:04 (~89 d) |
| `forecast:scorecard:v1` | string | 34 KB | 6.3 d | **data.generatedAt 2026-10-09 06:04:47 UTC**; ledgerEntries 647; totals: 450 entries, 377 resolved, 358 void, 19 scored; overall count 153, Brier 0.220; corpus.historySnapshots 296 from 2026-07-12 09:32 to 2026-10-09 05:04; publishedCount 3,510; rollingWindowDays 180 |
| `forecast:trace:runs:v1` | list | 50 entries | 60 d | 2026-10-08 22:00 → 10-09 22:00 (about 1 day of run pointers) |
| `forecast:calibration-map:v1` | string | 1.2 KB | 89 d | fitted from 2026-07-08 data |
| `forecast:simulation-outcome:by-run:*` | string | 26 keys | not measured | |

The scorecard's ledger count (647) is smaller than the resolutions row count (1,408) because the scorecard counts published forecasts only and excludes shadow bets and voided feeds; see its methodology text.

## 4. Convex

Time-series candidates in `convex/schema.ts`: `intelHistory` (line 1877, the only intelligence time series), `intelHistoryRetractions`, `apiUsageRollups`, `paymentEvents`, `broadcastEvents`, `webhookEvents`, `checkoutRateLimitEvents`, `waveRuns`, and the `companyMonitoring*` evidence tables. Only `intelHistory` was measured. The others are billing, ops, or product records, not intelligence memory.

Method: the read-only internal query `intelHistory:timeline` (`convex/intelHistory.ts:657`), called through `ConvexHttpClient.setAdminAuth(CONVEX_DEPLOY_KEY)` (`./convex-count.mjs`). Pages of 200 rows were read by descending `occurredAt` per domain, with the `to` bound moved to the oldest row seen and deduplicated by id, until a short page. The domains are exactly `conflict`, `military`, and `energy`: those are the only `domain:` values in the appending seeders (`seed-conflict-intel.mjs`, `seed-cross-strait-activity.mjs`, `seed-energy-intelligence.mjs`). I first confirmed the query shape with `npx convex run intelHistory:timeline`.

| Domain (resource) | Rows | occurredAt range | ingestedAt range | Rows by occurredAt month |
|---|---|---|---|---|
| conflict (`acled-intel`, GDELT events) | 35,905 | 2026-07-29 → 2026-10-09 | 2026-07-30 → 10-09 | Jul 1,096; Aug 15,765; Sep 14,136; Oct 4,908 |
| energy (`intelligence`) | 1,142 | 2026-07-29 → 2026-10-09 | 2026-07-30 → 10-09 | Jul 53; Aug 458; Sep 480; Oct 151 |
| military (`cross-strait-activity`) | 169 | 2026-04-25 → 2026-10-09 | 2026-07-30 → 10-09 | ~30/month, backfilled to April |
| **Total** | **37,216** | | | |

Each row carries a 512-dimension embedding. Retention is 180 days by `ingestedAt` (`INTEL_HISTORY_RETENTION_DAYS`, `convex/intelHistory.ts:68`), so the first rows start pruning around 2026-01-26. This count is a paged read through an index, not an exact table count.

## 5. Axiom / Sentry (from repo docs only; nothing queried)

- Sentry: "~90-day retention" (docs/solutions/integration-issues/convex-auth-drift-ramp-was-stacked-clerk-token-cache.md:63, :117).
- Axiom `convex-logs` dataset: "retention back to 2026-08-01 at the time of writing" (docs/solutions/integration-issues/convex-request-couldnt-be-completed-is-redacted-join-request-id-into-axiom-convex-logs.md:48).
- Axiom request logs: "14 days of Axiom retention" (docs/solutions/logic-errors/seed-meta-override-equal-to-the-data-key-clobbers-the-seed.md:12).

## Not measured

- The R2 bucket lifecycle configuration itself (I took the 400-day rule from the docs) and any other R2 bucket, such as the `R2_BOOTSTRAP_BUCKET` profile in `_r2-storage.mjs`.
- The full `forecast:resolutions:v1` value (4.5 MB). The oldest generatedAt comes from the first 300 KB only.
- String keys over 300 KB (`thermal:escalation:history:v1` at 18.8 MB, `sanctions:source-snapshots:v1` at 1.25 MB): spans are from the first 300 KB only.
- Timestamps inside `story:track:v1` rows, `market:stock-analysis-ledger` records, and `intelligence:snapshot-by-id` rows beyond one sample each.
- Convex tables other than `intelHistory`; exact Convex row counts (no count API; counts come from paged index reads).
- Axiom and Sentry live retention settings.
