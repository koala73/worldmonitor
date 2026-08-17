---
title: Stripping null keys before caching makes replayed records crash typed consumers
date: 2026-08-05
category: logic-errors
module: scripts/_yahoo-sector-valuations.cjs
problem_type: logic_error
component: service_object
severity: critical
symptoms:
  - "Sector valuations tab renders nothing; TypeError 'Cannot read properties of undefined (reading toFixed)'."
  - "Backfilled sector rows render the literal string 'NaN%' for YTD, coloured red."
  - "Commodities, energy and FX panels silently skip a refresh cycle when the valuations tab is open."
root_cause: logic_error
resolution_type: code_fix
tags: [last-good-cache, redis, seed-fallback, staleness, market-sectors, type-safety]
---

# Stripping null keys before caching makes replayed records crash typed consumers

## Problem

A last-good fallback cache compacted its records on write by dropping null-valued keys. When
those records were later replayed into the published payload, the keys were **absent** rather
than `null` — and every downstream consumer that typed the field `number | null` and guarded
with `=== null` let `undefined` straight through into arithmetic and method calls.

Shipped in PR #6183 (merged). Fix opened in PR #6197, unmerged as of this writing.

## Symptoms

- `TypeError: Cannot read properties of undefined (reading 'toFixed')` thrown out of
  `HeatmapPanel._renderValuations()`, blanking the entire valuations tab rather than one cell.
- Backfilled rows rendering the literal `"NaN%"` for return metrics, coloured red as if negative.
- Unrelated panels degrading: the throw propagates to `loadMarkets`' outer `catch` in
  `src/app/data-loader.ts`, which then also skips the commodities/energy/FX loads for that cycle
  and flags Finnhub as errored.

## What Didn't Work

- **Trusting TypeScript.** `SectorValuation` declares `trailingPE: number | null` — not optional —
  so a runtime record missing the key violates the declared type with no compile-time signal. The
  spread at the consumer is trusted.
- **The existing `null` filter.** `entries.filter(e => e.forwardPE !== null || e.trailingPE !== null)`
  does not screen the bad records out, because `undefined !== null` is also `true`.
- **Assuming a write-side fix is enough.** Fixing only the persist path leaves every snapshot
  already resident in Redis sparse — in this case for up to a 7-day TTL.

## Solution

Persist the canonical shape, and — critically — **normalize on read** so records already in the
cache are repaired rather than waiting for the key to rotate:

```js
// scripts/_yahoo-sector-valuations.cjs
const EMPTY_VALUATION = {
  trailingPE: null, forwardPE: null, beta: null,
  ytdReturn: null, threeYearReturn: null, fiveYearReturn: null,
};

function normalizeValuation(value) {
  const record = { ...EMPTY_VALUATION };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return record;
  for (const key of Object.keys(EMPTY_VALUATION)) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) record[key] = candidate;
  }
  return record;
}

// on replay
freshVals[symbol] = normalizeValuation(lastGood);   // was: { ...lastGood }
```

Before (write path): `Object.fromEntries(Object.entries(v).filter(([, val]) => val != null))`
After: the merged record keeps all six keys with explicit nulls.

A defensive coercion was also added at the UI boundary (`MarketPanel.updateValuations`). That
duplication is deliberate defence-in-depth across the seeder/browser runtime split, not an
oversight — the two run in different processes and cannot share a module.

## Why This Works

`undefined` and `null` are not interchangeable across a `=== null` guard, which is the guard
style nearly all hand-written formatters use:

```js
const fmtPE = (v) => v !== null ? v.toFixed(1) : '--';
fmtPE(undefined);  // undefined !== null is TRUE -> undefined.toFixed(1) -> TypeError
```

Restoring the canonical shape means the guard sees `null` and takes its intended branch.
Normalizing on read (not just write) is what makes the fix effective immediately rather than
after a cache-TTL rotation.

The reachability detail worth remembering: the record shape that triggers the crash was
*admitted by design*. The gate for persisting was `trailingPE != null || forwardPE != null` — an
OR — so a record with `trailingPE: null` and a valid `forwardPE` passes, persists with
`trailingPE` stripped, and crashes on replay. That is exactly the ETF shape the original change
existed to handle.

## Prevention

- **A cache that feeds a typed consumer must persist the canonical shape.** Compacting nulls is
  a false economy when the value is replayed into a typed payload.
- **When fixing a cache-shape bug, fix the read path too.** Ask: "what is already in the store,
  and how long until it rotates?" A write-only fix leaves prod broken for the TTL.
- **Prefer `?? null` over `!== null` guards at trust boundaries** when the payload crosses a
  process (seeder → Redis → API → browser). Coerce at the boundary rather than trusting shape.
- Test the round trip, not the two halves:

```js
// A write/read round trip pins the shape contract; two hand-written fixtures
// that happen to agree do not.
it('persists a shape the replay path can publish safely', async () => {
  let written = null;
  await collectSectorValuations({ /* ... */, upstashSet: async (_k, v) => { written = v; return true; } });
  for (const record of Object.values(written.valuations)) {
    assert.deepEqual(
      Object.keys(record).sort(),
      ['beta', 'fiveYearReturn', 'forwardPE', 'threeYearReturn', 'trailingPE', 'ytdReturn'],
      'every persisted record must carry all six keys',
    );
  }
});
```

- Watch for this class wherever an outer `catch` wraps several independent loads: one panel's
  render throw becoming several panels' missing data is a blast-radius multiplier that makes the
  root cause much harder to spot from the symptom.

## Related

- The same change carried a second, independent trap: a snapshot-persist guard that tested the
  **stored** snapshot's shape (`lastGoodCoreCount < symbols.length`) was unsatisfiable for any
  snapshot the module itself writes, freezing the cache key until its TTL evicted it. The fix was
  to gate on "this run borrowed nothing" and make the write monotonic (merge fresh non-null over
  the resident record) so no guard is needed to prevent data loss. Worth its own entry.
- `docs/solutions/logic-errors/degraded-200-digest-poisoned-the-last-good-cache.md` — separate
  "accept" from "persist" in a last-good cache. Same family; this doc is the shape-level analogue
  of that content-level rule.
