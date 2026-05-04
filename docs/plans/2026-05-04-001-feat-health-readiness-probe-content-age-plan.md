---
title: "feat: Health-Readiness Probe — content-age tracking distinct from seeder-run age"
type: feat
status: draft
date: 2026-05-04
origin: 2026-05-04 production incident — disease-outbreaks layer rendered empty despite /api/health reporting OK
---

# feat: Health-Readiness Probe — content-age tracking

## Sprint Status

| Sprint | Scope | PR | Status |
|---|---|---|---|
| 0 | Background + plan | — | 📝 This document |
| 1 | Infra: `runSeed` writes `newestItemAt`/`oldestItemAt`; health adds `STALE_CONTENT` status | TBD | ⏳ Not started |
| 2 | Migrate disease-outbreaks (proof-of-concept consumer) | TBD | ⏳ Not started |
| 3 | Migrate sparse seeders (climate news, IEA OPEC, central-bank releases, news-digest) | TBD | ⏳ Not started |
| 4 | Migrate annual-data seeders (WB resilience indicators) — formalize the canonical-mirror contract from #3582 | TBD | ⏳ Not started |
| 5 | (optional) Migrate fast-cadence seeders for completeness | TBD | ⏳ Not started |

## Overview

`/api/health` currently reports **seeder-run** freshness, not **content** freshness. For sparse upstream sources (WHO Disease Outbreak News publishes 1-2/week, IEA OPEC reports release monthly, central-bank policy announcements quarterly, World Bank annual indicators) these diverge: the seeder runs fine on its cron, the seed-meta `fetchedAt` stays fresh, but the freshest item the user actually sees in the cache is days or weeks old.

Today's incident (2026-05-04) is the canonical case:

- `disease-outbreaks` seeder ran 12 minutes ago, wrote `recordCount: 50`, state `OK`.
- `/api/health` reports `diseaseOutbreaks: status=OK, records=50, seedAgeMin=12, maxStaleMin=2880`.
- All 50 cached items have `publishedAt` 11+ days ago (newest WHO/CDC update is 11d old; that's normal for those sources).
- Map's 7d time-range filter drops every item → empty layer.

The seeder is healthy. The data is "fresh" in terms of fetch time. The CONTENT is stale. Health gives the wrong answer.

This plan adds a parallel content-age track that opt-in seeders declare, and surfaces a `STALE_CONTENT` status when the freshest item in the cache is older than the seeder's content-age budget.

## Goals

1. Distinguish seeder-run age from content age in `/api/health`.
2. Make the content-age contract OPT-IN — backwards compatible with every existing seeder.
3. Pilot on disease-outbreaks (where today's bug surfaced).
4. Migrate sparse seeders progressively in subsequent sprints.

## Non-goals

- Catching frontend rendering bugs (e.g. map layer wired to wrong service field).
- Catching CDN-layer cache poisoning (e.g. PR #3580's Cloudflare 30-min cache of `unavailable: true`).
- Catching auth-chain bugs (PR #3574's wm-session interceptor cross-origin issue).
- Replacing existing `STALE_SEED` / `EMPTY_DATA` semantics — those remain.
- Per-item dropdown-style health detail (UI surfaces an aggregate; per-item investigation lives in seed logs).

## Architecture

### The seed-meta shape evolves

Today's shape (per `_seed-utils.mjs:writeFreshnessMetadata`):

```jsonc
{
  "fetchedAt": 1777903487748,
  "recordCount": 50,
  "sourceVersion": "who-api-cdc-ont-v6"
}
```

After Sprint 1, opt-in seeders also write:

```jsonc
{
  "fetchedAt": 1777903487748,           // existing — seeder run time
  "recordCount": 50,                    // existing
  "sourceVersion": "who-api-cdc-ont-v6",
  // NEW (only present when seeder declared itemTimestamp)
  "newestItemAt": 1776963600000,        // freshest item's timestamp ms
  "oldestItemAt": 1745234400000,        // oldest item still in cache
  "maxContentAgeMin": 10080             // mirror of seeder declaration
}
```

Legacy seeders without `itemTimestamp` skip the new fields. Health falls back to current behavior. Zero migration risk.

### The seeder declaration

Each seeder opts in by adding two fields to its `runSeed` opts:

```js
runSeed('health', 'disease-outbreaks', CANONICAL_KEY, fetchDiseaseOutbreaks, {
  // existing
  declareRecords: (data) => data.outbreaks.length,
  maxStaleMin: 2880,                                 // 2880 min = 48h (2× cron interval)

  // NEW
  itemTimestamp: (item) => item.publishedAt,         // per-item ms timestamp extractor
  maxContentAgeMin: 10080,                           // 7 days — STALE_CONTENT trips above this

  // The full data shape is opaque to runSeed; itemTimestamp is also given the
  // option of returning null to flag malformed / undated items (which runSeed
  // counts but excludes from newestItemAt/oldestItemAt).
});
```

For seeders whose data shape is `{outbreaks: [...]}` rather than a top-level array, runSeed needs to know where the items live. Two options:

- **(a)** Add an optional `itemsPath` selector: `itemsPath: (data) => data.outbreaks`.
- **(b)** Reuse the existing `declareRecords` shape — if a seeder provides `declareRecords`, it likely already knows how to enumerate items; but `declareRecords` returns a count, not the array.

Recommended: **(a)** — explicit `itemsPath` keeps the contract straightforward and matches the seeder's own knowledge of its shape. For top-level arrays, `itemsPath` is omitted and runSeed defaults to `data` itself (when it's an array) or `data.items`/`data.records`/`data.outbreaks` autodetect (with a warn-once log on autodetect to encourage explicit declaration).

### `runSeed` enhancement

In the `atomicPublish` success path (line ~1080 of `_seed-utils.mjs`), after the canonical key is written, derive `newestItemAt`/`oldestItemAt`:

```js
let contentMeta = null;
if (typeof opts.itemTimestamp === 'function') {
  const items = (opts.itemsPath ? opts.itemsPath(publishData) : autodetectItems(publishData)) || [];
  let newest = -Infinity, oldest = Infinity;
  let undatedDropped = 0;
  for (const item of items) {
    const ts = opts.itemTimestamp(item);
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
      undatedDropped++;
      continue;
    }
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  if (newest !== -Infinity) {
    contentMeta = {
      newestItemAt: newest,
      oldestItemAt: oldest,
      maxContentAgeMin: opts.maxContentAgeMin ?? null,
    };
    if (undatedDropped > 0) {
      console.warn(`  [content-age] ${domain}:${resource}: ${undatedDropped} items with no timestamp`);
    }
  }
}
```

Then merge `contentMeta` into the seed-meta write call (or into `writeFreshnessMetadata` via an extra arg).

### `api/health.js` enhancement

Add the `STALE_CONTENT` status grade. Today `api/health.js:checkSeedKey` reads `seedMeta` and reports `OK` / `STALE_SEED` / `EMPTY_DATA` based on `seedAgeMin` and `recordCount`. The new logic:

```js
function classifyHealth(meta, freshnessConfig) {
  const now = Date.now();
  const seedAgeMin = (now - meta.fetchedAt) / 60000;
  if (meta.recordCount === 0 && !freshnessConfig.allowEmpty) return 'EMPTY_DATA';
  if (seedAgeMin > freshnessConfig.maxStaleMin) return 'STALE_SEED';

  // NEW — only checked when the seeder opted in
  if (typeof meta.newestItemAt === 'number' && typeof meta.maxContentAgeMin === 'number') {
    const contentAgeMin = (now - meta.newestItemAt) / 60000;
    if (contentAgeMin > meta.maxContentAgeMin) return 'STALE_CONTENT';
  }
  return 'OK';
}
```

`STALE_CONTENT` is structurally distinct from `STALE_SEED`. Operator playbooks differ:

- `STALE_SEED` → seeder is broken; check Railway logs.
- `STALE_CONTENT` → upstream isn't publishing (or our parser is dropping recent items); check the source.

Health response surfaces both ages when the seeder opted in:

```jsonc
"diseaseOutbreaks": {
  "status": "STALE_CONTENT",
  "records": 50,
  "seedAgeMin": 12,
  "maxStaleMin": 2880,
  "contentAgeMin": 15840,
  "maxContentAgeMin": 10080
}
```

## Migration plan

### Sprint 1 — Infra (PR 1)

Files touched:
- `scripts/_seed-utils.mjs`: add `itemTimestamp` / `itemsPath` / `maxContentAgeMin` opts to runSeed; compute newest/oldest during publish; extend `writeFreshnessMetadata` with the two new fields. Backwards-compatible: existing callers pass nothing and get exactly today's behavior.
- `api/health.js`: read new fields when present, derive `contentAgeMin`, add `STALE_CONTENT` status. Existing seeders unaffected.
- `tests/seed-utils-empty-data-failure.test.mjs`: add 3 cases:
  - seeder with `itemTimestamp` writes `newestItemAt`/`oldestItemAt`.
  - seeder without `itemTimestamp` writes legacy shape (no new fields).
  - undated items are excluded from newest/oldest computation but still counted.
- `tests/health-content-age.test.mjs` (NEW): scoped test for the health classifier — `STALE_CONTENT` fires correctly, doesn't fire for legacy seeders, doesn't shadow `STALE_SEED`/`EMPTY_DATA`.

Estimated LOC: ~150 production + ~120 test.

Ship-gate: every existing health entry stays at `OK` post-deploy (verified by snapshot of pre/post `/api/health` JSON).

### Sprint 2 — Disease-outbreaks pilot (PR 2)

Single-file change to `scripts/seed-disease-outbreaks.mjs`:

```js
runSeed('health', 'disease-outbreaks', CANONICAL_KEY, fetchDiseaseOutbreaks, {
  ...,
  itemsPath: (data) => data.outbreaks,
  itemTimestamp: (item) => item.publishedAt,
  maxContentAgeMin: 14 * 24 * 60,  // 14 days — accommodates WHO DON's sparse cadence
});
```

Verification: trigger Railway bundle, observe `/api/health.diseaseOutbreaks` shows `contentAgeMin` and matches actual newest cached item age. Today's bug-pattern would now flag `STALE_CONTENT` instead of `OK`.

### Sprint 3 — Sparse seeders (PRs 3a/3b/3c)

Migrate the highest-value sparse seeders one at a time, each PR ≤ 1 file:

| Seeder | Shape | Recommended `maxContentAgeMin` |
|---|---|---|
| `seed-climate-news.mjs` | `{items: [...]}` with `publishedAt` | 7d (climate news cadence) |
| `seed-iea-oil-stocks.mjs` | monthly | 45d (IEA monthly + 2 weeks slack) |
| `seed-news-feed-digest` (Vercel-side) | per-feed cache | reuse the existing `CACHE_TTL_HEALTHY_S` budget |
| `seed-economic-stress.mjs` | weekly | 14d |

### Sprint 4 — Annual-data seeders (PR 4)

Annual indicators (WB resilience: `power-losses`, `low-carbon-generation`, `fossil-electricity-share`, plus IMF/WEO/etc.) need `maxContentAgeMin` set to `365d + slack` since the underlying data IS yearly. This pairs with PR #3582's canonical-envelope-mirror behavior — the mirror writes `fetchedAt` from canonical's original timestamp, and `maxContentAgeMin` 13-14 months keeps the panel green during normal between-publication gaps.

### Sprint 5 — Fast-cadence (optional)

Earthquakes, market quotes, FIRMS fires — for these, `seedAgeMin ≈ contentAgeMin` so the new field is redundant. Migrate only if uniformity is desired.

## Rollout

- PR 1 land + verify zero health regressions for 24 hours.
- PR 2 land + verify disease-outbreaks correctly surfaces `STALE_CONTENT` on the next bundle tick when items are stale.
- PR 3a/3b/3c land staggered (1-2 days apart) — easy to revert if any one seeder declares a wrong `maxContentAgeMin` and over-pages.
- PR 4 land last; close out the canonical-envelope-mirror story from #3582.

Each PR is independently shippable; no cross-PR coordination required.

## Risk and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wrong `maxContentAgeMin` on some seeder → false `STALE_CONTENT` page-out | medium | Per-seeder declaration + opt-in migration. If wrong, single-file revert. |
| `itemTimestamp` extractor throws on malformed items | low | Try/catch in runSeed; log + skip per-item. Aggregate fail tolerated; never breaks the publish. |
| seed-meta size grows | low | +3 fields × 50ish active seeders ≈ trivial Redis impact. |
| Health endpoint payload grows | low | +2 fields per seeded entry; tens of bytes. |

## Open questions

1. **Should `STALE_CONTENT` page operators?** Or be a "log warning" tier? Today `STALE_SEED` triggers ops attention; `STALE_CONTENT` is genuinely outside operator control (upstream cadence). Recommendation: surface in health JSON but de-rank vs. `STALE_SEED` in alerting.

2. **Per-item filter alignment with consumer-side filters?** PR #3593 already disabled the map's 7d time filter for diseaseOutbreaks. If we add `STALE_CONTENT` checks for the same data, we're saying "this layer's data is stale" while showing it anyway. Acceptable: the layer surfaces "we have data", health surfaces "but it's old" — operator can decide whether to surface a UI hint ("most recent: 11d ago").

3. **Historical retention?** `oldestItemAt` is informational — useful for spotting when a seeder mass-deletes old items unexpectedly. Worth keeping; trivial cost.

## Definition of done

- [ ] `_seed-utils.mjs` accepts `itemTimestamp` / `itemsPath` / `maxContentAgeMin` opts and writes the three new seed-meta fields.
- [ ] `api/health.js` reports `STALE_CONTENT` when the seeder opted in and content is stale.
- [ ] Tests cover: opt-in writes new fields, legacy seeders unchanged, classifier respects all four status grades.
- [ ] Disease-outbreaks pilot ships and is verified.
- [ ] At least 3 sparse seeders migrated (Sprint 3).
- [ ] At least 1 annual-data seeder migrated (Sprint 4) — formalizes the canonical-mirror contract.

## Companion incidents

This plan emerged from production incidents that current health doesn't catch:

- **2026-05-04 disease-outbreaks** (this plan's origin): seed-meta fresh, items 11d old, layer empty.
- **2026-05-03 power-losses**: seeder ran but validateFn rejected partial fetch; PR #3582 fixed the seed-meta poisoning, this plan adds the explicit content-age contract.
- **PR #3556 news-digest**: cached non-RSS bodies; partly addressed by `looksLikeRssXml`. Content-age would have caught the empty cache faster.

The pattern: **fetched-recently is not the same as fresh-content.** This plan makes the distinction first-class.
