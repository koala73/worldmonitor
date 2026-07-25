---
module: product-catalog
date: 2026-07-22
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when: "Catalog copy or pricing changed in a merged PR but https://api.worldmonitor.app/api/product-catalog still serves the old payload"
symptoms:
  - "DELETE /api/product-catalog returns {purged:true} but a plain GET still serves the old tiers"
  - "cf-cache-status: HIT with a rewritten cache-control (max-age=1800) that matches none of the handler's values"
  - "x-product-catalog-source: cache with a fetchedAt timestamp hours in the past"
resolution_type: workflow_improvement
tags: [product-catalog, cache-purge, cloudflare, vercel-cdn, redis, ais-relay, cdn-staleness]
---

# Purging the live product catalog is a three-layer eviction

## Context

After merging a catalog change (PR #5419 added a feature bullet to the API Starter tier), `DELETE /api/product-catalog` returned `{"purged":true}` yet the public URL kept serving the old feature list. The purge endpoint only clears **one of three** stale layers, and the observable signals actively mislead: the purge response is not proof (the handler's `purgeCache()` swallows errors — `api/product-catalog.js:152`), and a HEAD request hits the `req.method !== 'GET'` branch and returns 405 (`api/product-catalog.js:265`), so header-only probes describe an error response, not the cached payload.

## Guidance

The serving path is: **Redis (`product-catalog:v2`, written by the ais-relay Dodo loop) → Vercel CDN (`s-maxage=600` + `stale-while-revalidate=300` on cache hits, `api/product-catalog.js:272`) → Cloudflare (api zone rewrites the edge TTL to ~30 min)**. A complete eviction after a catalog change:

1. **Wait for the ais-relay Railway deploy to finish first.** The relay rewrites the Redis key on every tick; purging while the old relay is live just gets old data re-seeded.
2. **Purge Redis**: `DELETE /api/product-catalog` with `Authorization: Bearer <RELAY_SHARED_SECRET>`. If it returns 401, the secret was probably empty — shell-`source`-ing an env file can silently yield an empty value; build the request from a real env-file parse (e.g. in Python) instead.
3. **Verify at true origin, not through the CDNs**: request with a cache-buster (`?cb=<anything>`), which changes the cache key for both Vercel and Cloudflare. Read `x-product-catalog-source` — `cache` means Redis answered; `dodo`/`partial`/`fallback` means Redis is empty and the deployed function built the payload itself. `fetchedAt` in the body dates whatever payload you got.
4. **Purge Cloudflare last, and only after the Vercel CDN copy expired** (~11 min: `s-maxage=600` + SWR). Purge the exact URL via the zone `purge_cache` API using a token with cache-purge permission on the `worldmonitor.app` zone. Purging CF earlier makes it re-fetch — and re-pin — the still-stale Vercel copy for another edge TTL.

Convergence is self-healing even with no CF purge (relay tick + CDN TTL expiry, worst case ~40 min); the ordered purge just makes it immediate.

## Why This Matters

Each layer reports "fresh" from its own perspective: Redis purge returns success, Vercel serves `x-vercel-cache: MISS` while its sibling regions hold copies, and Cloudflare re-validates against a stale upstream and restamps `age: 0`. During the PR #5419 rollout we observed Cloudflare serving `age=814` copies of a body whose `s-maxage` was 600 — SWR extends the window past the naive TTL math. Without knowing the topology, a correct deploy looks broken and a real purge looks like it failed.

## When to Apply

- A pricing/catalog PR merged but `https://api.worldmonitor.app/api/product-catalog` serves old tiers.
- Any debugging of "purge didn't work" on an endpoint fronted by both Vercel's CDN and Cloudflare.
- Note: the `/pro` pricing cards are mostly insulated from this — `PricingSection` prefers the locale `pricing.tiers.*.features` arrays baked into the bundle over the fetched catalog, so English card copy updates on deploy regardless.

## Examples

Watcher output showing the layers converge only after the *second*, correctly-timed CF purge:

```
t+0s:   bullet=False n=6 src=cache    cf=HIT     age=70    ← CF holds pre-purge body
t+241s: bullet=False n=6 src=cache    cf=EXPIRED age=512   ← CF revalidated against stale Vercel copy
t+543s: bullet=False n=6 src=cache    cf=EXPIRED age=814   ← SWR still serving past s-maxage
cf purge: True                                             ← Vercel copy now expired; purge CF
t+726s: bullet=True  n=7 src=fallback cf=MISS    age=0     ← fresh origin through all layers
```

True-origin probe (bypasses both CDNs):

```bash
curl -s "https://api.worldmonitor.app/api/product-catalog?cb=$RANDOM" -A "Mozilla/5.0" \
  -D - -o /tmp/cat.json | grep -i x-product-catalog-source
```
