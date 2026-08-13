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

## Phase 5 native evidence-boundary receipt

Phase 5 adds new WorldMonitor Market v1 schema, server evidence/alignment code,
native workspace rendering and tests. It does not copy PokieTicker source,
SQLite values, screenshots, article text, APIs, JavaScript bundles or iframe
content. PokieTicker remains a locked behavior/reference inventory only.

The only upstream provider shape used is the already recorded Massive
company-news response boundary; the new logic preserves its source/time fields
and rejects non-matching/untraceable records before adding a locally computed
exchange-calendar alignment. The new model analysis schema is a disabled
contract, not a copied provider response or an implicit use of an external AI
service.

After GitHub HTTPS recovery on 2026-08-11, read-only `git fetch --no-tags`
reconfirmed `origin/main=0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` and
`upstream/main=ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`. No ref was moved,
no `main` operation occurred, and the integration branch remains the only
target for Phase 5 commits.

## Phase 6 native maritime implementation receipt

Phase 6 is new WorldMonitor TypeScript/CSS/test code. It composes the existing
WorldMonitor `scripts/ais-relay.cjs`, `src/services/maritime/`, Maritime v1,
SupplyChain/PortWatch and Shipping v2 contracts rather than copying an AIS
vendor site, ship-tracking UI, vessel list, map tiles, screenshot, route data,
PortWatch payload or third-party JavaScript. No iframe is used.

The locked GitHub remotes remain `origin/main`
`0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` and `upstream/main`
`ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`; the recovered 443 transport was
rechecked read-only. Phase 6 writes only the integration branch and does not
move, merge, force-push or otherwise alter `main`.
## Phase 7 China industrial-cluster implementation receipt

Phase 7 is new WorldMonitor TypeScript, CSS, test and reviewed-source registry
code. It does not copy PokieTicker source, a Chinese government web-page
layout, a Comtrade payload, a customs file, a port dashboard, vessel tracker,
commercial B/L result, map boundary dataset, screenshot, JavaScript bundle or
iframe. The registry preserves short source metadata and outbound URLs only;
it does not reproduce source text or a third-party dataset.

The locked remotes remain `origin/main`
`0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` and `upstream/main`
`ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`. After the user reported port 443
restored on 2026-08-11, Phase 7's final work remained local to the integration
branch. It does not move, merge, push, force-push or otherwise alter `main`.

## Post-Phase-7 transport recheck — 2026-08-11T22:08:15+08:00

The connected GitHub app resolved `daking32168-byte/worldmonitor` (owner
permission) and `koala73/worldmonitor` (read-only upstream). A read-only
`git ls-remote` over restored HTTPS then returned:

- `origin/main`: `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` (unchanged)
- remote `upstream/main`: `f30c5b4207909d252c5380c56d819c4934006c6c`

The second SHA is newer than the recorded upstream intake baseline
`ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`. This is an observed remote advance,
not an integration decision: the local integration branch stays pinned to its
recorded baseline and Phase 7 commits. No fetch that moves a tracking ref,
merge, rebase, push, force-push or `main` mutation was performed. A future
upstream resync requires a separately documented comparison and gate review.
## Phase 8 native layout and posture implementation receipt

Phase 8 is new WorldMonitor configuration, migration, component, service and
test code. It reorders the existing full-variant panel registry and preserves
the existing dashboard; it does not copy a PokieTicker dashboard, military
tracker, aviation provider page, map tile, screenshot, external JavaScript
bundle, payload or iframe. Provider notices contain short locally authored
status/action wording only and never reproduce an upstream response.

The source baseline remains the recorded local intake commit while remote
`upstream/main` is documented as advanced in the preceding recheck. Phase 8
does not fetch into a tracking ref, merge, rebase, push, force-push or alter
`main`; all work remains on `integration/pokieticker-maritime-china-factory`.

## Phase 9 native provider-operations receipt

Phase 9 is new WorldMonitor service, scheduler, route, CSS, sidecar policy and
test code. It does not copy a PokieTicker, WorldMonitor hosted, provider,
market-data, AIS, PortWatch, Comtrade, China Customs or model-provider page,
payload, dashboard layout, JavaScript bundle, screenshot or iframe. The
control center contains only locally authored labels and locally observed
configuration/executor telemetry.

The locked local intake remains unchanged; remote `upstream/main` remains an
observed advance requiring a separately reviewed resync. Phase 9 performs no
fetch into tracking refs, merge, rebase, push, force-push or `main` mutation.
All commits remain on `integration/pokieticker-maritime-china-factory`.

## Phase 10 native-desktop receipt

Phase 10 is local Tauri configuration, Rust shell, NSIS hook, safe launcher,
PowerShell shortcut, test and build-integrity work. It does not copy a
PokieTicker, hosted WorldMonitor, Node.js, Provider, stock-market or AIS user
interface; it packages the existing first-party application and a validated
Node runtime required by its local sidecar. Node's upstream LICENSE accompanies
the packaged executable runtime rather than being replaced with a local
attribution claim.

No upstream fetch, merge, rebase, push, force-push, `main` mutation or legacy
project change was performed for this phase. The source intake lock remains the
recorded local baseline; the observed remote upstream advance remains a
separate resynchronization decision. The Windows installer is a local build
artifact and is not committed as a Git blob.

## Phase 11 acceptance lock

Phase 11 changes first-party runtime, test-harness, accessibility/layout,
desktop-adjacent and validation code only. It does not pull, copy, iframe,
scrape, vend, reproduce or relabel a PokieTicker, hosted WorldMonitor,
Provider, stock exchange, AIS, PortWatch, Comtrade, China Customs, news or
model UI/payload. The deterministic map style is a local empty-source test
style behind an E2E-only marker, not an imitation of an upstream map.

No upstream fetch, merge, rebase, branch rewrite, `main` mutation, force push
or legacy-project deletion occurred while accepting Phase 11. Publication is
deferred to Phase 12 and targets only the integration branch after remote/SHA
verification.

## Phase 12 publication lock

Publication preflight observed `origin` as
`https://github.com/daking32168-byte/worldmonitor.git` and `upstream` as
`https://github.com/koala73/worldmonitor.git`. At preflight, owner-fork `main`
was `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; the connected GitHub
integration independently resolved upstream `main` to
`a788840c18933489294dacc9b27d57737064bf45` after a duplicate local
`ls-remote` read encountered a transport reset.

No fetch result was merged or rebased. Phase 12 may create/update only
`origin/integration/pokieticker-maritime-china-factory` by a non-force push and
may open only a Draft PR in `daking32168-byte/worldmonitor` targeting `main`.
It must not push to, open a PR against, or mutate `koala73/worldmonitor`.

## Phase 12 transport-block lock

No remote write occurred. The final independent owner-fork query returned only
`refs/heads/main` at `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; no
`integration/pokieticker-maritime-china-factory` remote ref exists. The failed
transports were a non-force HTTPS Git push and a non-mutating SSH batch-auth
probe; neither result authorizes a retry with `--force`, a direct `main` push,
an upstream write, or remote commit reconstruction that loses local SHA
lineage.
