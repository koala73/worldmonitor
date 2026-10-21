---
title: "OpenSky bills /states/all by bbox AREA with a flat top tier — two big regional boxes cost double a global query and cover less"
module: military-flights
date: 2026-08-05
category: integration-issues
problem_type: integration_issue
component: background_job
severity: high
symptoms:
  - "OpenSky /states/all returns HTTP 429 with X-Rate-Limit-Retry-After-Seconds ~22688 (~6.3h) for the authenticated production client"
  - "seed-meta:theater-posture reports sourceVersion: wingbits with fresh data while OpenSky contributes nothing — the quota burn is silent"
  - "Military aircraft outside the two hardcoded query regions (Americas, Australia, most of Africa) never appear at any price"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - service_object
tags:
  - opensky
  - rate-limit
  - "429"
  - quota
  - api-credits
  - bounding-box
  - adsb
  - seeder
  - wingbits
  - fallback-cascade
---

# OpenSky bills /states/all by bbox AREA with a flat top tier — two big regional boxes cost double a global query and cover less

> **Status: verified diagnosis, fix pending.** The root cause below is proven against
> production; the remediation is filed as #6222 (quota) and #6224 (keyless ADS-B
> redundancy) and is **not** merged as of this writing. Every `file:line` citation
> points at the current, still-unfixed tree.

## Problem

WorldMonitor's authenticated OpenSky account exhausts its entire 4,000 credit/day quota
every day, so `/states/all` returns `429` for most of each day. The burn is invisible in
normal operation because Wingbits carries the flight surface — the cost is a dead fallback
and a permanently rate-limited account, not a broken panel.

## Symptoms

- Authenticating with the production `OPENSKY_CLIENT_ID` and issuing the *cheapest possible*
  query returns `429` with `X-Rate-Limit-Retry-After-Seconds = 22688` (~6.3 hours).
- `military:flights:v1` stays fresh (age 0.2 min) with `sourceVersion: "wingbits"` — nothing
  in the health surface indicates OpenSky is dead.
- Aircraft outside the two hardcoded regions are simply absent; measured against
  `api.adsb.lol/v2/mil`, **50 of 133 positioned military aircraft (38%) fall outside them**.

## What Didn't Work

- **Inferring quota state from logs.** The relay tracks `openskyThrottle`, `openskyGlobal429Until`,
  and `openskyRateLimitRemaining` (`scripts/ais-relay.cjs:8571-8579`), and the seeder has a
  full auth-retry ladder with cooldown (`scripts/seed-military-flights.mjs:583-653`). None of
  that distinguishes *"we hit a burst limit"* from *"we spent the day's credits."* The
  existing 90s default cooldown (`ais-relay.cjs:8572`) is sized for the former and is
  meaningless against the latter.
- **Assuming smaller bounding boxes are cheaper.** They are — but only below 400 sq°. Both
  configured regions are far above that threshold, so shrinking them changes nothing until
  they cross a tier boundary.
- **Assuming an anonymous fallback provides cover.** `seed-military-flights.mjs:744-746` and
  `server/worldmonitor/aviation/v1/track-aircraft.ts:161` fall back to unauthenticated
  OpenSky. Anonymous is 400 credits/day *per IP* on shared Railway/Vercel egress — it can
  essentially never succeed and only adds a full timeout to every failure path.

## Solution

### The 4-credit global query, measured

One global `/states/all?extended=1`, issued 2026-08-05 against the anonymous tier from a
residential IP (a separate 400/day-per-IP pool, so it cost production nothing):

```
HTTP 200   X-Rate-Limit-Remaining: 396      <- 400 - 4: the flat top tier, confirmed live
7,680 state vectors | 0.96 MB | 4.11 s wall clock
```

Two things worth keeping. First, the **4-credit price is confirmed empirically**, not just
from the docs — a global query debited exactly 4 from a fresh 400. Second, the response is
far smaller than a "whole planet" query sounds: **0.96 MB in 4.11 s**, which is 27% of the
seeder's 15s `fetchJsonDirect` budget with 10.9s of headroom. Collapsing regional bboxes into
a global query is not a payload-size trade.

Measuring this needed no production credentials and no deploy. When an account is quota-locked,
the anonymous per-IP tier from a developer machine still answers the shape questions — only
the account-specific questions require the real credentials.

### The billing rule that makes this a bug

`/states/all` is priced by **bounding-box area**, and the top tier is **flat**
([upstream docs](https://openskynetwork.github.io/opensky-api/rest.html),
[source](https://github.com/openskynetwork/opensky-api/blob/master/docs/free/rest.rst)):

| bbox area | credits |
|---|---|
| ≤ 25 sq° or serial-only | 1 |
| 25 – 100 sq° | 2 |
| 100 – 400 sq° | 3 |
| **> 400 sq° _or global_** | **4** |

Quotas are **per endpoint** (states / tracks / flights each hold their own):
anonymous 400/day · registered 4,000/day · active feeder (≥30% uptime/month) 8,000/day ·
licensed 14,400/hour.

**Any bbox above 400 sq° costs exactly what the whole planet costs.** So N large regional
boxes cost N×4 while one global call costs 4 and strictly dominates on coverage.

### Where the 4,000 goes

`scripts/seed-military-flights.mjs:46-49` (cron `*/5`, 288 runs/day):

```js
const QUERY_REGIONS = [
  { name: 'PACIFIC', lamin: 10, lamax: 46, lomin: 107, lomax: 143 },  // 36x36 = 1,296 sq° -> 4 credits
  { name: 'WESTERN', lamin: 13, lamax: 85, lomin: -10, lomax:  57 },  // 72x67 = 4,824 sq° -> 4 credits
];
```

`scripts/ais-relay.cjs:4049-4052` (theater-posture loop, 10 min, 144 runs/day) repeats the
mistake with a second pair of oversized boxes (3,192 and 1,160 sq° — 4 credits each).

| Consumer | Runs/day | Credits/run | Credits/day |
|---|---|---|---|
| `seed-military-flights.mjs` | 288 | 8 | **2,304** |
| `ais-relay.cjs` theater posture | 144 | 8 | **1,152** |

**3,456 of 4,000 (86%) is spent before a single user loads the map.** Per-viewer fallthrough
in `list-military-flights.ts` and `track-aircraft.ts` finishes it.

### The second, independent defect

`scripts/seed-military-flights.mjs:892-894` runs the OpenSky loop **unconditionally**:

```js
for (const region of QUERY_REGIONS) {
  await fetchOpenSkyRegion(region, { source, fetchSources, seenIds, allStates });
}
```

`fetchWingbits()` runs first at `:876`, but its success does not short-circuit the loop. The
relay's own `seedTheaterPosture()` cascade (`ais-relay.cjs:4517-4537`) gets this right —
adsb.lol first, Wingbits next, OpenSky only if both fail. The seeder never adopted it.

### The fix (filed, unmerged)

1. Collapse both region loops to **one global `/states/all`** — 8 credits → 4 per run, and
   coverage goes from two boxes to the planet. Filter military hex/callsign client-side as today.
   **This step alone is sufficient**: 4×288 + 4×144 = 1,728/day, or 43% of quota, down from 86%.
2. Delete both anonymous fallback paths — they cannot succeed and cost a timeout each.
3. Optional: an ADS-B receiver at ≥30% monthly uptime doubles the quota to 8,000/day.

**Gating OpenSky behind Wingbits success is deliberately _not_ recommended, despite being the
obvious fix for the Ungated Tier defect.** Step 1 removes the budget pressure that motivated
it, and gating carries a coverage cost that the budget no longer forces us to pay — see the
caution below.

### Why not simply gate the ungated tier

The seeder merges OpenSky states into the result set additively, deduped by `icao24`
(`scripts/seed-military-flights.mjs:877-882` for the Wingbits half of the same merge). So
OpenSky is not pure waste in normal operation: it contributes aircraft Wingbits did not see.
Gating it behind Wingbits *failure* would delete that contribution, and it fails in the exact
way [`deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing.md`](../design-patterns/deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing.md)
documents: a **degraded-but-non-empty** primary satisfies the gate. Wingbits returning a
partial set would suppress OpenSky entirely, and the publication would look healthy because
it is non-empty and correctly attributed.

The right question from that doc — *"what would break if this ran exactly once?"* — has a real
answer here, so the correct move is to fix the cost (step 1) and leave the redundancy in place.
An Ungated Tier is only a defect when the tier adds nothing; here it adds coverage and, once
the tier costs 4 credits instead of 8, the budget affords it.

**The contribution is already instrumented — measure it rather than arguing about it.**
`fetchOpenSkyRegion` receives the shared `seenIds`/`allStates` (`scripts/seed-military-flights.mjs:716`),
dedupes and appends (`:767-769`), and then logs the net-new count per region:

```js
if (added > 0) console.log(`  [OpenSky] +${added} new from ${region.name} (total: ${allStates.length})`);
```

(`scripts/seed-military-flights.mjs:773`.) That line is the empirical answer to "what is this
tier worth": pull `+N new` across a day of seeder logs once the quota is restored, and the
merge's marginal value stops being a matter of opinion. Do that before entertaining any
gating proposal — and note that while the account is quota-exhausted the number reads zero for
reasons that have nothing to do with the merge's value.

## Why This Works

The billing tier is flat above 400 sq°, so the marginal cost of widening a large box to the
whole globe is **zero**. Paying 8 credits for two boxes that exclude the Americas is strictly
dominated by paying 4 for everything. This is counter-intuitive precisely because every other
metered API in the fleet charges *more* for *more* data — here, past one threshold, it does not.

The unconditional call is a separate axis: a metered upstream invoked behind an already-successful
primary produces no marginal data but full marginal cost. It stays invisible because the
publication is healthy and correctly attributed to the primary — the very attribution that
`ais-relay.cjs:4500-4510` exists to provide (added for #5945) is what makes the waste silent.

## Prevention

- **Read the upstream's cost function before sizing a request, not after.** For any metered
  API, find the tier table and check whether the parameter you are tuning actually crosses a
  boundary. A "smaller = cheaper" intuition is wrong wherever billing is tiered and flat-topped.
- **Notice when a metered upstream runs behind an already-successful primary — then ask what it
  contributes before gating it.** The condition is invisible from output (the publication is
  fresh and correctly attributed either way), so it has to be looked for deliberately. But the
  remedy is not automatically a gate: if the tier's results *merge* into the primary's rather
  than replacing them, gating deletes coverage, and a degraded-but-non-empty primary will
  satisfy the gate and suppress the tier exactly when it is most needed. Establish which shape
  it is first — replacing tier (gate it) or merging tier (make it cheaper and keep it).
- **Probe the provider directly to establish quota state; do not infer it from your own logs.**
  Authenticate with the production credentials, issue the cheapest possible request, and read
  the provider's own headers. For OpenSky, `X-Rate-Limit-Retry-After-Seconds` on the order of
  hours means daily-quota exhaustion; seconds-to-minutes means a burst limit. They demand
  opposite remediations, and app-side counters cannot tell them apart.
- **Treat an anonymous/unauthenticated fallback from shared serverless egress as dead code.**
  Per-IP free tiers are consumed by every other tenant sharing that NAT pool. The fallback
  cannot succeed and costs a timeout on every failure path.
- **A cooldown constant must be sized to the failure it handles.** `OPENSKY_429_COOLDOWN_MS`
  defaults to 90s (`ais-relay.cjs:8572`); a daily-quota 429 needs the provider's own
  `retryAfterSeconds`, which the code does read (`ais-relay.cjs:8841-8849`) — but the floor
  still applies, so verify the provider value actually wins.

## Related Issues

- #6222 — OpenSky quota exhaustion (the fix for this doc)
- #6224 — keyless ADS-B redundancy (adsb.lol / airplanes.live / adsb.fi) + blind-spot regions
- #6227 — AIS has no fallback; same class of single-provider exposure on the maritime side
- #5945 — theater-posture source attribution, which is why the burn is silent rather than visible
- [`railway-cron-schedule-lives-on-the-deployment-manifest.md`](./railway-cron-schedule-lives-on-the-deployment-manifest.md) — how to read the real cron cadence, needed to compute credits/day
- [`vendor-sdk-hidden-retries-nested-retry-ladder.md`](./vendor-sdk-hidden-retries-nested-retry-ladder.md) — adjacent: request amplification against a rate-limited provider
- [`primary-fallback-inversion-budget-transfer.md`](../design-patterns/primary-fallback-inversion-budget-transfer.md) — the same lesson on a different resource: a seeder's fallback tier carries a hidden cost against a *shared budget* (there wall-clock deadline, here API credits), and reordering or ungating the tiers silently reassigns it
