# Hybrid clustering profiling and worker offload — 2026-09-06 (#7782)

**Status: implementation gate met and offload verified.** A production-built
dashboard selected `clusterNewsHybrid` with local ML available. At 6× CPU
throttle, its synchronous initial core caused repeatable frame-budget misses on
both committed inputs. The existing analysis worker removed those misses on the
same surface, so the hybrid path now uses that worker for its initial stage.

The earlier sections preserve the corrected isolated evidence from PR #7811.
The dashboard section records the later attribution, implementation decision,
and same-command before/after results. Limits, source tiers, clustering
semantics, semantic thresholds, and semantic candidate selection are unchanged.

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

Run the isolated core and exact worker-parity profile:

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

## Production-dashboard attribution

Run the complete dashboard profile:

```sh
node scripts/profile-news-hybrid-clustering-7782-dashboard.mjs \
  docs/perf/news-hybrid-clustering-7782.fixture.json \
  --samples 3 --cpu 1,6
```

The harness builds the full dashboard with production minification and test-only
timing marks. It enables the browser model, waits for local ML, verifies the
actual selected path for every generation, and uses the source-extracted proto
conversion. Fixture conversion is completed before the measured frame so it
cannot be attributed to the initial clustering stage. The matching direct path
uses the production `analysisWorker.clusterNews` lifecycle, not a synthetic
worker. The two complete reports contain every raw sample:

- [before offload](./news-hybrid-clustering-7782-dashboard.before.json)
- [after offload](./news-hybrid-clustering-7782-dashboard.after.json)

The 6× results below are warm samples. “Initial” is the synchronous core before
the change and the full worker result round trip after it. An initial crossing
has a stage duration or overlapping request-animation-frame interval at or above
16.7 ms. A path miss requires the overlapping frame interval.

| Input | Build | Initial median | Initial crossings | Full hybrid path misses | Final clusters |
|---|---|---:|---:|---:|---:|
| representative, 289 items | before | 16.1 ms | 3/3 | 2/3 | 249 |
| representative, 289 items | after | 7.9 ms | 0/3 | 0/3 | 249 |
| high diversity, 1,500 items | before | 16.4 ms | 2/3 | 2/3 | 753 |
| high diversity, 1,500 items | after | 14.1 ms | 0/3 | 0/3 | 753 |

At 1×, neither build missed a frame. The worker adds a small warm round-trip
cost there: the representative initial median changed from 3.3 ms to 4.9 ms,
and the high-diversity median changed from 2.6 ms to 6.0 ms. The dashboard boot
can warm the shared analysis worker before the explicit samples, so its first
sample is not a cold-start measure. The isolated real-worker runs record cold
readiness and result latency separately: at 6×, representative cold readiness
was 7.1 ms and its first result was 8.7 ms; high diversity was 7.0 ms and
16.5 ms. The hybrid total includes about 2.1 seconds of semantic model work in
both builds.

The direct analysis-worker comparison at 6× returned the representative result
in a 7.2 ms median before the change and 7.3 ms after it. The high-diversity
medians were 12.8 ms and 14.7 ms. Its renderer `TaskDuration` medians were
44.1/44.7 ms and 57.5/62.7 ms, respectively. The full hybrid path's broad
`TaskDuration` counter moved upward in the second run while semantic work was in
flight, so this report does not claim that noisy whole-path counter improved.
The verified improvement is narrower: the attributed initial-stage frame misses
dropped from repeated to zero on both inputs.

## Implementation contracts

DataLoader selects `clusterNewsHybrid` only when local ML is already available
for that news generation. Otherwise it already uses `analysisWorker.clusterNews`.
The hybrid path now sends the unchanged complete input to that same worker, then
runs the existing semantic ranking, 250-candidate refinement, overflow merge,
and final ordering.

For nonempty input, an unavailable worker's empty result and construction,
readiness, request, reset, or runtime errors run the local shared core once. A
superseded generation or app teardown cancels the continuation before fallback
or semantic work, so worker termination cannot start a fresh main-thread core.
Genuine empty input remains an authoritative empty result. Tests cover no-merge
and multi-source semantic results, more than 250 candidates, more than 1,000
inputs, known and unknown tiers, fallback, supersession, and teardown.

## Verification

```sh
node --test \
  tests/profile-news-hybrid-clustering-7782.test.mjs \
  tests/profile-news-hybrid-clustering-7782-dashboard.test.mjs \
  tests/clustering-cap.test.mjs
npx vitest run --config vitest.dom.config.mts \
  tests/dom/news-hybrid-worker-offload.test.mts
npm run typecheck
npm run lint:boundaries
git diff --check
```

The isolated browser runs execute the real analysis worker and assert exact
full-output parity. The production-dashboard run verifies the local-ML hybrid
selection and the final semantic cluster counts on both inputs before and after
the implementation.
