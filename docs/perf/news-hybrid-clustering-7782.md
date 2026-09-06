# Hybrid clustering profiling correction — 2026-09-06 (#7782)

**Status: measurement gate remains open.** The complete production input is
more expensive than the reduced input in PR #7802. Repeated 6× measurements
also cross the frame budget in the deterministic high-diversity case. The old
blanket statement that both cases stay below 16.7 ms is withdrawn.

This report establishes isolated execution cost and exact worker output parity.
It does not yet establish a dashboard interaction improvement or justify a
production worker migration. Keep #7782 open for that attribution and the
conditional implementation checks in its issue body. The production algorithm,
limits, semantic refinement, and worker lifecycle remain unchanged.

## Corrections to the review findings

The profiler compiles `protoItemToNewsItem` and its story-phase mapping directly
from DataLoader's source declarations. It uses the canonical source tiers. The
fixture preserves every captured proto field, including snippets, tickers,
story metadata, threat, scores and locations when present. A test checks their
conversion, including zero credibility and known/unknown publisher tiers.

The worker is built from the actual `src/workers/analysis.worker.ts` entry with
Vite production transforms and minification. Requests carry the complete client
items and source tiers, and return all clusters. Every cold and warm result is
compared with the synchronous result after Date hydration, including IDs,
ordering, all articles and metadata. This supersedes the synthetic worker.

The gate counts every sample at or above 16.7 ms and 50 ms. Two frame-budget
crossings within a nine-sample run flag repeated isolated cost for further
attribution. A median below budget cannot hide tail samples. Long tasks must
overlap a measured clustering window; warmup and serialization are excluded.

The Node cross-check now measures only core execution and JSON serialization.
Its old “warm worker” metric actually spawned a fresh process for each request
and returned only a count. It is removed; browser measurements own worker costs.

## Reproduction

```sh
node scripts/profile-news-hybrid-clustering-7782-browser.mjs \
  docs/perf/news-hybrid-clustering-7782.fixture.json
```

Run this three times without another benchmark running. Each invocation emits
JSON and writes `tmp/news-hybrid-clustering-7782-browser.json`. It runs nine
samples after warmup for each fixture at 1×, 4× and 6× CDP CPU throttle.

[Complete input](./news-hybrid-clustering-7782.fixture.json) and
[raw samples and Node cross-check](./news-hybrid-clustering-7782.results.json)
are committed. The public capture was obtained with:

```sh
curl -fsSL -A 'WorldMonitor-agent/7782' -o tmp/full-digest.json \
  'https://www.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1'
node scripts/profile-news-hybrid-clustering-7782.mjs tmp/full-digest.json
```

Flatten category `items` without stripping fields to recreate the browser input.
Capture time: 2026-09-06T12:01:48.463288+00:00. Representative input: 289 articles,
271 unique links, 85 publishers,
261 clusters. Source/date distributions and category counts
are in the raw evidence. The deterministic case supplies 1,500 distinct titles;
the existing 1,000-item cap produces 1,000 singleton clusters. Its minimal
synthetic metadata is not a prediction of a future production digest.

Host: Apple M5 Max, Node 24.20.0, Playwright Chromium, headless. The main-thread
bundle is an isolated esbuild-minified core plus actual conversion and tiers.
The worker is a Vite-built IIFE loaded through a blob URL. Neither is a full
running dashboard, and cold blob startup is not the production client's lazy
module-worker readiness/timeout path. CDP throttle is a host-local approximation;
it does not throttle the worker identically to a physically slower CPU.

## Repeated results

Milliseconds; medians pool 27 timed samples from three independent page runs.
Worker script time is the measured `postMessage` and result-hydration work,
including cold/warm requests. It is a lower bound on renderer occupancy: browser
message dispatch and receive-side clone internals are outside those JS timers.
JSON serialization and structured-clone timings are reported separately in JSON.

| Fixture | CPU | Sync median | Sync max | ≥16.7 ms | Clustering long tasks | Warm worker RT median | Worker script median |
|---|---:|---:|---:|---:|---:|---:|---:|
| representative | 1× | 2.5 | 3.8 | 0/27 | 0 | 3.6 | 0.2 |
| representative | 4× | 9.7 | 11.2 | 0/27 | 0 | 5.7 | 0.9 |
| representative | 6× | 15.0 | 17.5 | 4/27 | 0 | 7.4 | 1.3 |
| highDiversity1500 | 1× | 2.7 | 3.2 | 0/27 | 0 | 5.3 | 0.4 |
| highDiversity1500 | 4× | 11.5 | 13.8 | 0/27 | 0 | 10.0 | 1.7 |
| highDiversity1500 | 6× | 17.9 | 19.9 | 18/27 | 0 | 12.4 | 2.6 |

The representative input and high-diversity input both have tail crossings at
6×. The high-diversity crossings recur in all three final runs. No clustering
long task was observed. Exact full-output parity passed for every measured
cold and warm request. Faster worker round trips under CDP are not proof of a
real-device end-to-end speedup.

## Remaining acceptance

DataLoader selects `clusterNewsHybrid` only when local ML is already available
for that news generation. Otherwise it already uses `analysisWorker.clusterNews`.
The remaining dashboard probe must enable and verify the local-ML/hybrid path;
measuring ordinary boot with ML unavailable would exercise a different path.

Use these same complete inputs in a production-built dashboard. Attribute
interaction/frame delay to the synchronous initial clustering call, then compare
main-thread occupancy and result latency with the existing worker under matching
load. If no repeatable user-facing miss is attributable to clustering, record
that stop decision. Otherwise, implement the existing issue's bounded fallback,
supersession/teardown and semantic-parity checks before closing it. Do not treat
an unavailable worker's empty result as authoritative news data.

## Verification

```sh
node --test tests/profile-news-hybrid-clustering-7782.test.mjs
```

The browser runs additionally execute the real analysis worker and assert exact
output parity. No production clustering change or production speedup is claimed.
