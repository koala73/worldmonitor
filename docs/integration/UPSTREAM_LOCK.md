# Upstream Lock

**Recorded:** 2026-08-11
**Rechecked through the connected GitHub app:** 2026-08-11T16:47:20+08:00
**Purpose:** Reproducible source and license provenance for the reconstruction.

| Role | Repository | Ref | Locked SHA | License | Verification |
|---|---|---|---|---|---|
| Formal mother fork (`origin`) | `https://github.com/daking32168-byte/worldmonitor.git` | `main` | `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` | AGPL-3.0-only | Local sparse clone and connected GitHub app |
| Official WorldMonitor (`upstream`) | `https://github.com/koala73/worldmonitor.git` | `main` | `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad` | AGPL-3.0-only | Connected GitHub app commit lookup on 2026-08-11 |
| PokieTicker source | `https://github.com/owengetinfo-design/PokieTicker.git` | `main` | `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` | MIT | Connected GitHub app commit lookup on 2026-08-11 |

## Local remote configuration

```text
origin   https://github.com/daking32168-byte/worldmonitor.git
upstream https://github.com/koala73/worldmonitor.git
```

`origin/main` is locally locked at the fork SHA above. The official upstream SHA is independently verified through the connected GitHub app; Phase 1 must fetch it locally before determining whether `origin/main` is pure-behind and therefore safe for `--ff-only` synchronization.

The Phase 0 closure deliberately did not treat the connected-app upstream lookup as a local object fetch. `ahead`/`behind`, merge-base, and any `--ff-only` action remain Phase 1 gates after the legal confirmation.

## Phase 1 remote comparison and local-fetch state

The connected GitHub app compared `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` (base) with `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad` (head): status `ahead`, upstream ahead by 43, fork behind by 0, merge-base `0fca203...`. This demonstrates a fast-forward relationship at the remote service.

Local verification is still required and currently unavailable: `origin/main` remains shallow at one commit, no local `upstream/main` ref exists, and two Git fetch methods failed because this machine could not reach GitHub HTTPS. Do not use this remote comparison as authorization to change `main`, manufacture a local ref, or label the local mother baseline synchronized.

## Legacy-data lock

## Phase 2 fixture-isolation receipt

Phase 2 reads the preserved legacy SQLite database only through a read-only
query to derive a twelve-row test fixture for AAPL, MSFT, NVDA and TSLA. The
fixture records the locked repository SHA, database SHA-256, MIT status,
maximum source date `2026-03-03`, and `HISTORICAL_SNAPSHOT` label. The database
itself remains outside Git and no runtime market endpoint reads this fixture.

## Phase 1 local synchronization receipt

After the user reported GitHub 443 recovery, local HTTP/1.1 fetches of
`origin/main` and `upstream/main` both exited 0. Local merge-base is
`0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; the ahead/behind count is
`0 43`. The branch `integration/pokieticker-maritime-china-factory` is
therefore rooted at `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`. This receipt
does **not** move or authorize direct modification of `main`.

The legacy PokieTicker database is **not** a Git artifact and must not be copied into the mother repository as a normal blob.

| Field | Value |
|---|---|
| Original path | `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪\data\pokieticker\pokieticker.db` |
| Size | 226,844,672 bytes |
| SHA-256 | `F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C` |
| `ohlc` rows | 53,025 |
| `news_raw` rows | 60,391 |
| `tickers` rows | 105 |
| Maximum OHLC date | `2026-03-03` |

The database is an historical research snapshot only. Its maximum OHLC date proves it cannot be presented as current exchange data.

## Phase 3 source and transport receipt

On 2026-08-11, the connected GitHub app successfully read both locked
repositories: the origin account retains push authority and the official
upstream is read-only. A subsequent local HTTP/1.1 fetch of `origin main` and
`upstream main` both exited 0 and resolved the existing locked SHAs
`0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` and
`ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`. This is a read-only recheck; it
does not authorize a direct change, merge or push to `main`.

Phase 3 adds source-attribution entries for `https://api.massive.com` and
`https://massive.com`. They are marked `terms-review`, not as an inferred
redistribution license. The adapter references Massive's documented aggregate,
reference-ticker, news and stock-aggregate WebSocket interfaces; actual live
use remains gated by the separate customer entitlement in `MANUAL_ACTIONS.md`.

The implementation commit required a read-only
`GIT_ALTERNATE_OBJECT_DIRECTORIES` reference to the already-locked backup
WorldMonitor object store when this partial-clone worktree attempted an
on-demand blob prefetch. `git write-tree` then succeeded locally with candidate
tree `cef0da8d9cac0154a34be866caad9797243ce6cf`, and the resulting Phase 3
commit is `9cb8cb6efe2164891ea26cb6b2f51b6a3da086b0`. No backup source file,
legacy SQLite database, remote ref or `main` branch was copied, updated or
repointed by this read-only object lookup.

## Phase 4 behavior-map receipt

Phase 4 inspected the locked MIT PokieTicker component names as a behavior map:
`StockSelector`, `CandlestickChart`, `NewsPanel`, `NewsCategoryPanel`,
`RangeQueryPopup`, `RangeNewsPanel`, `RangeAnalysisPanel`, `SimilarDaysPanel`,
`SimilarNewsPanel`, `PredictionPanel` and `StoryPanel`. The native implementation
is a new WorldMonitor TypeScript/D3 workspace; no PokieTicker component source,
runtime, database, screenshot or network page was copied or embedded. The
item-by-item record is `POKIETICKER_COMPONENT_MIGRATION.md`.

The local 2026-08-11 GitHub transport recheck still resolves origin/main to
`0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` and upstream/main to
`ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`. It was read-only and did not move
`main` or any remote ref.
