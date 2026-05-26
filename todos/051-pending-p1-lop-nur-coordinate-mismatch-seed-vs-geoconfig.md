---
status: pending
priority: p1
issue_id: "051"
tags: [code-review, bug, seeding, nuclear, earthquakes, geo, pr-2375]
dependencies: []
---

## Problem Statement

The Lop Nur nuclear test site coordinates differ between the earthquake seed script and the geo config by approximately 85km. `scripts/seed-earthquakes.mjs` uses `(41.39, 89.03)` while `src/config/geo.ts` uses `(41.75, 88.35)`. Since the Haversine scoring uses a 200km threshold, this discrepancy means earthquakes between 85-200km from the actual site will score differently depending on which coordinate set is authoritative. The map marker and the enrichment scoring point to different locations.

## Findings

- **File:** `scripts/seed-earthquakes.mjs:13` — `{ name: 'Lop Nur', lat: 41.39, lon: 89.03 }`
- **File:** `src/config/geo.ts:3159` (approx) — `NUCLEAR_FACILITIES` entry for Lop Nur: `lat: 41.75, lon: 88.35`
- **Delta:** ~85km (Haversine distance between the two coordinate pairs)
- **Authoritative source:** Lop Nur test site centroid per Wikipedia/NTI: approximately 41.75°N 88.35°E (geo.ts values appear more accurate)
- **Impact:** Earthquakes in the 85-200km radius band get misscored; the map marker and earthquake enrichment diverge visually

## Proposed Solutions

**Option A: Update seed-earthquakes.mjs to match geo.ts (Recommended)**

Change `scripts/seed-earthquakes.mjs` Lop Nur entry to `lat: 41.75, lon: 88.35` to match `geo.ts`.

- **Effort:** Trivial (one-line fix)
- **Risk:** Very low — just aligns two coordinates to same source of truth

**Option B: Import nuclear test site coordinates from geo.ts into seed script**

Refactor the seed to import `NUCLEAR_FACILITIES` from `src/config/geo.ts` and filter by `type: 'test-site'`. Eliminates duplication entirely.

- **Effort:** Small (add import + filter logic)
- **Risk:** Low — seed script is `.mjs`; verify it can import from TS source or compiled output

**Option C: Update geo.ts to match seed-earthquakes.mjs**

If seed values are intentional (some sources cite different cluster centers), update geo.ts instead.

- **Effort:** Trivial
- **Risk:** May move the map marker to a less accurate location

## Acceptance Criteria

- [ ] Lop Nur coordinates are identical in `seed-earthquakes.mjs` and `geo.ts`
- [ ] Authoritative source documented in a comment (e.g., "NTI/Wikipedia centroid")
- [ ] Single source of truth preferred (Option B) if feasible without circular imports

## Work Log

- 2026-03-27: Identified by code-review agents during PR #2375 review. Geo.ts values appear more accurate per open-source nuclear monitoring databases.
