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
| 0 | Background + plan | #3594 | 📝 This document |
| 1 | Infra: `runSeed` writes content-age fields into `_seed` envelope; `readCanonicalEnvelopeMeta` mirrors them; `api/health.js` adds `STALE_CONTENT` | TBD | ⏳ Not started |
| 2 | Migrate disease-outbreaks (proof-of-concept consumer) — depends on PR #3593 frontend filter fix already deployed | TBD | ⏳ Not started |
| 3 | Migrate sparse seeders (climate news, IEA OPEC, central-bank releases, news-digest) | TBD | ⏳ Not started |
| 4 | Migrate annual-data seeders (WB resilience indicators) — formalize the canonical-mirror contract from #3582 | TBD | ⏳ Not started |
| 5 | (optional) Migrate fast-cadence seeders for completeness | TBD | ⏳ Not started |

## Overview

`/api/health` currently reports **seeder-run** freshness, not **content** freshness. For sparse upstream sources (WHO Disease Outbreak News publishes 1-2/week, IEA OPEC reports release monthly, central-bank policy announcements quarterly, World Bank annual indicators) these diverge: the seeder runs fine on its cron, the seed-meta `fetchedAt` stays fresh, but the freshest item the user actually sees in the cache is days or weeks old.

Today's incident (2026-05-04) is the canonical case:

- `disease-outbreaks` seeder ran 12 minutes ago, wrote `recordCount: 50`, state `OK`.
- `/api/health` reports `diseaseOutbreaks: status=OK, records=50, seedAgeMin=12, maxStaleMin=2880`.
- All 50 cached items have `publishedAt` 11+ days ago (newest WHO/CDC update is 11d old; that's normal for those sources).
- Map's 7d time-range filter drops every item → empty layer (PR #3593 disabled the filter, but the underlying staleness was still invisible to ops).

The seeder is healthy. The data is "fresh" in terms of fetch time. The CONTENT is stale. Health gives the wrong answer.

This plan adds a parallel content-age track that opt-in seeders declare, and surfaces a `STALE_CONTENT` status when the freshest item in the cache is older than the seeder's content-age budget.

## Goals

1. Distinguish seeder-run age from content age in `/api/health`.
2. Make the content-age contract OPT-IN — backwards compatible with every existing seeder.
3. Pilot on disease-outbreaks (where today's bug surfaced) — pilot budget chosen so the actual incident WOULD have tripped the new alarm.
4. Migrate sparse seeders progressively in subsequent sprints.

## Non-goals

- Catching frontend rendering bugs (e.g. map layer wired to wrong service field).
- Catching CDN-layer cache poisoning (e.g. PR #3580's Cloudflare 30-min cache of `unavailable: true`).
- Catching auth-chain bugs (PR #3574's wm-session interceptor cross-origin issue).
- Replacing existing `STALE_SEED` / `EMPTY_DATA` / `COVERAGE_PARTIAL` / `SEED_ERROR` / `EMPTY` semantics — those remain.
- Per-item dropdown-style health detail (UI surfaces an aggregate; per-item investigation lives in seed logs).

## Architecture

### The seeder contract (revised after Codex round 1)

Each seeder opts in by passing **a single domain-specific function** — `contentMeta` — that knows the publish payload's shape and returns the timestamps directly. No generic `itemsPath` autodetection, no per-item callbacks (Codex P2 + alternative): the seeder owns shape knowledge, runSeed owns wiring.

```js
runSeed('health', 'disease-outbreaks', CANONICAL_KEY, fetchDiseaseOutbreaks, {
  // existing
  declareRecords: (data) => data.outbreaks.length,
  maxStaleMin: 2880,                                 // 2× cron interval (48h)

  // NEW
  contentMeta: (data) => {
    // Return {newestItemAt, oldestItemAt} in epoch-ms. Returning null
    // signals "this batch has no usable content timestamps" — runSeed
    // writes newestItemAt: null into seed-meta, health classifies it
    // as STALE_CONTENT (not OK). Items whose timestamp was synthesized
    // (e.g. Date.now() fallback when upstream omits a date) MUST be
    // EXCLUDED here — preserving them would suppress the stale-content
    // alarm with manufactured freshness. See disease-outbreaks
    // migration below for the concrete pattern.
    let newest = -Infinity, oldest = Infinity, validCount = 0;
    for (const item of data.outbreaks) {
      // _publishedAtIsSynthetic flag set by the seeder when it falls
      // back to Date.now(). Plan-level requirement; per-seeder
      // implementation in Sprint 2.
      if (item._publishedAtIsSynthetic) continue;
      const ts = item.publishedAt;
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
      // Future-timestamp guard: clock-skew tolerance of 1h. Beyond
      // that, treat as malformed (matches list-feed-digest's
      // FUTURE_DATE_TOLERANCE_MS pattern).
      if (ts > Date.now() + 60 * 60 * 1000) continue;
      validCount++;
      if (ts > newest) newest = ts;
      if (ts < oldest) oldest = ts;
    }
    if (validCount === 0) return null;
    return { newestItemAt: newest, oldestItemAt: oldest, validCount };
  },
  maxContentAgeMin: 9 * 24 * 60,    // 9 days — see "pilot threshold" below
});
```

### Why `contentMeta` returns `null` matters

When the seeder is opted-in (`contentMeta` is declared) AND `recordCount > 0` AND `contentMeta` returns `null`, that is NOT the same as "no content-age check": health treats it as `STALE_CONTENT` (P1b). The seeder declared a contract; failing to produce timestamps means the data is unusable for content-age, which is a real signal worth surfacing.

This also catches today's specific failure mode for any future seeder that drifts to `Date.now()` fallbacks: those items get filtered out by `_publishedAtIsSynthetic`, `validCount` drops to 0, `contentMeta` returns null, health flags `STALE_CONTENT`.

### `runSeed` validation up-front (Codex P1d)

When `contentMeta` is declared, `maxContentAgeMin` MUST be a positive finite integer (minutes). Hard-fail at config time, not at write time:

```js
if (typeof opts.contentMeta === 'function') {
  if (!Number.isInteger(opts.maxContentAgeMin) || opts.maxContentAgeMin <= 0) {
    throw new Error(
      `[seed-contract] ${domain}:${resource} declares contentMeta but ` +
      `maxContentAgeMin is missing/invalid (got: ${opts.maxContentAgeMin}). ` +
      `Required: positive integer minutes.`,
    );
  }
}
```

Rejects misconfigurations like `maxContentAgeMin: undefined` (the original `?? null` silently-disabled-but-looks-opted-in trap).

### The `_seed` envelope is the source of truth (Codex P0b)

The single biggest correctness issue Codex flagged: PR #3582's `readCanonicalEnvelopeMeta` returns only `{fetchedAt, recordCount, sourceVersion}`. When validate-fail fires (e.g. WB partial fetch, today's `power-losses` pattern), the validation-fail mirror at `_seed-utils.mjs:1127` rewrites `seed-meta` from that subset — which would lose any content-age fields written on the prior healthy run. The probe disappears exactly when last-good-with-stale-content data is being served — the worst possible time for the alarm to vanish.

Fix: content-age fields go into the `_seed` envelope alongside `fetchedAt`/`recordCount`/`sourceVersion`/`schemaVersion`/`state`. They are part of canonical state, not a separate side-channel. Concretely:

1. `runSeed` builds `envelopeMeta` with the new fields when `contentMeta` is declared:
   ```jsonc
   {
     "fetchedAt": 1777903487748,
     "recordCount": 50,
     "sourceVersion": "who-api-cdc-ont-v6",
     "schemaVersion": 1,
     "state": "OK",
     // NEW
     "newestItemAt": 1776963600000,           // null when contentMeta returned null
     "oldestItemAt": 1745234400000,           // null when contentMeta returned null
     "maxContentAgeMin": 12960                // mirror of seeder declaration
   }
   ```
2. `readCanonicalEnvelopeMeta` (PR #3582's helper at `_seed-utils.mjs:315`) extends to read and pass through the three new fields.
3. The validate-fail mirror branch at `_seed-utils.mjs:1127` rewrites seed-meta with the same subset — content fields preserved.
4. seed-meta and the `_seed` envelope carry the same shape (modulo the data payload). `seed-meta:*` keys mirror `_seed` for legacy readers (health, bundle runner, freshness registry).

Result: validate-fail keeps surfacing the actual content-age of last-good data. If the `power-losses` incident from PR #3582 had happened with content-age in play, health would still report the original `fetchedAt` (correct) AND the original `newestItemAt` (also correct) and only flip `STALE_CONTENT` when the canonical content genuinely ages out — months later, since WB EG.ELC.LOSS.ZS is annual.

### `api/health.js` changes (Codex P1c — corrected target symbols)

The original plan referenced `checkSeedKey` and `classifyHealth` — neither exists. Real surfaces:

| Symbol | Location | Change |
|---|---|---|
| `readSeedMeta(key)` | `api/health.js:?` (around line 200) | Read the three new fields when present; default to undefined for legacy seeders. |
| `classifyKey(meta, config)` | `api/health.js:560` | Add `STALE_CONTENT` branch. Precedence (most → least severe): `SEED_ERROR > (OK_CASCADE / EMPTY_ON_DEMAND / REDIS_PARTIAL) > EMPTY_DATA > STALE_SEED > COVERAGE_PARTIAL > STALE_CONTENT > OK`. |
| `STATUS_COUNTS` | `api/health.js:?` | Add `STALE_CONTENT` bucket. |
| `problemKeys` collector | `api/health.js:?` | Include `STALE_CONTENT` keys in the operator-attention list. |
| Per-key response object | `api/health.js:?` | Add `contentAgeMin` and `maxContentAgeMin` fields when present in seed-meta. |

**Implementation note (do NOT copy a stale snippet):** the actual `classifyKey` body lives at `api/health.js:597+`. Critically, `classifyKey` does NOT return bare strings — it builds an entry object and assigns to a local `status` variable via `status = 'X';` then returns the populated entry. Copying a `return 'STALE_CONTENT'` snippet would break the entry shape and downstream consumers (`checks.<key>`, `problemKeys`, `STATUS_COUNTS`).

The Sprint 1 work is to **insert exactly ONE new `else if` branch** immediately before the existing `else { status = 'OK'; }` fall-through, mirroring the assignment pattern already used by every preceding branch:

```js
// PSEUDOCODE — match the EXACT assignment pattern used by sibling branches
// at api/health.js:597+. The classifier reads `now` from ctx (not Date.now()
// directly) and writes `status` rather than returning a bare string.
//
// Insert location: as a new `else if` immediately before the existing
// `else { status = 'OK'; }` clause. NO existing branch is reordered,
// removed, or modified. NO function signature change.
} else if (typeof meta.maxContentAgeMin === 'number') {
  if (meta.newestItemAt == null) {
    status = 'STALE_CONTENT';
  } else if ((now - meta.newestItemAt) / 60000 > meta.maxContentAgeMin) {
    status = 'STALE_CONTENT';
  } else {
    status = 'OK';
  }
} else {
  status = 'OK';   // unchanged existing fall-through
}
```

The implementer's task is therefore: open `api/health.js`, locate the `else { status = 'OK'; }` line at the bottom of `classifyKey`, replace it with the `else if`/`else` block above using the exact `status = '...';` assignment pattern (NOT bare returns), reuse `ctx.now` if that's how the surrounding code reads time. NO existing branch is reordered.

Existing branches preserved verbatim (positions reflect api/health.js as of main HEAD):
1. Redis partial → REDIS_PARTIAL
2. meta.error / read failure → SEED_ERROR
3. cascade-ok branches → OK_CASCADE
4. on-demand-empty branches → EMPTY_ON_DEMAND
5. !meta → EMPTY
6. recordCount === 0 (with allowEmpty handling) → EMPTY_DATA
7. seedAgeMin > maxStaleMin → STALE_SEED
8. coverage-mode shortfall → COVERAGE_PARTIAL
9. **NEW** — `meta.maxContentAgeMin` set + content stale → STALE_CONTENT
10. fall-through → OK

Health response per-key shape evolves:

```jsonc
"diseaseOutbreaks": {
  "status": "STALE_CONTENT",
  "records": 50,
  "seedAgeMin": 12,
  "maxStaleMin": 2880,
  "contentAgeMin": 15840,         // NEW — only present when opted in
  "maxContentAgeMin": 12960       // NEW
}
```

### Pilot threshold (Codex P0a)

Sprint 2 (disease-outbreaks pilot) sets `maxContentAgeMin: 9 * 24 * 60 = 12960` minutes (9 days). The 2026-05-04 incident had a newest-item age of 11+ days — which would correctly trip the new alarm at 9 days. Setting it higher (the original draft said 14d) would have left the actual incident hidden, defeating the pilot's purpose.

The 9-day window is also defensible against false-positives:
- WHO Disease Outbreak News publishes 1-2/week (typical gap: 3-5d).
- CDC Health Alert Network is more sporadic but rarely silent for a full week.
- ThinkGlobalHealth (TGH) is a daily ProMED feed (PR #3593 fixed the parse — going forward TGH should keep `newestItemAt` < 1d).

A 9-day budget tolerates a single quiet WHO/CDC week before flagging. Tighter (3-5d) would page operators on normal upstream rhythm.

### Cross-dependency on PR #3593

The frontend fix in PR #3593 (deployed 2026-05-04) is independent of this plan, but the verification story for Sprint 2 depends on it landing first. Without #3593, even with `STALE_CONTENT` correctly firing, the map layer would still show 0 items (the 7d UI filter dropped them all). With #3593 deployed, the UI shows the items AND health flags `STALE_CONTENT` — operator gets the right signal, user gets the rendered (de-ranked) data.

## Migration plan

### Sprint 1 — Infra (PR 1)

Sprint 1 must extend the **entire envelope writer chain**, not just `runSeed`. Codex round 2 P0: `buildEnvelope` at `scripts/_seed-envelope-source.mjs:80` destructures only the existing fields — adding new fields to runSeed alone is insufficient because they'd be silently dropped before reaching the canonical `_seed` block, breaking the validate-fail mirror that's supposed to preserve them.

Files touched:

**Envelope shape (parity required across 3 mirrors):**
- `scripts/_seed-envelope-source.mjs`:
  - Extend `buildEnvelope()` destructure at line 80 to accept and emit `newestItemAt` / `oldestItemAt` / `maxContentAgeMin`.
  - Update `unwrapEnvelope()` if it strips unknown keys.
- `api/_seed-envelope.js`: mirror identical changes (used by Vercel edge readers like `getCachedJson`).
- `server/_shared/seed-envelope.ts`: mirror identical changes (used by RPC handlers); update the `SeedMeta` interface to add the three new optional fields.
- `scripts/verify-seed-envelope-parity.mjs`: re-run; assert all three mirrors agree on the new fields.

**Contract validator:**
- `scripts/_seed-contract.mjs` (or wherever `runSeed` validates contract fields):
  - Add `contentMeta` (function | undefined) and `maxContentAgeMin` (positive integer | undefined) to the recognized opts so they don't soft-warn as "unknown contract fields".

**runSeed wiring:**
- `scripts/_seed-utils.mjs`:
  - Add `contentMeta` / `maxContentAgeMin` opts to `runSeed`. Validate up-front: when `contentMeta` is declared, `maxContentAgeMin` must be a positive finite integer (Codex round 1 P1d) — throw at config time.
  - **Order contract (Codex round 3 P2):** `contentMeta(rawData)` runs BEFORE `publishTransform(rawData)`. Seeders that need to keep helper fields visible to `contentMeta` but stripped from the public payload rely on this ordering. Document it in the runSeed JSDoc and assert it in `tests/seed-content-age-contract.test.mjs`.
  - Compute content fields during atomicPublish from `contentMeta(rawData)` return value. Treat `null` return as "no usable content timestamps" → write `newestItemAt: null`. Exceptions thrown by `contentMeta` are caught and treated identically to `null`.
  - Extend `readCanonicalEnvelopeMeta` (line ~315) to read the three new fields from `_seed`.
  - Update the validate-fail mirror branch at line ~1127 to write content fields back into seed-meta when mirroring (Codex round 1 P0b).
  - Extend `writeFreshnessMetadata` (and any sibling seed-meta writers) to accept + emit the three new fields.

**Health classifier:**
- `api/health.js`:
  - Update `readSeedMeta` to surface the three new fields when present (Codex round 1 P1c).
  - Update `classifyKey` at line 623 with the `STALE_CONTENT` branch. Codex round 2 P1: actual current precedence in the code is `(redis read errors) → SEED_ERROR → empty/cascade/on-demand → EMPTY_DATA → STALE_SEED → COVERAGE_PARTIAL`. We do NOT change this order. Insert `STALE_CONTENT` AFTER `COVERAGE_PARTIAL`, BEFORE the OK return:
    1. Redis read errors → existing behavior
    2. `SEED_ERROR`
    3. Empty/cascade/on-demand existing branches → `OK_CASCADE`, `EMPTY_ON_DEMAND`, `REDIS_PARTIAL`
    4. `EMPTY_DATA`
    5. `STALE_SEED`
    6. `COVERAGE_PARTIAL`
    7. **`STALE_CONTENT` (NEW)** — only when `meta.maxContentAgeMin` is set
    8. `OK`
  - Add `STALE_CONTENT` to `STATUS_COUNTS` initialization and increments.
  - Include `STALE_CONTENT` keys in `problemKeys`.
  - Surface `contentAgeMin` and `maxContentAgeMin` on the per-key response when present in seed-meta.

Tests:
- `tests/seed-utils-empty-data-failure.test.mjs` (extend existing):
  - opted-in seeder writes `newestItemAt`/`oldestItemAt`/`maxContentAgeMin` into both the `_seed` envelope AND `seed-meta:*`.
  - legacy seeder (no `contentMeta`) emits exactly today's shapes — anti-regression.
  - canonical-mirror path on validate-fail PRESERVES content fields end-to-end (Codex round 1 P0b + round 2 P0).
- `tests/seed-envelope-parity.test.mts` (or whatever the existing parity test is): assert all three envelope mirrors carry the three new fields.
- `tests/seed-content-age-contract.test.mjs` (NEW): scoped test for the contract:
  - `contentMeta` returning `null` → `newestItemAt: null` written, classifier reports `STALE_CONTENT`.
  - `contentMeta` declared without valid `maxContentAgeMin` → runSeed throws at config time (Codex round 1 P1d).
  - `contentMeta` THROWS at runtime → caught, treated as `null`, runSeed continues.
  - future-dated items beyond 1h clock-skew tolerance excluded.
  - all-undated opted-in data with `recordCount > 0` → `STALE_CONTENT`, not silent OK (Codex round 1 P1b).
- `tests/health-content-age.test.mjs` (NEW): scoped classifier test:
  - `STALE_CONTENT` placement in precedence: only fires when no earlier status (`SEED_ERROR`, `EMPTY`, `OK_CASCADE`, `EMPTY_ON_DEMAND`, `REDIS_PARTIAL`, `EMPTY_DATA`, `STALE_SEED`, `COVERAGE_PARTIAL`) applies (Codex round 2 P1).
  - `STATUS_COUNTS` correctly buckets the new status.
  - `problemKeys` includes `STALE_CONTENT` keys.
  - Test matrix explicitly includes `REDIS_PARTIAL`, `OK_CASCADE`, `EMPTY_ON_DEMAND` to confirm they take precedence over `STALE_CONTENT`.
  - legacy seeders unaffected (no new fields → OK / STALE_SEED / EMPTY_DATA only).

Estimated LOC: ~280 production (envelope mirrors × 3 + contract + runSeed + health) + ~250 test.

Ship-gate: every existing health entry stays at the same status post-deploy (verified by snapshot of pre/post `/api/health` JSON for all 90+ tracked seeders) AND `verify-seed-envelope-parity.mjs` passes.

### Sprint 2 — Disease-outbreaks pilot (PR 2)

Codex round 2 P2: setting `publishedMs` to `null` breaks the existing `!isNaN(publishedMs)` filters at lines 110/139 (`isNaN(null) === false` so the filter would now ACCEPT undated items, which is the opposite of intent) AND `mapItem` at line 237 writes `publishedAt: item.publishedMs` directly — null would propagate into the cached item shape and break consumers.

Correct migration: carry `_originalPublishedMs` and `_publishedAtIsSynthetic` as PARALLEL fields through the entire parser → mapItem pipeline, while keeping `publishedMs` as a non-null number for the existing filters and consumer compat.

Single-file change (`scripts/seed-disease-outbreaks.mjs`):

**Step 2.1 — Parser changes (THREE sources: WHO DON, RSS feeds, ThinkGlobalHealth):**

All three parsers produce items with `publishedMs`. Today they fall back to `Date.now()` (WHO/RSS) or skip entirely on missing date (TGH at line 195 already filters). Migration must touch ALL THREE — leaving TGH unmigrated means `contentMeta` excludes the daily-fresh backbone and the pilot fails to surface real freshness:

```js
// Before (WHO DON, lines ~104-110):
return items.map((item) => ({
  title: (item.Title || '').trim(),
  link: item.ItemDefaultUrl ? `https://www.who.int${item.ItemDefaultUrl}` : '',
  desc: '',
  publishedMs: item.PublicationDateAndTime ? new Date(item.PublicationDateAndTime).getTime() : Date.now(),
  sourceName: 'WHO',
})).filter(i => i.title && !isNaN(i.publishedMs));

// After:
return items.map((item) => {
  const origMs = item.PublicationDateAndTime
    ? new Date(item.PublicationDateAndTime).getTime()
    : null;
  const hasOrig = origMs != null && Number.isFinite(origMs);
  return {
    title: (item.Title || '').trim(),
    link: item.ItemDefaultUrl ? `https://www.who.int${item.ItemDefaultUrl}` : '',
    desc: '',
    // Keep publishedMs non-null for existing filters + consumer compat.
    publishedMs: hasOrig ? origMs : Date.now(),
    // NEW — parallel fields for content-age contract.
    _originalPublishedMs: hasOrig ? origMs : null,
    _publishedAtIsSynthetic: !hasOrig,
    sourceName: 'WHO',
  };
}).filter(i => i.title && Number.isFinite(i.publishedMs));
```

Mirror identical pattern in the RSS parser at line ~138 (`pubDate ? new Date(pubDate).getTime() : Date.now()`).

**TGH parser (line ~200) — different shape, same intent.** TGH currently `continue`s when `rec.date` is missing or unparseable (line 197), so all surviving items have a valid upstream date. The migration is therefore additive — every TGH item gets `_publishedAtIsSynthetic: false` and `_originalPublishedMs` set to the parsed timestamp:

```js
// Before (TGH, ~line 200):
items.push({
  title: `${rec.diseases}${rec.country ? ` - ${rec.country}` : ''}`,
  link: rec.link || '',
  desc: rec.summary ? rec.summary.slice(0, 300) : '',
  publishedMs,
  sourceName: 'ThinkGlobalHealth',
  _country: rec.country || '',
  _disease: rec.diseases || '',
  _location: cityName,
  _lat: ...,
  _lng: ...,
  _cases: ...,
});

// After:
items.push({
  ...same fields as above...,
  publishedMs,                                    // unchanged — same parsed value
  // NEW — TGH always has a parsed date by this point (line 197 filtered).
  _originalPublishedMs: publishedMs,
  _publishedAtIsSynthetic: false,
});
```

This is critical: TGH is the daily-fresh source. Without these tags, `contentMeta` would skip every TGH item, leaving newest-item-age dictated by WHO/CDC sparse cadence. The pilot would alarm on normal upstream rhythm. Migration MUST cover TGH.

**Step 2.2 — `mapItem` (line ~237):**

Carry the new fields through `mapItem` so they're visible to `contentMeta` at runSeed time. These fields exist ONLY in the in-memory pre-publish data (the fetcher's return value); they are stripped before the canonical key is written via `publishTransform` (see Step 2.3). They MUST NOT appear in:

- The Redis canonical key `health:disease-outbreaks:v1`
- The `/api/bootstrap` response (`data.diseaseOutbreaks`)
- The `list-disease-outbreaks` RPC response
- Any TypeScript proto-generated type (`DiseaseOutbreakItem`)

```js
// Before:
return {
  ...,
  publishedAt: item.publishedMs,
  ...,
};

// After (PRE-publish, in-memory only):
return {
  ...,
  publishedAt: item.publishedMs,                      // unchanged, non-null, public
  // PRE-PUBLISH HELPERS — used by contentMeta at runSeed time, then
  // stripped by publishTransform before publish. NEVER appear in the
  // cached canonical key or any client-visible response. See Step 2.3.
  _publishedAtIsSynthetic: item._publishedAtIsSynthetic === true,
  _originalPublishedMs: item._originalPublishedMs ?? null,
  ...,
};
```

The `_originalPublishedMs` is informational; the contract only needs `_publishedAtIsSynthetic` to exclude items, but carrying both lets future debugging distinguish "WHO sent a date we couldn't parse" from "WHO sent no date at all". Both are stripped in Step 2.3 — this is a strict in-memory pipeline contract.

**Step 2.3 — runSeed opts (with helper-field strip via publishTransform):**

`_publishedAtIsSynthetic` and `_originalPublishedMs` MUST NOT leak to clients. Cached disease data is returned directly to the browser by `server/worldmonitor/health/v1/list-disease-outbreaks.ts:16` and via `/api/bootstrap` (the `diseaseOutbreaks` cached key). Without stripping, the underscore-prefixed helpers become part of the public proto-typed response and a future schema change.

The fix is a publishTransform that strips the helpers AFTER `contentMeta` runs but BEFORE atomicPublish writes the canonical key. This requires `runSeed` to invoke `contentMeta` on the **raw fetcher output** (with helpers intact), then apply `publishTransform` to produce the public payload:

**Sprint 1 contract addition:** `runSeed` MUST call `contentMeta(rawData)` BEFORE `publishTransform(rawData)`. Document this ordering explicitly in the runSeed JSDoc and assert it in `tests/seed-content-age-contract.test.mjs`.

**Disease seeder runSeed opts:**

```js
contentMeta: (data) => {
  // Read helper fields from raw data (pre-publishTransform).
  let newest = -Infinity, oldest = Infinity, validCount = 0;
  for (const item of data.outbreaks) {
    if (item._publishedAtIsSynthetic === true) continue;
    const ts = item._originalPublishedMs;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
    if (ts > Date.now() + 60 * 60 * 1000) continue;     // 1h clock-skew tolerance
    validCount++;
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  if (validCount === 0) return null;
  return { newestItemAt: newest, oldestItemAt: oldest };
},
maxContentAgeMin: 9 * 24 * 60,

// Strip helper fields from the canonical-key payload so they never reach
// clients. publishTransform runs AFTER contentMeta per the Sprint 1
// runSeed contract — content-age has already been computed by this point.
publishTransform: (data) => ({
  ...data,
  outbreaks: data.outbreaks.map((item) => {
    const { _publishedAtIsSynthetic: _a, _originalPublishedMs: _b, ...rest } = item;
    return rest;
  }),
}),
```

**Verification additions:**
- After publish, verify the Redis canonical `health:disease-outbreaks:v1` contains NEITHER `_publishedAtIsSynthetic` NOR `_originalPublishedMs` on any item. Both names must be checked because grepping just one prefix misses the other:
  ```bash
  # Single combined regex covers both helper names.
  redis-cli GET health:disease-outbreaks:v1 | grep -cE '_publishedAtIsSynthetic|_originalPublishedMs'
  # Expected: 0
  ```
- Cross-check via `/api/bootstrap?keys=diseaseOutbreaks` — the response payload must not contain either helper field. Same combined-regex check on the response body.
- The test in `tests/disease-outbreaks-seed.test.mjs` (Step 2.4) must assert: `contentMeta` runs first (sees helpers), `publishTransform` runs second (strips helpers), the published payload is helper-free for BOTH helper names (assert on a list of forbidden keys, not a single substring), and the seed-meta carries the correct `newestItemAt`.

**Verification:** trigger Railway bundle, observe `/api/health.diseaseOutbreaks` shows `contentAgeMin` and matches actual newest **non-synthetic** item age (NOT the same as the maximum `publishedAt` across all items — synthetic-tagged items are excluded). Today's incident pattern would flag `STALE_CONTENT` at the 9-day threshold. Confirm via Redis read that the cached canonical key is helper-free (combined-regex grep returns 0).

**Anti-regression test:** add a unit test to `tests/disease-outbreaks-seed.test.mjs` (create if missing). Test against both layers separately — the in-memory pre-publish data MUST carry helpers for `contentMeta` to work; the published canonical MUST be helper-free for client safety:

Pre-publish (parser/mapItem in-memory) layer:
- WHO record without `PublicationDateAndTime` → in-memory item has `_publishedAtIsSynthetic: true`, `_originalPublishedMs: null`, `publishedAt: <Date.now() at fetch time>`.
- WHO record with valid date → in-memory item has `_publishedAtIsSynthetic: false`, `_originalPublishedMs: <upstream ms>`, `publishedAt: <same ms>`.
- TGH record → in-memory item has `_publishedAtIsSynthetic: false`, `_originalPublishedMs: <parsed ms>` (TGH always has a date by the time it reaches mapItem — see Step 2.1).
- `contentMeta` returns null when ALL in-memory items are synthetic.
- `contentMeta` excludes synthetic items from `newestItemAt`/`oldestItemAt` when mixed.

Published canonical (post-`publishTransform`) layer — the only layer clients ever see:
- Assert NEITHER `_publishedAtIsSynthetic` NOR `_originalPublishedMs` appears in the published payload (assert against a list of forbidden keys, not a single substring).
- `publishedAt` remains non-null on every published item (UI/RPC consumer compatibility preserved).
- The seed-meta written by runSeed carries the correct `newestItemAt` (matches the pre-publish `contentMeta` computation).

### Sprint 3 — Sparse seeders (PRs 3a/3b/3c)

Migrate the highest-value sparse seeders one at a time, each PR ≤ 1 file. For each, audit upstream date-availability first; tag any synthetic timestamps:

| Seeder | Shape | Recommended `maxContentAgeMin` | Date-source audit |
|---|---|---|---|
| `seed-climate-news.mjs` | `{items: [...]}` with `publishedAt` | 7d (climate news cadence) | RSS pubDate — usually present, mark synthetic if missing |
| `seed-iea-oil-stocks.mjs` | monthly | 45d (IEA monthly + 2 weeks slack) | IEA report-date field — verify present per row |
| `seed-news-feed-digest` (Vercel-side) | per-feed cache | 7d (matches CACHE_TTL_HEALTHY_S budget) | Per-feed pubDate already extracted by parseRssXml; reuse |
| `seed-economic-stress.mjs` | weekly | 14d | Source-specific; audit each indicator |

### Sprint 4 — Annual-data seeders (PR 4)

Annual indicators (WB resilience: `power-losses`, `low-carbon-generation`, `fossil-electricity-share`, plus IMF/WEO/etc.) need `maxContentAgeMin` set to `13 * 30 * 24 * 60` minutes (~13 months) since the underlying data IS yearly. This pairs with PR #3582's canonical-envelope-mirror behavior:

- The mirror writes `fetchedAt` from canonical's original timestamp.
- With Sprint 1 done, the mirror ALSO preserves `newestItemAt` from canonical's envelope.
- `maxContentAgeMin` 13 months keeps the panel green during normal between-publication gaps.

Per-row date extraction: WB indicator records carry `date: "2022"` etc. — the seeder converts to ms (year-end timestamp) for `contentMeta`.

### Sprint 5 — Fast-cadence (optional)

Earthquakes, market quotes, FIRMS fires — for these, `seedAgeMin ≈ contentAgeMin` so the new field is redundant. Migrate only if uniformity is desired. No anti-pattern caught by content-age that wouldn't be caught earlier by `STALE_SEED` or freshness in the data load itself.

## Rollout

- PR 1 land + verify zero health regressions for 24 hours (snapshot diff of all per-key statuses).
- PR 2 land + verify disease-outbreaks correctly surfaces `STALE_CONTENT` on the next bundle tick (today's incident pattern would trip).
- PR 3a/3b/3c land staggered (1-2 days apart) — easy to revert if any one seeder declares a wrong `maxContentAgeMin` and over-pages.
- PR 4 land last; close out the canonical-envelope-mirror story from #3582.

Each PR is independently shippable; no cross-PR coordination required.

## Risk and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wrong `maxContentAgeMin` on some seeder → false `STALE_CONTENT` page-out | medium | Per-seeder declaration + opt-in migration. If wrong, single-file revert. Health treats `STALE_CONTENT` as lower-severity than `STALE_SEED` to throttle alert noise. |
| `contentMeta` extractor throws on malformed data | low | Try/catch in runSeed; treat throw same as null return → `STALE_CONTENT`. Aggregate fail tolerated; never breaks the publish. |
| Future-dated items beyond clock-skew tolerance | low | Filtered out in `contentMeta` (1h tolerance, matching `list-feed-digest`'s `FUTURE_DATE_TOLERANCE_MS`). |
| Synthetic `Date.now()` fallback timestamps mask staleness | high pre-fix, low post-fix | `_publishedAtIsSynthetic` markers + Sprint 2 audits each migrated seeder. |
| Validate-fail mirror loses content fields | high pre-fix, low post-fix | Sprint 1 explicitly extends `readCanonicalEnvelopeMeta` + the mirror branch (Codex P0b). Test in `tests/seed-utils-empty-data-failure.test.mjs`. |
| seed-meta size grows | low | +3 fields × ~50 active seeders ≈ trivial Redis impact. |
| Health endpoint payload grows | low | +2 fields per opted-in entry; tens of bytes. |

## Open questions

1. **`STALE_CONTENT` severity tier?** Recommendation: between `STALE_SEED` and `OK` in operator alerts. `STALE_SEED` is "our seeder is broken" → page. `STALE_CONTENT` is "upstream isn't publishing" → log + dashboard, but don't page (operators can't fix upstream cadence).

2. **Per-item filter alignment with consumer-side filters?** PR #3593 already disabled the map's 7d time filter for diseaseOutbreaks. If we add `STALE_CONTENT` checks for the same data, we're saying "this layer's data is stale" while showing it anyway. Acceptable: the layer surfaces "we have data", health surfaces "but it's old" — worth a future UI-side hint ("most recent: 11d ago") but not in this plan.

3. **Historical retention?** `oldestItemAt` is informational — useful for spotting when a seeder mass-deletes old items unexpectedly. Worth keeping; trivial cost.

4. **Should `STALE_CONTENT` block /api/health overall status?** No — overall `status` (overall: 'ok' / 'degraded' / 'critical') should treat `STALE_CONTENT` as `degraded`, not `critical`. Avoids paging on normal upstream rhythm.

## Definition of done

- [ ] `_seed-utils.mjs` accepts `contentMeta` / `maxContentAgeMin` opts; validates upfront; writes the three new fields into the `_seed` envelope and `seed-meta:*`.
- [ ] `readCanonicalEnvelopeMeta` and the validate-fail mirror branch preserve content fields end-to-end.
- [ ] `api/health.js` reports `STALE_CONTENT` when the seeder opted in and content is stale; precedence is `SEED_ERROR > (OK_CASCADE / EMPTY_ON_DEMAND / REDIS_PARTIAL) > EMPTY_DATA > STALE_SEED > COVERAGE_PARTIAL > STALE_CONTENT > OK`; `STATUS_COUNTS` and `problemKeys` updated.
- [ ] Tests cover: opt-in writes new fields, legacy seeders unchanged, classifier respects all status grades and precedence, canonical-mirror preserves content fields, all-undated opted-in produces `STALE_CONTENT`, future timestamps rejected, `STALE_CONTENT` counted in `STATUS_COUNTS`.
- [ ] Disease-outbreaks pilot ships with `maxContentAgeMin: 9 * 24 * 60` (9 days) — explicitly chosen so the 2026-05-04 incident would have tripped — and synthetic-timestamp tagging at lines 108/138.
- [ ] At least 3 sparse seeders migrated (Sprint 3) with date-source audit notes.
- [ ] At least 1 annual-data seeder migrated (Sprint 4) — formalizes the canonical-mirror contract.

## Companion incidents

This plan emerged from production incidents that current health doesn't catch:

- **2026-05-04 disease-outbreaks** (this plan's origin): seed-meta fresh, items 11d old, layer empty.
- **2026-05-03 power-losses**: seeder ran but validateFn rejected partial fetch; PR #3582 fixed the seed-meta poisoning, this plan adds the explicit content-age contract AND extends the canonical-mirror to preserve content fields (Codex P0b).
- **PR #3556 news-digest**: cached non-RSS bodies; partly addressed by `looksLikeRssXml`. Content-age would have caught the empty cache faster.

The pattern: **fetched-recently is not the same as fresh-content.** This plan makes the distinction first-class.
