---
title: "A degraded seeder tick overwrote the 24h stale fallback with weaker coverage, so country flight pages returned 500"
module: military-flights
date: 2026-10-19
category: logic-errors
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "GET /api/intelligence/v1/get-country-signal-observations with family=COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE returns HTTP 500 for US, IR, GB, FR, NZ, JP and 200 for UA, LB, IL, DE"
  - "Sentry burst of `API 500: /api/intelligence/v1/get-country-signal-observations` from many browsers within a few minutes (WORLDMONITOR-18S)"
  - "Redis military:flights:v1 AND military:flights:stale:v1 both carry coverage: regional"
  - "seed-military-flights Railway log shows `[adsb.lol] fetch failed` then `[Source] adsbLol=no wingbits=yes`"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - service_object
tags:
  - military-flights
  - stale-key
  - last-good
  - coverage
  - adsb-lol
  - wingbits
  - seeder
  - fallback
---

# A degraded seeder tick overwrote the 24h stale fallback with weaker coverage, so country flight pages returned 500

## Problem

`scripts/seed-military-flights.mjs` writes each tick's payload to two keys: the live key `military:flights:v1` (10 min TTL) and the last-good key `military:flights:stale:v1` (24 h TTL). When the global source adsb.lol failed for one tick, the payload came from Wingbits alone and was stamped `coverage: 'regional'`. The seeder still wrote that payload to the stale key, which destroyed the global snapshot that the readers use as their fallback.

## Symptoms

- Country flight pages outside the two Wingbits regions returned HTTP 500 for as long as adsb.lol stayed down. The regions are East Asia (lat 10..46, lon 107..143) and Europe/Middle East (lat 13..85, lon -10..57), defined in `REGIONAL_COVERAGE` in `server/worldmonitor/military/v1/list-military-flights.ts`.
- Countries inside the regions kept answering 200, so the outage looked partial and country-specific.
- The issue cleared on its own at the next tick where adsb.lol answered. That is why it showed up as a few-minute Sentry burst rather than a sustained alert.

## What Didn't Work

- Probing the endpoint with camelCase query params (`countryCode=US&windowIndex=0`) returned `400 countryCode value is required`. The generated client sends snake_case (`country_code`, `family`, `window_index`, `cursor`). Read `src/generated/client/.../service_client.ts` for the exact names before probing.
- Probing a single family hid the defect. The other seven families returned 200; only `COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE` failed. Probe every family, then several countries inside and outside the regions.

## Solution

PR #9411 adds `publishStaleFlightSnapshot` to `scripts/seed-military-flights.mjs`. A non-global payload replaces the stale key only when the stored snapshot is not global:

```js
export async function publishStaleFlightSnapshot(url, token, payload) {
  if (payload.coverage !== 'global') {
    let existing = null;
    try {
      existing = await redisGet(url, token, STALE_KEY);
    } catch (err) {
      console.warn(`  ${STALE_KEY}: unreadable (${err.message || err}); publishing regional snapshot`);
    }
    if (existing?.coverage === 'global') return 'kept';
  }
  await redisSet(url, token, STALE_KEY, payload, STALE_TTL);
  return 'written';
}
```

- The live key is still written every tick, so requests inside the regions read fresh data.
- A kept global snapshot is not re-extended, so it still expires 24 h after it was taken.
- When the seeder skips the stale write it logs `military:flights:stale:v1: kept global last-good (regional tick)`.

## Why This Works

Country flight pages call `readMilitaryFlights(..., { allowProviderFetch: false })`. When the live payload does not cover the request, the reader goes to `fetchStableStaleSnapshot`. `staleResultForBounds` serves stale rows only when the stale coverage covers the request bounds (or the request is the full world). Otherwise the reader throws `Country flight snapshot unavailable`, which the gateway returns as 500.

The reader logic was correct. It fails closed so that an uncovered viewport is never presented as an authoritative empty result. The bug was on the producer side: the fallback key lost coverage at the moment the fallback was needed. Keeping the global snapshot restores the fallback path the reader was designed around.

## Prevention

- **A fallback key must never be overwritten by a payload with weaker coverage, completeness or authority than the one it holds.** "Last good" means last good at the strongest level available, not simply last written. The same check applies to any producer that writes one payload to both a live key and a stale/backup key while it has a degraded mode (a regional fallback, a partial source, a single provider instead of several).
- Test both sides:
  - On the producer side, `tests/seed-military-flights-redis-write.test.mjs` asserts that a regional tick sends no `SET` when the stored stale snapshot is global.
  - On the reader side, `tests/redis-caching.test.mjs` ("serves an out-of-region country page from the global stale snapshot while live is regional") proves both branches: global stale serves, and regional stale reproduces the production throw.
- Triage recipe for a burst of 500s from a seeded RPC: probe each request variant against prod, read the `coverage`/shape fields of both the live and stale keys, and grep the producer's Railway log for its per-source line (`[Source] adsbLol=...`).

## Related

- `docs/solutions/integration-issues/opensky-bbox-area-billing-flat-top-tier.md` explains why the military producer's coverage is global (adsb.lol) or regional (Wingbits) in the first place.
- `docs/solutions/conventions/a-composing-handler-cannot-see-the-failures-its-dependencies-swallow.md` covers a related failure class: a composing handler can't see a failure that one of its dependencies swallowed.
