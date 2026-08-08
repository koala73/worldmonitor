---
title: CDN/Redis egress cost is origin-miss rate x payload size, not client count (the lever test)
date: 2026-07-15
category: best-practices
module: bootstrap-hydration
problem_type: best_practice
component: service_object
severity: high
applies_when:
  - Evaluating a proposed CDN or Redis egress-cost optimization before committing engineering time
  - Deciding whether deduplicating byte-identical Redis keys will reduce bandwidth
  - A feature combines a one-shot hydration payload (e.g. getHydratedData) with a periodic client refresh
  - Scoping the cost of a new bootstrap or RPC data path
  - Measuring cache traffic to attribute egress cost by key
related_components: [background_job, tooling]
tags: [egress-cost, cdn-caching, redis, bootstrap-hydration, origin-miss-rate, measurement-protocol, cache-deduplication, rpc-fallthrough]
---

# The lever test for CDN/Redis egress: cost is origin-miss rate times payload, not client count

## Context

Epic #5300 (opened and closed COMPLETED 2026-07-14) started from a single alarming number: Redis GET egress was running roughly 3x over the plan allowance. The obvious first hypothesis — "the cache is failing, misses are leaking to origin" — was ruled out immediately by the field data: the CDN was reporting a **healthy 95–97% hit ratio**. Caching was working. The bytes were still leaving.

The reflex when egress is high is to reach for the biggest payloads and shrink them — "reduce payload" phases. The bootstrap slow tier was the eager suspect: per the #5300 investigation it was shipping on the order of **3.2 MB** to every visitor. (The tree today reflects the landed arc — `src/services/bootstrap.ts:361` documents the slow tier at "~410 KB" and `:389` at "~500 KB", after the dossier split described below.) Payload-shrink phases were scoped, sized in GB/day, and slated for engineering weeks.

The lesson of the epic is that most of that scoping was arithmetic that had not been done yet. Two of the "reduce payload" phases were mis-sized by the same mistake — reasoning about **who reads a key** or **how many clients load it** instead of **how many origin misses the key incurs and how big each transferred body is**. One phase was voided outright before any code was written; another was under-scoped by nearly 4x because a periodic refresh path had been silently bypassing the CDN. Both fall out of one test.

## Guidance

**The lever test.** Before scoping any egress, bandwidth, or cost-reduction work on a cached key-value payload, write the cost as:

```
egress ≈ origin-miss count × transferred payload size
```

Client count, reader count, and total request volume are **not** on the right-hand side — the CDN absorbs them. The only two levers that move egress are the **origin-miss rate** (requests that fall through the cache to Redis/origin) and the **bytes per miss**. If a proposed change does not reduce one of those two numbers, it does not reduce egress, no matter how much storage or how many requests it touches. Run this test on every proposed phase and discard the ones whose math nets to zero.

Three facets make the test operational.

**Facet 1 — Deduplicating byte-identical keys saves storage, not bandwidth.** Two keys can be byte-for-byte identical (same SHA, same size) and still cost exactly what they cost after you collapse them, because the *readers* are what drive egress, not the *stored copies*. In the epic, `cyber:threats-bootstrap:v2` and `cyber:threats:v2` were byte-identical — same SHA, 950 threats, **363.8 KB each** — but they had different readers: bootstrap read the `-bootstrap` key and the RPC read the canonical one. This split is still visible in the tree: `api/health.js:85` maps the bootstrap reader to `cyber:threats-bootstrap:v2` while `api/health.js:215` maps `cyberThreatsRpc` to `cyber:threats:v2`. Collapsing the two into one key would leave the same two readers issuing the same number of GETs for the same number of bytes — total egress unchanged. Storage would halve (one 363.8 KB copy instead of two); bandwidth would not move. The epic's planned "Phase 2 (~2–4 GB/day)" rested entirely on this dedup and was **voided by the arithmetic before a line of code was written**.

**Facet 2 — When a hydration payload is one-shot, every periodic refresh path must be audited for un-CDN'd fallthrough.** `forecast:predictions:v2` was scoped at **1.3 GB/day** — its share of the bootstrap slow tier — but actually cost **~4.9 GB/day**. The gap was a refresh path nobody had put on the ledger. The client hydrates once from `getHydratedData()`, which is **one-shot by design**: it reads the value and immediately deletes it (`src/services/bootstrap.ts:67-71` — `getHydratedData` calls `hydrationCache.delete(key)` on read). So the client's 30-minute refresh tick found nothing in the hydration cache and fell through to the `get-forecasts` RPC. Per the #5300 investigation that RPC had **no CDN shield**: every refresh was an origin miss — roughly **17.5k uncached origin reads/day at 188 KB each** (the 188 KB figure is grounded in `scripts/_forecast-dashboard.mjs:4`). The one-shot hydration guaranteed that the recurring path could never be a cache *hit*; it was origin traffic by construction. PR #5311 fixed both halves — the bootstrap share and the RPC fallthrough. The fix's shape is now codified in the tree: `ensureHydrated` (`src/services/bootstrap.ts:91-116`) fetches on-demand keys through a CDN-shielded public URL (`/api/bootstrap?keys=<name>&public=1`) and its docstring states the rule directly — "This must NOT fall back to the domain RPC: the RPC reads the same Redis key with no CDN in front of it, so routing misses there would relocate the egress rather than remove it."

**Facet 3 — A measurement protocol that makes results comparable.** The epic's numbers held up because the measurement was disciplined:

- **Use EVALSHA/s as a traffic proxy.** The rate limiter's `EVALSHA` rate tracks request volume independent of payload, so it normalizes measurements taken under different load.
- **Isolate the CDN origin-miss rate with a clean probe.** Pick a key with *no reader except bootstrap* — `energy:pipelines:gas:v1` (`api/health.js:287`) is one — so its origin GETs measure the miss rate itself, uncontaminated by RPC or MCP readers.
- **Compare GET counts, not bytes.** Key sizes swing diurnally, so bytes measured at two different times aren't comparable. Measure at peak, and compare *counts*.
- **Never measure adjacent to a deploy.** A deploy flushes caches and distorts the miss rate; wait for steady state.

Three hard-won refinements to that protocol from the epic's own sessions (session history; the first and third are recorded only in the working sessions, not in the issue trail):

- **Verify the probe key is actually reader-free — grep for other readers before trusting it.** An earlier fast-tier estimate was inflated because the chosen probe (`seismology:earthquakes:v1`) turned out to also be a heavily-read public RPC route; it was replaced with `correlation:cards-bootstrap:v1` once the contamination was found. A probe key is only a clean origin-miss meter if bootstrap is its *only* reader.
- **Use two independent traffic proxies and check they agree.** The epic's normalization originally leaned on a health-sweep-rate proxy — which PR #5262 then removed. The rate-limiter EVALSHA proxy replaced it; measuring with two proxies caught the discontinuity instead of silently absorbing it.
- **Don't trust the naive miss-rate model — measure it.** `misses ≈ shards × 86400/TTL` was explicitly tested and shown wrong: the fast tier's 12× shorter TTL produced only ~1.6× more origin misses, not 12×. POP request distribution, not TTL arithmetic, dominates.

## Why This Matters

The cost of the lever test is about thirty minutes of arithmetic. The cost of skipping it, in this epic, was measured in engineering weeks pointed at the wrong targets.

- **A voided phase.** "Phase 2 (~2–4 GB/day)," the cyber-threats dedup, would have consumed real engineering time collapsing two keys, migrating readers, and re-testing — for **zero** bandwidth reduction. The lever test killed it on paper (Facet 1). Every hour not spent building it is a direct return on the arithmetic.
- **A 4x under-scope caught, not shipped.** `forecast:predictions:v2` was on the books at 1.3 GB/day and was actually ~4.9 GB/day. Had the team trusted the bootstrap-share estimate, they'd have "fixed" the payload, watched egress barely move, and been mystified — because the dominant cost was a refresh path that was never in the model (Facet 2). Thirty minutes of tracing the one-shot hydration to its fallthrough recovered the missing 3.6 GB/day *before* the work was scoped, not after it disappointed.
- **The arc landed because the residual was demand-driven, not payload-driven.** The epic's headline result was Redis GET egress falling from **306 → 41 GB/day traffic-normalized (an 87% reduction), with commands down 79%**. That first, large win came from the structural changes (the dossier split, the CDN shield). The demand-driven phases then addressed the residual. The acceptance bar was **≤17 GB/day sustained, OR an explicit plan-resize decision** — deliberately allowing "the honest answer is we need a bigger plan" as a valid outcome, because the lever test tells you when further payload work has diminishing returns and the real lever is capacity.

The through-line: egress is an economics problem, and the units are miss-rate and payload-size. Any optimization expressed in other units — number of keys deduplicated, number of clients served, requests handled — is measuring the wrong thing, and the plan built on it will over- or under-deliver by whatever the CDN happens to be absorbing.

## When to Apply

- Before scoping **any** "reduce payload" or "shrink the bundle" phase against an egress or bandwidth cost — run the lever test first and discard phases whose math nets to zero.
- On any **egress / bandwidth / cost optimization on a cached key-value payload** (Redis, CDN-fronted object storage, any origin-behind-cache topology).
- Whenever a cost estimate is derived from **client count, reader count, or request volume** rather than origin-miss count × payload size — treat that estimate as unverified until re-derived in the correct units.
- Whenever a payload is hydrated **one-shot** (read-once, deleted-on-read, or otherwise not re-served from cache on subsequent reads): audit **every** periodic or on-demand refresh path for un-CDN'd fallthrough to origin. One-shot hydration and a recurring refresh tick together are the signature of hidden origin traffic.
- Before deduplicating byte-identical keys **for a bandwidth reason**: dedup is a storage optimization. If the goal is egress, confirm the readers collapse too — otherwise the reads×bytes are unchanged.
- When measuring egress to compare a before/after: use a proxy (EVALSHA/s), isolate the miss rate with a reader-free probe key, compare GET counts at peak (not bytes), and stay clear of deploys.

## Examples

**Non-fix: the cyber dedup that saves storage, not bandwidth.**

- *Before:* `cyber:threats-bootstrap:v2` and `cyber:threats:v2`, both 363.8 KB, same SHA, 950 threats. Bootstrap reads the first (`api/health.js:85`); the RPC reads the second (`api/health.js:215`). Two readers, two GET streams.
- *Proposed (Phase 2, ~2–4 GB/day):* collapse to one key.
- *Lever test:* readers unchanged → same GET count × same 363.8 KB → egress unchanged; only stored bytes halve.
- *Outcome:* phase voided before any code. Storage-vs-bandwidth was the whole trap.

**Non-fix: turning panel defaults off (session history — this exchange is recorded in the epic's working sessions, not on GitHub).**

- *Proposed:* "can we demote thermal and ucdp from being enabled, and reduce that entirely" — flip the panels' default to off so fewer clients render them.
- *Lever test:* `/api/bootstrap` filters purely by tier and has no visibility into panel settings — the key ships in the payload whether the panel is on, off, or nonexistent, and the slow tier incurs its ~6,048 origin misses/day regardless of whether 100 or 100,000 people load the app. Flipping a default changes what the browser renders, not a single byte Redis serves.
- *Outcome:* rejected with the arithmetic; the resolution was "cache what we show, not the source" — publish a bootstrap-sized *view* (the #5263 wildfire pattern) so the bytes-per-miss lever moves instead.

**Real fix: the forecasts fallthrough (PR #5311).**

- *Before:* `forecast:predictions:v2` is 188 KB (`scripts/_forecast-dashboard.mjs:4`). Scoped at 1.3 GB/day (bootstrap share). The client hydrates once via the one-shot `getHydratedData()` (`src/services/bootstrap.ts:67-71`); its 30-minute refresh tick finds an empty hydration cache and falls through to the un-CDN'd `get-forecasts` RPC — ~17.5k origin reads/day × 188 KB, so the true cost was ~4.9 GB/day (per the #5300 investigation).
- *After:* the dossier split moved the 78%-of-payload `caseFile` evidence off the hydration list — the bootstrap key carries the list the panel renders, dropping 188 KB → 41 KB, while the canonical key keeps the dossiers for the RPC/MCP/chat readers (`scripts/_forecast-dashboard.mjs:9-21`). The refresh path was put behind the CDN: on-demand keys now fetch through `ensureHydrated` → `/api/bootstrap?keys=<name>&public=1` with a CDN cache entry per key (`src/services/bootstrap.ts:91-116`), and the bootstrap endpoint gives on-demand keys the slow-tier CDN profile rather than a tier-less default (`api/bootstrap.js:459`). The RPC is no longer the recurring reader; the periodic tick is a cache hit.
- *Lever test:* both levers moved — bytes-per-miss (188 KB → 41 KB on the list) and origin-miss rate (17.5k/day RPC misses → CDN hits). That is why this one actually reduced egress and the dedup did not.

## Related

- Epic #5300 — CDN/Redis egress reduction (closed COMPLETED 2026-07-14); PRs #5302, #5303, #5305, #5307, #5308, #5311, #5315.
- #5259 — the predecessor issue whose "Lever 1"/"Lever 2" sections first stated this framing and defined the measurement protocol; #5249 — the root regression (#4499 removed the CDN shield) that started the whole arc.
- [`../2026-07-14-bootstrap-r2-economic-comparison.md`](../2026-07-14-bootstrap-r2-economic-comparison.md) — project-specific cost record whose workload arithmetic (origin misses × measured response sizes → GB/day → dollars) operationalizes this doc's lever for the R2 origin decision (#5325).
- [`../2026-07-14-bootstrap-r2-timeout-measurement.md`](../2026-07-14-bootstrap-r2-timeout-measurement.md) — extends the probe-key technique (`bootstrap:r2-shadow-origin-marker:<tier>`) to reconcile R2-shadow vs Redis-canonical traffic.
- The prior relocation trap: #5263 (RPC work that was a no-op; the breakage was tracked as #5285, formally closed by #5287) — the direct precedent for the "routing a miss elsewhere relocates egress, it does not remove it" rule, cited in `src/services/bootstrap.ts:83-89`.
- `scripts/_forecast-dashboard.mjs` — the dashboard-vs-canonical forecast split and the 188 KB → 41 KB reasoning.
- `api/health.js` — the reader map that makes the byte-identical-but-two-readers structure legible (`:85`, `:107-108`, `:215`, `:287`).
