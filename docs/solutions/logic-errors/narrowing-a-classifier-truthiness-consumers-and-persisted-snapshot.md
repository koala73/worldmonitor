---
title: Narrowing a classifier means checking its truthiness consumers and its persisted snapshot
date: 2026-09-24
category: logic-errors
module: military-vessels
problem_type: logic_error
component: service_object
severity: high
root_cause: logic_error
resolution_type: code_fix
symptoms:
  - "getVesselTypeFromAis(35) returned 'destroyer' for AIS ship type 35, a generic military-ops activity code that establishes no hull class"
  - "an unidentified type-35 vessel would render as Destroyer across eight surfaces: map popup, cluster list, globe tooltip and marker colour, country-brief timeline, CSV export, PDF report, correlation severity, and the posture destroyer count"
  - "latent, not observed: the relay delivers zero per-vessel military candidates to browsers, so the mislabel had no production reach on web at the time of the fix"
  - "the obvious narrowing (return undefined) drops the vessel from the feed entirely, because the tracking gate consumes the classifier's return for truthiness rather than value"
  - "the classifier fix alone stayed invisible to returning users for up to 24h, because the breaker persists snapshots that replay the pre-fix label"
related_components:
  - "circuit-breaker"
  - "usni-fleet"
tags:
  - "ais"
  - "vessel-classification"
  - "sentinel-value"
  - "truthiness-gate"
  - "persisted-cache"
  - "migration-on-read"
  - "circuit-breaker"
  - "green-seam-not-shipped"
---


## Problem

AIS ship type 35 means "Military Ops" — a generic statement that a vessel is engaged in military activity, not a hull class. `getVesselTypeFromAis` in `src/services/military-vessels.ts` mapped it to `'destroyer'`, so every unidentified ship broadcasting type 35 was presented to users as a Destroyer. Fixing the classifier was the easy half. The two hard halves were that the obvious narrowing (`return undefined`) silently *drops the vessel from the feed*, and that a classifier fix alone never reaches a returning user, whose persisted snapshot keeps serving the pre-fix label for up to 24 h.

## Symptoms

- A civil-MMSI vessel with no military name signal was labelled "Destroyer" in the map popup, the cluster member list, the globe tooltip, the country-brief timeline, the CSV export and the PDF data report.
- It was counted in the naval order of battle: `posture.destroyers = theaterVessels.filter((v) => v.vesselType === 'destroyer').length` (`src/components/StrategicPosturePanel.ts:228`), which drives the `⚓ N` chip at `StrategicPosturePanel.ts:462`.
- It was scored at destroyer severity — 70 instead of the 50 default — in the correlation engine: `: v.vesselType === 'destroyer' ? 70` (`src/services/correlation-engine/adapters/military.ts:80`, default `: 50` at line 82).
- It promoted a whole vessel cluster from `'transit'` to `'exercise'` through the `hasCombatants` check (`src/services/military-vessels.ts:527-533`).

## What Didn't Work

**Returning `undefined` from `getVesselTypeFromAis(35)`.** This is the intuitive fix — "we don't know the class, so return nothing" — and it silently breaks tracking. The tracking gate consumes the classifier's return value for *truthiness*, not for its value:

```ts
// src/services/military-vessels.ts:386-391
const aisType = data.shipType ? getVesselTypeFromAis(data.shipType) : undefined;

// Determine if we should track this vessel
const isMilitary = knownVessel || mmsiAnalysis.isPotentialMilitary || aisType;

if (!isMilitary) return;
```

A type-35 vessel whose MMSI matches no `MILITARY_VESSEL_PATTERNS` prefix and whose name matches no `KNOWN_NAVAL_VESSELS` entry is tracked *only* because `aisType` was truthy. Return `undefined` and `processAisPosition` returns early: the vessel disappears from the feed entirely, and the user loses even the supported "Military Ops" fact they were entitled to. The narrowing would have traded a wrong answer for no answer.

**Shipping the classifier fix alone.** The military-vessel circuit breaker sets `persistCache: true` (`src/services/military-vessels.ts:76`), and `src/utils/circuit-breaker.ts:56` defines `PERSISTENT_STALE_CEILING_MS = 24 * 60 * 60 * 1000`. A user who had the panel open before the deploy keeps rehydrating their own pre-fix snapshot — complete with `vesselType: 'destroyer'` — for up to 24 h afterwards. From their seat the fix simply did not work.

## Solution

**1. Return a truthy sentinel, not `undefined`.**

```ts
// src/services/military-vessels.ts:327-342
function getVesselTypeFromAis(shipType: number): MilitaryVesselType | undefined {
  // 35 reports generic military ACTIVITY, not a hull class (#8611). ...
  if (shipType === 35) return 'unknown';
  if (shipType === 55) return 'patrol'; // Law enforcement/coast guard
  if (shipType >= 50 && shipType <= 59) return 'special';
  return undefined;
}
```

`'unknown'` keeps the `isMilitary` gate passing while dropping the unsupported class claim. The supported fact still reaches the UI through a separate field: `aisShipType: getAisShipTypeName(data.shipType)` (`military-vessels.ts:438`), where `35: 'Military Ops'` (`military-vessels.ts:266`). A known-vessel match still wins, because the precedence is `vesselType: knownVessel?.vesselType || aisType || 'unknown'` (`military-vessels.ts:437`).

**2. Normalize on rehydration, inside the existing revive hook.**

```ts
// src/services/military-vessels.ts:61-63
function isStaleAisMilitaryOpsClaim(v: MilitaryVessel): boolean {
  return v.vesselType === 'destroyer' && !v.hullNumber && v.aisShipType === 'Military Ops';
}
```

applied in `revivePersistedData` (`military-vessels.ts:77-84`), which already existed to revive `lastAisUpdate` into a `Date`. Reusing that hook means the normalization runs on exactly the one path that reintroduces pre-fix data.

**3. Carry the fact to every label surface.** `vesselTypeLabel` in `src/utils/vessel-type-label.ts:17-25` returns `vessel.aisShipType` when `vesselType === 'unknown'`, so the surfaces read "Military Ops" rather than a bare "unknown". It is now the single label source for the popup and cluster list (`src/components/MapPopup.ts:2917`, `2960-2961`), the globe tooltip (`src/components/GlobeMap.ts:2729`), the country-brief timeline (`src/app/country-intel.ts:1464`), the CSV export (`src/utils/export.ts:155`), the PDF data report (`src/utils/export-report.ts:191`) and the correlation signal label (`src/services/correlation-engine/adapters/military.ts:92`).

## Why This Works

The rehydration rewrite is safe because the three-part signature is unambiguous — no legitimately-named destroyer can match it.

- **Where a destroyer label can come from at all.** For an AIS-tracked vessel, `vesselType` is `knownVessel?.vesselType || aisType || 'unknown'` (`military-vessels.ts:437`). With the classifier fixed, `aisType` can only be `'patrol'`, `'special'` or `'unknown'`, so `'destroyer'` can only come from `knownVessel`, i.e. a `KNOWN_NAVAL_VESSELS` entry in `src/config/military.ts`. The other producer of destroyer-typed vessels app-wide is the USNI merge in `src/services/usni-fleet.ts`.
- **Both producers carry a hull number.** `hullNumber: knownVessel?.hullNumber` (`military-vessels.ts:439`) copies it from the matched record. Of the 23 `KNOWN_NAVAL_VESSELS` entries only two omit `hullNumber` — `Admiral Kuznetsov` (carrier) and `Yuan Wang` (research) — so every *destroyer* entry carries one (e.g. `src/config/military.ts:496`, `USS Zumwalt` / `DDG-1000`). On the USNI side `hullNumber: string` is a required field of `USNIVesselEntry` (`src/types/index.ts:1011`), propagated onto every synthetic vessel at `usni-fleet.ts:209`.
- **The USNI path is excluded twice over.** Synthetic USNI vessels (`usni-fleet.ts:204-228`) never set `aisShipType` at all, so the third conjunct rules them out independently of the hull-number argument. They also live behind their own circuit breaker (`usni-fleet.ts:10-16`), not the vessel snapshot the revive hook touches.
- **The one apparent counterexample is dead code.** `MILITARY_VESSEL_PATTERNS` has `{ mmsiPrefix: '3699', operator: 'usn', country: 'USA', vesselType: 'destroyer' }` (`src/config/military.ts:446`), which looks like a hull-number-free destroyer producer. It is not: `analyzeMmsi` (`military-vessels.ts:124-218`) returns only `{ isPotentialMilitary, country }` on all four of its return paths and never surfaces `pattern.vesselType`. That field cannot reach a vessel record.

So `vesselType === 'destroyer' && !hullNumber && aisShipType === 'Military Ops'` selects the old type-35 records and nothing else. The regression test at the bottom of `tests/dom/military-vessel-ais-classification.test.mts` pins the other side of the line: a persisted `USS ZUMWALT` with `hullNumber: 'DDG-1000'` and `aisShipType: 'Military Ops'` must survive rehydration as a destroyer.

## Production reach at the time of the fix

The defect is deterministic in source and the tests pin it, but it was **latent on the web dashboard, not observed**. Probing production on 2026-09-24 while writing this up:

- The relay is healthy — `status: {connected: true, vessels: 20000, messages: 365929}` — and `densityZones` is populated (200 zones).
- `candidateReports` and `tankerReports` are both **empty**, across two samples ~5.5 minutes apart in which the snapshot `sequence` advanced 1047 -> 1161 and the relay processed ~37,000 further AIS messages.
- `candidateReports` is the browser's only per-vessel AIS input (`src/services/maritime/index.ts:275` emits it to the callbacks `processAisPosition` registers), so with it empty the classifier never runs client-side.
- Every military vessel the live dashboard shows is therefore USNI-derived: all 34 in that session came from the fleet report, all hull-numbered (amphibious 6, carrier 3, destroyer 23, frigate 1, auxiliary 1).

So the 23 destroyers a user sees today are real, named, hull-numbered ships, correctly classified. **That is a separate and larger defect** — the AIS-derived military vessel layer delivers nothing — and it is tracked in #8634. The lesson for this doc is narrower and worth stating plainly: a classifier bug confirmed in source is not evidence of user impact. Establish reach before assigning severity; "confirmed in source" and "observed in production" are different claims, and only the second justifies urgency.

## Prevention

When you change a classifier whose output is (a) read for truthiness by a gate somewhere, or (b) stored in a persisted or cached snapshot, these two checks are obligatory, not optional.

**Before narrowing a return value, find its truthiness consumers.** Grep the call sites and look for the value appearing bare in a boolean position — `a || b || classifier(x)`, `if (classifier(x))`, `.filter(Boolean)` — not just for `=== 'someValue'` comparisons. Narrowing to `undefined`/`null`/`''` changes behaviour at every one of those sites. If a gate depends on the value merely existing, return a truthy sentinel that carries no claim (`'unknown'`) and move the real fact to a separate field.

**Before shipping, ask what a returning user sees.** Trace the value to any persistence layer. In this codebase that means a `createCircuitBreaker` call with `persistCache: true`; `PERSISTENT_STALE_CEILING_MS = 24h` (`src/utils/circuit-breaker.ts:56`) is the window during which the old value keeps being served. The fix belongs in `revivePersistedData` alongside the classifier change, in the same PR — otherwise the fix is invisible for a day to exactly the users who care most. A safe rewrite needs an *identifying signature*, a conjunction that no legitimate record can satisfy; write down why each conjunct is necessary, as above, before you trust it.

**The test pattern that proved each half.** Two tests, each observed red before the fix:

- Classifier: `expect(vessel?.vesselType).not.toBe('destroyer')` — went red pre-fix with `expected 'destroyer' not to be 'destroyer'`. The companion assertions (`toBe('unknown')`, `aisShipType` `toBe('Military Ops')`, and a separate case asserting the vessel is *defined* at all) are what lock out the `return undefined` regression.
- Rehydration: `expect(revived?.vesselType).toBe('unknown')` against a persisted-cache fixture holding a pre-fix record — went red with `expected 'destroyer' to be 'unknown'`, proven by temporarily reverting the revive hook. Fixture-driving the persistent cache (mock `@/services/persistent-cache` and hand it a pre-fix snapshot) is the general technique for testing a migration-on-read.

**Existing coverage that touches an input is not coverage of it.** `tests/dom/military-vessels-retention.test.mts:27` has been sending `shipType: 35` for the whole life of the bug. It asserts retention ordering and only ever checks `vesselType` for a `'carrier'` (lines 86, 105) — a known-vessel override that bypasses the AIS path entirely. The suite was green before and after the classifier changed its answer for every type-35 vessel. When auditing whether a behaviour is covered, grep for assertions on the *output*, never for occurrences of the input.

**A green seam is not a shipped fix.** The classifier defect itself came from the issue; the persisted-snapshot problem and three un-migrated surfaces (CSV export, PDF data report, correlation signal label) were all found by a multi-agent code review *after* the first commit looked complete and passed CI. The first commit was correct and tested — it was just not the whole user-visible surface. Budget a review pass that walks outward from the changed function to every surface a user exports, prints, or comes back to.

## Related Issues

- Issue #8611 — AIS Military Ops classified as destroyer.
- PR #8624 (`fix/8611-ais-military-ops-classification`) — merged 2026-09-24; carries the classifier fix and the surface/rehydration follow-up.
- Tests: `tests/dom/military-vessel-ais-classification.test.mts`, `tests/dom/military-vessel-ops-label.test.mts`, `tests/dom/military-vessel-label-surfaces.test.mts`, `tests/military-vessel-type-label.test.mts`, `tests/country-evidence-bundle-export.test.mts`.

## Related

- `docs/solutions/infrastructure-companion-empty-cache.md` — nearest root-cause shape: a client circuit breaker with `persistCache` serving a stale payload past a fix, bounded only by the persistence ceiling. It audits sibling breakers through `shouldCache`/eviction predicates and never covers `revivePersistedData`, so the mechanism here is complementary rather than duplicate.
- `docs/solutions/logic-errors/degraded-200-digest-poisoned-the-last-good-cache.md` — same theme of a technically-successful cached value that is wrong and keeps being trusted; different mechanism (write-path validation gap).
- `docs/solutions/conventions/a-degrading-accessor-turns-a-failed-read-into-a-confident-absence.md` — same bug family: a value collapses to something that looks legitimate and downstream logic cannot tell it apart from a real one.
- `docs/solutions/runtime-errors/ais-relay-self-request-configured-vs-bound-port.md` — the only other AIS-tagged doc; unrelated bug, listed to confirm no prior doc covered vessel classification.

The `revivePersistedData` hook itself has now carried two distinct migration-on-read fixes without ever being documented: issue #7123 established this breaker's shape, and PR #8386 explicitly recommended the hook for a sibling breaker's Date-field bug. This is its second use as a normalization point and the first written record of the technique.
