---
title: "Hedge a cache read against origin instead of hard-timing it out"
date: 2026-07-18
category: design-patterns
module: "Bootstrap public-tier serving (workers/api-cors-preflight/src/kv-serve.js)"
problem_type: design_pattern
component: service_object
severity: medium
applies_when: "A read path has a fast primary (cache/replica/edge store) and a fallback origin, and you are about to pick a timeout value that decides when to abandon the primary"
tags: [hedge, hedged-request, timeout, cache-fallback, cloudflare-kv, edge-serving, tail-latency, p95, latency-budget]
---

# Hedge a cache read against origin instead of hard-timing it out

## Context

The bootstrap public tier was being cut over from Vercel-Function→Upstash-Redis to a Cloudflare
Worker reading Workers KV at the edge (#5338, shipped in #5357). The serving path needed a policy
for "what if the KV read is slow?"

The first implementation used a **3 s hard read timeout**. A reviewer correctly flagged it: a hung
KV read delayed the start of origin fallback by ~3 s, far past the ~1200 ms mobile-client abort
budget the whole project was chasing. The proposed fix was to tighten the timeout to **500 ms**,
reasoned as *"leaves a 700 ms reserve for the established origin path before the client deadline."*

That reasoning is where the trap is. It sounds prudent, and it is wrong whenever **origin is the
slow thing** — which was exactly the case here (the incumbent Redis path measured p95 ≈ 1600 ms).
A 500 ms cap does not buy a 700 ms origin reserve; it abandons a read that was about to succeed
under budget and hands the request to a path that is *slower*.

## Guidance

**Before choosing any timeout value, measure what percentage of real reads land in the band the
timeout would abandon** — i.e. reads slower than the timeout but still faster than the client
budget. That band is pure downside: those requests would have succeeded in time.

From the U-K3 shadow window (2026-07-16 → 07-17), share of successful KV reads by band:

| tier | ≤500 ms (served) | **500–1200 ms (abandoned by a 500 ms cap, yet under budget)** | >1200 ms |
|---|---|---|---|
| fast | 99.0 % | **0.9 %** | 0.2 % |
| slow | 96.3 % | **3.0 %** | 0.7 % |

The global average hides the real cost — the band concentrates in specific high-traffic metros:

| colo | % of reads in the 500–1200 ms band | n |
|---|---|---|
| ADL (Adelaide) | 18.6 % | 86 |
| BKK (Bangkok) | 16.3 % | 221 |
| CPT (Cape Town) | 14.9 % | 308 |
| DAC (Dhaka) | 14.8 % | 243 |
| JNB (Johannesburg) | 13.4 % | 769 |
| DEL (Delhi) | 11.4 % | 905 |

Delhi and Johannesburg are not fringe POPs — India was the #2 traffic country. A 500 ms cap would
have bounced ~11–13 % of their reads to a slower path.

**When the fallback is not reliably faster than the primary, a hard timeout is the wrong shape.
Use a hedge instead:** give the primary a head start; if it has not answered by then, start origin
*in parallel* and serve whichever becomes usable first.

The hedge's real elegance is that **it removes the need to pick a timeout value at all**. A
slow-but-valid read still wins and is served; a genuinely hung read simply loses the race to
origin. There is no threshold to mis-calibrate, and no tier-specific tuning to keep in sync.

## Why This Matters

A hard timeout forces one number to answer two unrelated questions: *"is this read hung?"* and
*"should I stop waiting?"* Those have different right answers. A read progressing normally toward
completion at 700 ms is not hung, and abandoning it is a pure loss when origin costs more.

Framed as expected value, a tight cap trades a **certain** win (serve the under-budget read) for a
**gamble** (origin might hit its edge cache and be fast, or might miss and hit slow Redis). The
band it sacrifices (0.9 % fast / 3.0 % slow, far higher in specific metros) is larger than the
band it helps (0.2 % / 0.7 % over budget) — and it only helps that smaller band probabilistically.

A secondary trap: the tight cap bit hardest on the **slow tier**, which had 3× the at-risk band
*and* was the first tier scheduled for cutover. A single global timeout value silently mis-fits
per-tier reality; the hedge is self-correcting and needs no per-tier variant.

## When to Apply

Reach for a hedge, not a timeout, when **all** of these hold:

- There is a fast primary and a fallback, and the fallback is **not reliably faster** than a slow
  primary read (cache↔origin, edge store↔regional DB, replica↔primary, CDN↔origin).
- The primary's latency distribution has a meaningful tail that still lands inside the client
  budget — check this with data; do not assume.
- A redundant fallback request is affordable. Cost here was one extra origin fetch on the ~1–4 % of
  reads that outrun the hedge window, and those often hit Vercel's edge cache rather than Redis.

Prefer a plain timeout when the fallback is genuinely and reliably faster, when the primary has no
meaningful in-budget tail, or when a duplicate downstream request is unacceptable (non-idempotent
writes, metered/expensive calls).

**Pick the head-start from the distribution, not intuition:** ~99 % of fast-tier and ~96 % of
slow-tier reads finished inside 500 ms, so a 500 ms head start means the hedge — and its redundant
fetch — engages only on the slow tail.

## Examples

**Before — a hard cap that abandons in-budget reads:**

```js
const SERVE_READ_TIMEOUT_MS = 500; // "leaves 700ms reserve for origin"  <-- unsound if origin is slower
const raw = await Promise.race([
  env.BOOTSTRAP_KV.get(tier, { type: 'text' }),
  new Promise((_, reject) => setTimeout(() => reject(READ_TIMEOUT), SERVE_READ_TIMEOUT_MS)),
]);
// a read that would have completed at 700ms is discarded -> routed to a ~1600ms p95 path
```

**After — hedge (`workers/api-cors-preflight/src/kv-serve.js:34`, `:109`, `:120` on `main`):**

```js
const HEDGE_DELAY_MS = 500; // head start, not a deadline

// Phase 1 — wait for KV, but no longer than the head start before enlisting origin.
const hedge = hedgeTimer(HEDGE_DELAY_MS);
const first = await Promise.race([kv, hedge.promise]);
hedge.cancel();                       // fast win: origin is never fetched at all
if (first.kind === 'kv' && first.decision.outcome === 'kv') return serveFromKv(...);

// Phase 2 — origin enlisted once; a slow-but-valid KV read can still win the race.
const origin = fetchOrigin().then((resp) => ({ kind: 'origin', resp }));
const settled = first.kind === 'kv' ? await origin : await Promise.race([kv, origin]);
```

Two structural details that made this safe:

1. **One origin implementation.** `fetchOrigin` is injected from the caller
   (`workers/api-cors-preflight/src/index.js:200`), and is the *same* `passThroughToOrigin`
   (`:134`) used by the normal pass-through (`:211`). The hedge never re-implements origin+CORS, so
   the two paths cannot drift, and origin is fetched **at most once** per request.
2. **A distinct fallback reason.** The serving metric emits `kv_reason: 'hedged'` when origin wins,
   separate from `miss | stale | invalid | error`. That makes "primary was too slow" a directly
   observable rate post-cutover rather than an assumption baked into a constant.

Test coverage that locks the behaviour (`workers/api-cors-preflight/kv-serve.test.mjs`): a fast read
is served with origin never enlisted; a hung read hedges to origin and records `hedged`; and — the
one that would have caught the original bug — **a slow-but-valid read still wins the race and is
served, rather than being abandoned.**

## Related

- `docs/solutions/2026-07-16-bootstrap-kv-verify.md` — the U-K3 verify gate whose shadow data
  supplied the band measurement above.
- Staleness fallback is a *separate* concern from slowness: validity/freshness is decided by
  `classifyKvEnvelope` with per-tier bounds (`workers/api-cors-preflight/src/kv-shadow.js:22`,
  fast 15 min / slow 60 min). The hedge answers "too slow"; the staleness guard answers "too old".
