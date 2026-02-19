---
phase: 2G-displacement-migration
verified: 2026-02-19T09:15:23Z
status: passed
score: 22/22 must-haves verified
re_verification: false
---

# Phase 2G: Displacement Migration Verification Report

**Phase Goal:** Migrate displacement/UNHCR domain to sebuf -- implement handler proxying UNHCR Population API with multi-entity responses (refugees, IDPs, asylum seekers), create service module with port/adapter pattern, rewire all consumers, delete legacy endpoint
**Verified:** 2026-02-19T09:15:23Z
**Status:** PASSED
**Re-verification:** No -- initial verification

---

## Goal Achievement

### Observable Truths (Plan 2G-01)

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | Handler paginates through all UNHCR Population API pages (up to 10,000 records/page, max 25 pages guard) | VERIFIED | `handler.ts` lines 52-79: `limit=10000`, `maxPageGuard=25`, loop `for (let page=1; page<=maxPageGuard; page++)` |
| 2  | Handler implements year fallback: tries current year, then current-1, then current-2 until data found | VERIFIED | `handler.ts` lines 145-155: `for (let year = currentYear; year >= currentYear - 2; year--)` with break on first data |
| 3  | Handler aggregates raw records into per-country origin metrics (refugees, asylumSeekers, idps, stateless) and per-country asylum metrics (hostRefugees, hostAsylumSeekers) | VERIFIED | `handler.ts` lines 158-216: `byOrigin` and `byAsylum` maps built via loop over rawItems |
| 4  | Handler merges origin and asylum maps into unified CountryDisplacement records with totalDisplaced computed | VERIFIED | `handler.ts` lines 218-259: merges both maps; `totalDisplaced = refugees + asylumSeekers + idps + stateless` |
| 5  | Handler computes GlobalDisplacementTotals by summing across all raw records | VERIFIED | `handler.ts` lines 161-177: `totalRefugees`, `totalAsylumSeekers`, `totalIdps`, `totalStateless` accumulated per item |
| 6  | Handler builds DisplacementFlow corridors from origin->asylum pairs, sorted by refugees descending, capped by flowLimit (default 50) | VERIFIED | `handler.ts` lines 289-301: `.sort((a,b) => b.refugees - a.refugees).slice(0, flowLimit)`; `flowLimit = req.flowLimit > 0 ? req.flowLimit : 50` |
| 7  | Handler attaches GeoCoordinates from 40-entry hardcoded country centroids to countries and flows | VERIFIED | `handler.ts` lines 22-33: 40-entry `COUNTRY_CENTROIDS` map; `getCoordinates()` applied at lines 285, 299-300 |
| 8  | Handler returns all int64 fields as strings (matching generated DisplacementServiceHandler interface) | VERIFIED | `handler.ts` lines 277-284, 298, 307-312: all numeric fields wrapped in `String()` |
| 9  | Handler returns empty/graceful response on ANY fetch failure | VERIFIED | `handler.ts` lines 318-334: `catch` block returns fully-formed empty response with `'0'` string values |
| 10 | POST /api/displacement/v1/get-displacement-summary is routable through the gateway | VERIFIED | `api/[[...path]].ts` line 33: `...createDisplacementServiceRoutes(displacementHandler, serverOptions)` |
| 11 | Sidecar bundle compiles with displacement routes included | VERIFIED (via commit) | 2G-01-SUMMARY.md reports sidecar rebuilt at 31.0 KB; commits `4c80a67` confirmed in git log |

### Observable Truths (Plan 2G-02)

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 12 | App.ts loads displacement data via the rewritten displacement service module using DisplacementServiceClient | VERIFIED | `App.ts` line 33: `import { fetchUnhcrPopulation } from '@/services/displacement'`; line 3671: `fetchUnhcrPopulation()` called; result used lines 3677-3680 |
| 13 | DisplacementPanel displays globalTotals (refugees, asylumSeekers, idps, total) as numbers, not string-concatenated | VERIFIED | `DisplacementPanel.ts` line 38: `g = this.data.globalTotals`; fields accessed as numbers via arithmetic at lines 64, 79-81 |
| 14 | DisplacementPanel accesses country fields (refugees, asylumSeekers, hostTotal, totalDisplaced, lat, lon) as numbers | VERIFIED | `DisplacementPanel.ts` lines 64, 68, 79-81: `c.refugees + c.asylumSeekers`, `c.hostTotal`, `c.totalDisplaced` used arithmetically |
| 15 | DeckGLMap renders displacement arc layer with flat originLat/originLon/asylumLat/asylumLon from flows | VERIFIED | `DeckGLMap.ts` lines 3183-3187: `d.originLon!, d.originLat!`, `d.asylumLon!, d.asylumLat!`, `d.refugees / maxCount` |
| 16 | Country instability ingests displacement data with code, name, refugees, asylumSeekers as numbers | VERIFIED | `country-instability.ts` lines 33-34, 47: `displacement.refugees + displacement.asylumSeekers` (arithmetic confirms numbers) |
| 17 | Conflict impact receives displacement data with name, code, refugees, asylumSeekers as numbers | VERIFIED | `conflict-impact.ts` line 275: `c.refugees + c.asylumSeekers` used arithmetically |
| 18 | All int64 string fields from proto are converted to number in the service module adapter | VERIFIED | `displacement/index.ts` lines 65-69, 80-90, 99: all `Number(proto.*)` conversions in `toDisplaySummary`, `toDisplayCountry`, `toDisplayFlow` |
| 19 | All GeoCoordinates objects from proto are unpacked to flat lat/lon fields in the service module adapter | VERIFIED | `displacement/index.ts` lines 88-89: `lat: proto.location?.latitude`, `lon: proto.location?.longitude`; lines 100-103: flow coordinates unpacked to `originLat/Lon`, `asylumLat/Lon` |
| 20 | Legacy api/unhcr-population.js endpoint is deleted | VERIFIED | File does not exist at `api/unhcr-population.js`; only reference is a comment in `handler.ts` line 9 |
| 21 | Legacy src/services/unhcr.ts is deleted | VERIFIED | File does not exist at `src/services/unhcr.ts` |
| 22 | DisplacementFlow, CountryDisplacement, UnhcrSummary types removed from src/types/index.ts | VERIFIED | `grep` of `src/types/index.ts` returns zero matches for all three type names |

**Score:** 22/22 truths verified

---

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `api/server/worldmonitor/displacement/v1/handler.ts` | VERIFIED | Exists, 337 lines, exports `displacementHandler: DisplacementServiceHandler` |
| `api/[[...path]].ts` | VERIFIED | Contains `createDisplacementServiceRoutes` import and spread into `allRoutes` |
| `src/services/displacement/index.ts` | VERIFIED | Exists, 173 lines, exports `fetchUnhcrPopulation`, `getDisplacementColor`, `getDisplacementBadge`, `formatPopulation`, `getOriginCountries`, `getHostCountries`, `DisplacementFlow`, `CountryDisplacement`, `UnhcrSummary`, `UnhcrFetchResult` |
| `src/App.ts` | VERIFIED | Contains `import { fetchUnhcrPopulation } from '@/services/displacement'` |
| `api/unhcr-population.js` | VERIFIED (deleted) | File does not exist |
| `src/services/unhcr.ts` | VERIFIED (deleted) | File does not exist |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `api/server/worldmonitor/displacement/v1/handler.ts` | `src/generated/server/worldmonitor/displacement/v1/service_server.ts` | `implements DisplacementServiceHandler` | WIRED | Line 127: `export const displacementHandler: DisplacementServiceHandler = {` |
| `api/[[...path]].ts` | `api/server/worldmonitor/displacement/v1/handler.ts` | imports `displacementHandler` and mounts routes | WIRED | Lines 22, 33: imported and spread into `allRoutes` |
| `src/services/displacement/index.ts` | `src/generated/client/worldmonitor/displacement/v1/service_client.ts` | `DisplacementServiceClient.getDisplacementSummary` | WIRED | Lines 2, 109, 126: client imported, instantiated, and called |
| `src/App.ts` | `src/services/displacement/index.ts` | import `fetchUnhcrPopulation` | WIRED | Line 33: import; line 3671: called; result used lines 3677-3680 |
| `src/components/DisplacementPanel.ts` | `src/services/displacement/index.ts` | import `UnhcrSummary`, `CountryDisplacement`, `formatPopulation` | WIRED | Lines 3-4: both type imports and `formatPopulation` from `@/services/displacement` |
| `src/components/DeckGLMap.ts` | `src/services/displacement/index.ts` | import `DisplacementFlow` type for arc layer | WIRED | Line 37: `import type { DisplacementFlow } from '@/services/displacement'`; used at line 3177+ |
| `src/components/MapContainer.ts` | `src/services/displacement/index.ts` | import `DisplacementFlow` type | WIRED | Line 29: `import type { DisplacementFlow } from '@/services/displacement'`; used at line 281 |
| `src/services/country-instability.ts` | `src/services/displacement/index.ts` | import `CountryDisplacement` type for CII ingestion | WIRED | Line 8: `import type { CountryDisplacement } from '@/services/displacement'`; used at lines 33, 47 |
| `src/services/conflict-impact.ts` | `src/services/displacement/index.ts` | import `CountryDisplacement` type | WIRED | Line 2: `import type { CountryDisplacement } from '@/services/displacement'`; used at line 275 |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| DOMAIN-07 | 2G-01, 2G-02 | Geopolitical domain proto with service RPCs and HTTP annotations (UNHCR refugees component) | SATISFIED | Displacement proto generated at `src/generated/server/worldmonitor/displacement/v1/service_server.ts`; handler implements full RPC; note: DOMAIN-07 covers multiple geopolitical domains -- the UNHCR/displacement component is complete |
| SERVER-02 | 2G-01, 2G-02 | Handler implementations for each domain proxying upstream external APIs and returning proto-typed responses | SATISFIED | `displacementHandler` proxies UNHCR Population API with full pagination, aggregation, and proto-typed `GetDisplacementSummaryResponse` return |

**Note on DOMAIN-07 scope:** DOMAIN-07 as defined in REQUIREMENTS.md covers "ACLED conflicts, UCDP events, GDELT tensions, HAPI humanitarian, UNHCR refugees" -- a multi-domain proto package. Phase 2G specifically addresses the UNHCR refugees/displacement component. Both plans in 2G claim `requirements: [DOMAIN-07]`. The requirement is marked Complete in REQUIREMENTS.md traceability table (Phase 7), consistent with the proto code generation having been done in Phase 2A. Phase 2G completes the runtime handler + consumer wiring portion. No orphaned requirements found.

**Note on ROADMAP stale status:** The ROADMAP shows Phase 2G as "Status: In progress" with 2G-02-PLAN.md checkbox unchecked and "1/2 plans complete" in the summary line. This is a documentation inconsistency -- the code fully implements all 2G-02 goals (service module created, all consumers rewired, legacy deleted). This is a docs-only gap, not a code gap.

---

### Anti-Patterns Found

None. No TODO, FIXME, placeholder, stub, or empty implementation patterns found in any phase 2G files.

---

### Human Verification Required

#### 1. UNHCR API Live Connectivity

**Test:** Run the application and trigger a displacement data fetch. Check that the displacement panel populates with actual refugee/IDP counts.
**Expected:** Panel shows non-zero globalTotals and a populated country list (approximately 180+ countries).
**Why human:** Handler connects to live `api.unhcr.org` -- cannot verify the UNHCR API contract or data freshness programmatically.

#### 2. Year Fallback Behavior

**Test:** Observe which year the handler selects at runtime (check network traffic to `api.unhcr.org`).
**Expected:** Handler fetches current year; if empty, falls back to current-1, then current-2.
**Why human:** Year availability depends on when UNHCR publishes data -- current year (2026) may have no data yet, requiring fallback to 2025 or 2024.

#### 3. Displacement Arc Layer Rendering

**Test:** Enable the displacement map layer and verify arc lines appear between origin and asylum countries.
**Expected:** Arc lines drawn between country pairs (e.g., AFG->TUR, SYR->DEU), scaled by refugee count.
**Why human:** Visual map rendering requires running the app; DeckGL arc layer can silently fail with null coordinates.

---

### Gaps Summary

No gaps. All 22 must-have truths verified against the actual codebase. All artifacts exist and are substantive (no stubs). All key links are wired (imports used, not just declared). Legacy files deleted. Dead types removed. Commits confirmed in git history.

The only noteworthy item is a stale ROADMAP documentation status ("In progress", unchecked 2G-02 checkbox) that does not reflect the completed code state. This is a documentation cleanup item, not a code gap.

---

_Verified: 2026-02-19T09:15:23Z_
_Verifier: Claude (gsd-verifier)_
