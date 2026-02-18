---
phase: 2G-displacement-migration
plan: 02
type: execute
wave: 2
depends_on: ["2G-01"]
files_modified:
  - src/services/unhcr.ts (delete)
  - src/services/displacement/index.ts (create)
  - src/App.ts
  - src/components/DisplacementPanel.ts
  - src/components/MapContainer.ts
  - src/components/DeckGLMap.ts
  - src/services/conflict-impact.ts
  - src/services/country-instability.ts
  - src/types/index.ts
  - api/unhcr-population.js (delete)
autonomous: true
requirements: [DOMAIN-07, SERVER-02]

must_haves:
  truths:
    - "App.ts loads displacement data via the rewritten displacement service module using DisplacementServiceClient"
    - "DisplacementPanel displays globalTotals (refugees, asylumSeekers, idps, total) as numbers, not string-concatenated"
    - "DisplacementPanel accesses country fields (refugees, asylumSeekers, hostTotal, totalDisplaced, lat, lon) as numbers"
    - "DeckGLMap renders displacement arc layer with flat originLat/originLon/asylumLat/asylumLon from flows"
    - "Country instability ingests displacement data with code, name, refugees, asylumSeekers as numbers"
    - "Conflict impact receives displacement data with name, code, refugees, asylumSeekers as numbers"
    - "All int64 string fields from proto are converted to number in the service module adapter"
    - "All GeoCoordinates objects from proto are unpacked to flat lat/lon fields in the service module adapter"
    - "Legacy api/unhcr-population.js endpoint is deleted"
    - "Legacy src/services/unhcr.ts is deleted"
    - "DisplacementFlow, CountryDisplacement, UnhcrSummary types removed from src/types/index.ts"
  artifacts:
    - path: "src/services/displacement/index.ts"
      provides: "Displacement service port/adapter with fetchUnhcrPopulation, getDisplacementColor, getDisplacementBadge, formatPopulation, getOriginCountries, getHostCountries"
      exports: ["fetchUnhcrPopulation", "getDisplacementColor", "getDisplacementBadge", "formatPopulation", "getOriginCountries", "getHostCountries", "UnhcrSummary", "CountryDisplacement", "DisplacementFlow", "UnhcrFetchResult"]
    - path: "src/App.ts"
      provides: "Displacement data loading using new service module"
      contains: "@/services/displacement"
  key_links:
    - from: "src/services/displacement/index.ts"
      to: "src/generated/client/worldmonitor/displacement/v1/service_client.ts"
      via: "DisplacementServiceClient.getDisplacementSummary"
      pattern: "DisplacementServiceClient"
    - from: "src/App.ts"
      to: "src/services/displacement/index.ts"
      via: "import fetchUnhcrPopulation"
      pattern: "@/services/displacement"
    - from: "src/components/DisplacementPanel.ts"
      to: "src/services/displacement/index.ts"
      via: "import UnhcrSummary, CountryDisplacement types + formatPopulation"
      pattern: "@/services/displacement"
    - from: "src/components/DeckGLMap.ts"
      to: "src/services/displacement/index.ts"
      via: "import DisplacementFlow type for arc layer"
      pattern: "@/services/displacement"
    - from: "src/services/country-instability.ts"
      to: "src/services/displacement/index.ts"
      via: "import CountryDisplacement type for CII ingestion"
      pattern: "@/services/displacement"
---

<objective>
Rewrite the displacement service module as a port/adapter backed by DisplacementServiceClient, mapping proto shapes (int64 strings, GeoCoordinates objects) to legacy consumer shapes (numbers, flat lat/lon). Rewire all 6 consumer files, delete the legacy endpoint and service, and remove dead types from @/types.

Purpose: Completes the displacement domain migration end-to-end by connecting the frontend to the new DisplacementServiceClient. The service module is a standard port/adapter (like climate 2E), NOT complex like prediction 2F. The main mapping concern is converting all int64 `string` fields to `number` and unpacking `GeoCoordinates { latitude, longitude }` to flat `lat`/`lon` so consumers continue to work with arithmetic and flat coordinate access unchanged.

Output: All displacement data flows through sebuf. Legacy endpoint and service deleted. Dead types cleaned up. 6 consumer files rewired.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2G-displacement-migration/2G-RESEARCH.md
@.planning/phases/2G-displacement-migration/2G-01-SUMMARY.md

# Reference: prior service module patterns
@src/services/climate/index.ts
@src/services/wildfires/index.ts

# Legacy service being replaced
@src/services/unhcr.ts

# Generated client (called by the service module)
@src/generated/client/worldmonitor/displacement/v1/service_client.ts

# Consumers to rewire
@src/App.ts
@src/components/DisplacementPanel.ts
@src/components/MapContainer.ts
@src/components/DeckGLMap.ts
@src/services/conflict-impact.ts
@src/services/country-instability.ts

# Types to clean up
@src/types/index.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create displacement service module and rewire all consumers</name>
  <files>
    src/services/unhcr.ts (delete)
    src/services/displacement/index.ts (create)
    src/App.ts
    src/components/DisplacementPanel.ts
    src/components/MapContainer.ts
    src/components/DeckGLMap.ts
    src/services/conflict-impact.ts
    src/services/country-instability.ts
  </files>
  <action>
**Step 1: Replace `src/services/unhcr.ts` with `src/services/displacement/index.ts` directory module.**

Delete `src/services/unhcr.ts` and create `src/services/displacement/index.ts`. Uses the directory-per-service pattern established by wildfires and climate.

```typescript
import {
  DisplacementServiceClient,
  type GetDisplacementSummaryResponse as ProtoResponse,
  type CountryDisplacement as ProtoCountry,
  type DisplacementFlow as ProtoFlow,
  type GlobalDisplacementTotals as ProtoGlobalTotals,
} from '@/generated/client/worldmonitor/displacement/v1/service_client';
import { createCircuitBreaker, getCSSColor } from '@/utils';

// ─── Consumer-friendly types (matching legacy shape exactly) ───

export interface DisplacementFlow {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;        // number, NOT string
  originLat?: number;      // flat, NOT GeoCoordinates
  originLon?: number;
  asylumLat?: number;
  asylumLon?: number;
}

export interface CountryDisplacement {
  code: string;
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
  totalDisplaced: number;
  hostRefugees: number;
  hostAsylumSeekers: number;
  hostTotal: number;
  lat?: number;
  lon?: number;
}

export interface UnhcrSummary {
  year: number;
  globalTotals: {
    refugees: number;
    asylumSeekers: number;
    idps: number;
    stateless: number;
    total: number;
  };
  countries: CountryDisplacement[];
  topFlows: DisplacementFlow[];
}

export interface UnhcrFetchResult {
  ok: boolean;
  data: UnhcrSummary;
  cachedAt?: string;
}

// ─── Internal: proto -> legacy mapping ───

function toDisplaySummary(proto: ProtoResponse): UnhcrSummary {
  const s = proto.summary!;
  const gt = s.globalTotals!;
  return {
    year: s.year,
    globalTotals: {
      refugees: Number(gt.refugees),
      asylumSeekers: Number(gt.asylumSeekers),
      idps: Number(gt.idps),
      stateless: Number(gt.stateless),
      total: Number(gt.total),
    },
    countries: s.countries.map(toDisplayCountry),
    topFlows: s.topFlows.map(toDisplayFlow),
  };
}

function toDisplayCountry(proto: ProtoCountry): CountryDisplacement {
  return {
    code: proto.code,
    name: proto.name,
    refugees: Number(proto.refugees),
    asylumSeekers: Number(proto.asylumSeekers),
    idps: Number(proto.idps),
    stateless: Number(proto.stateless),
    totalDisplaced: Number(proto.totalDisplaced),
    hostRefugees: Number(proto.hostRefugees),
    hostAsylumSeekers: Number(proto.hostAsylumSeekers),
    hostTotal: Number(proto.hostTotal),
    lat: proto.location?.latitude,
    lon: proto.location?.longitude,
  };
}

function toDisplayFlow(proto: ProtoFlow): DisplacementFlow {
  return {
    originCode: proto.originCode,
    originName: proto.originName,
    asylumCode: proto.asylumCode,
    asylumName: proto.asylumName,
    refugees: Number(proto.refugees),
    originLat: proto.originLocation?.latitude,
    originLon: proto.originLocation?.longitude,
    asylumLat: proto.asylumLocation?.latitude,
    asylumLon: proto.asylumLocation?.longitude,
  };
}

// ─── Client + circuit breaker ───

const client = new DisplacementServiceClient('');

const emptyResult: UnhcrSummary = {
  year: new Date().getFullYear(),
  globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
  countries: [],
  topFlows: [],
};

const breaker = createCircuitBreaker<UnhcrSummary>({
  name: 'UNHCR Displacement',
});

// ─── Main fetch (public API) ───

export async function fetchUnhcrPopulation(): Promise<UnhcrFetchResult> {
  const data = await breaker.execute(async () => {
    const response = await client.getDisplacementSummary({
      year: 0,          // 0 = handler uses year fallback
      countryLimit: 0,  // 0 = all countries
      flowLimit: 50,    // top 50 flows (matching legacy)
    });
    return toDisplaySummary(response);
  }, emptyResult);

  return {
    ok: data !== emptyResult && data.countries.length > 0,
    data,
  };
}

// ─── Presentation helpers (copied verbatim from legacy src/services/unhcr.ts) ───

export function getDisplacementColor(totalDisplaced: number): [number, number, number, number] {
  if (totalDisplaced >= 1_000_000) return [255, 50, 50, 200];
  if (totalDisplaced >= 500_000) return [255, 150, 0, 200];
  if (totalDisplaced >= 100_000) return [255, 220, 0, 180];
  return [100, 200, 100, 150];
}

export function getDisplacementBadge(totalDisplaced: number): { label: string; color: string } {
  if (totalDisplaced >= 1_000_000) return { label: 'CRISIS', color: getCSSColor('--semantic-critical') };
  if (totalDisplaced >= 500_000) return { label: 'HIGH', color: getCSSColor('--semantic-high') };
  if (totalDisplaced >= 100_000) return { label: 'ELEVATED', color: getCSSColor('--semantic-elevated') };
  return { label: '', color: '' };
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function getOriginCountries(data: UnhcrSummary): CountryDisplacement[] {
  return [...data.countries]
    .filter(c => c.refugees + c.asylumSeekers > 0)
    .sort((a, b) => (b.refugees + b.asylumSeekers) - (a.refugees + a.asylumSeekers));
}

export function getHostCountries(data: UnhcrSummary): CountryDisplacement[] {
  return [...data.countries]
    .filter(c => (c.hostTotal || 0) > 0)
    .sort((a, b) => (b.hostTotal || 0) - (a.hostTotal || 0));
}
```

**Key design decisions:**
- **Circuit breaker preserved**: The legacy `src/services/unhcr.ts` uses `createCircuitBreaker`. Keep it for consistency and to avoid repeated slow UNHCR API calls when the upstream is down.
- **`getCSSColor` import preserved**: Used by `getDisplacementBadge` for CSS custom property access.
- **`ok` heuristic**: `data !== emptyResult && data.countries.length > 0` -- the circuit breaker returns `emptyResult` on failure, and an empty countries array means no real data was fetched.
- **`cachedAt` dropped**: The legacy service extracted `cached_at` from the API response. The sebuf handler does not return a cached_at field, so this is always undefined. The field stays in the interface for type compatibility but is never set.
- **`year: 0`**: Passing 0 tells the handler to use its year fallback logic (try current year, then -1, then -2).

**Step 2: Rewire `src/App.ts`.**

Change the import from:
```typescript
import { fetchUnhcrPopulation } from '@/services/unhcr';
```
to:
```typescript
import { fetchUnhcrPopulation } from '@/services/displacement';
```

Also check for any `ingestDisplacementForCII` import that references displacement data. The import of `ingestDisplacementForCII` comes from `@/services/country-instability` so it does not need to change -- `country-instability.ts` receives `CountryDisplacement[]` as a parameter, and that parameter type will be updated in Step 6.

No other changes needed in App.ts. It accesses `result.ok`, `result.data.countries`, `result.data.topFlows`, `result.data.countries.length` -- all present in the new `UnhcrFetchResult` and `UnhcrSummary` interfaces with identical shapes.

**Step 3: Rewire `src/components/DisplacementPanel.ts`.**

Change type imports from:
```typescript
import type { UnhcrSummary, CountryDisplacement } from '@/types';
```
to:
```typescript
import type { UnhcrSummary, CountryDisplacement } from '@/services/displacement';
```

Change function import from:
```typescript
import { formatPopulation } from '@/services/unhcr';
```
to:
```typescript
import { formatPopulation } from '@/services/displacement';
```

Also check if `getDisplacementBadge`, `getOriginCountries`, or `getHostCountries` are imported from `@/services/unhcr` in this file. If so, update those imports to `@/services/displacement` as well.

No other changes needed. The panel accesses `data.globalTotals.{refugees,asylumSeekers,idps,total}`, `c.refugees`, `c.asylumSeekers`, `c.hostTotal`, `c.totalDisplaced`, `c.name`, `c.lat`, `c.lon` -- all present as `number` in the re-exported interfaces.

**Step 4: Rewire `src/components/MapContainer.ts`.**

Change import:
- Remove `DisplacementFlow` from the `from '@/types'` import block
- Add: `import type { DisplacementFlow } from '@/services/displacement';`

Place it near existing service-type imports.

No other changes needed. MapContainer passes `flows` array through to DeckGLMap.

**Step 5: Rewire `src/components/DeckGLMap.ts`.**

Change import:
- Remove `DisplacementFlow` from the `from '@/types'` import block
- Add: `import type { DisplacementFlow } from '@/services/displacement';`

No other changes needed. The arc layer accesses `f.originLat`, `f.originLon`, `f.asylumLat`, `f.asylumLon`, `f.refugees` -- all present as `number | undefined` in the re-exported `DisplacementFlow` interface, exactly matching legacy shape.

**Step 6: Rewire `src/services/conflict-impact.ts`.**

Change import:
- Remove `CountryDisplacement` from the `from '@/types'` import block
- Add: `import type { CountryDisplacement } from '@/services/displacement';`

No other changes needed. `correlateConflictImpact` accesses `d.name`, `d.code`, `d.refugees`, `d.asylumSeekers` -- all present in the re-exported interface as `number`/`string`.

**Step 7: Rewire `src/services/country-instability.ts`.**

Change import:
- Remove `CountryDisplacement` from the `from '@/types'` import block
- Add: `import type { CountryDisplacement } from '@/services/displacement';`

No other changes needed. `ingestDisplacementForCII` accesses `c.code`, `c.name`, `c.refugees`, `c.asylumSeekers` -- all present in the re-exported interface.

**Step 8: Verify no remaining imports from legacy paths.**

Search the codebase for:
- `from '@/services/unhcr'` -- should have zero matches
- `DisplacementFlow.*from '@/types'` -- should have zero matches
- `CountryDisplacement.*from '@/types'` -- should have zero matches
- `UnhcrSummary.*from '@/types'` -- should have zero matches

If any remain, fix them.

**Step 9: Type check.**

Run `npx tsc --noEmit` to confirm zero errors.
  </action>
  <verify>
Run `npx tsc --noEmit` -- zero errors. Grep for `from '@/services/unhcr'` -- should have zero matches. Grep for `DisplacementFlow.*from '@/types'` -- zero matches. Grep for `CountryDisplacement.*from '@/types'` -- zero matches. Grep for `UnhcrSummary.*from '@/types'` -- zero matches. Grep for `@/services/displacement` -- should appear in App.ts, DisplacementPanel.ts, MapContainer.ts, DeckGLMap.ts, conflict-impact.ts, and country-instability.ts.
  </verify>
  <done>
Legacy `src/services/unhcr.ts` deleted. New displacement service module at `src/services/displacement/index.ts` as port/adapter using DisplacementServiceClient with circuit breaker. All int64 string->number mapping handled by toDisplaySummary/toDisplayCountry/toDisplayFlow. All GeoCoordinates->flat lat/lon mapping handled internally. Presentation helpers (getDisplacementColor, getDisplacementBadge, formatPopulation, getOriginCountries, getHostCountries) preserved verbatim. All 6 consumer files import from `@/services/displacement` instead of `@/types` and `@/services/unhcr`. Type check passes.
  </done>
</task>

<task type="auto">
  <name>Task 2: Delete legacy endpoint, remove dead types, and verify full build</name>
  <files>
    api/unhcr-population.js
    src/types/index.ts
  </files>
  <action>
**Step 1: Delete the legacy endpoint.**

Delete `api/unhcr-population.js` -- fully replaced by the handler at `api/server/worldmonitor/displacement/v1/handler.ts` (Plan 2G-01).

**Step 2: Remove dead types from `src/types/index.ts`.**

After all consumers are rewired to import from `@/services/displacement`, the following types in `src/types/index.ts` are dead code. According to the research, these are at approximately lines 255-296:

```typescript
// UNHCR Displacement Data
export interface DisplacementFlow {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;
  originLat?: number;
  originLon?: number;
  asylumLat?: number;
  asylumLon?: number;
}

export interface CountryDisplacement {
  code: string;
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
  totalDisplaced: number;
  hostRefugees: number;
  hostAsylumSeekers: number;
  hostTotal: number;
  lat?: number;
  lon?: number;
}

export interface UnhcrSummary {
  year: number;
  globalTotals: {
    refugees: number;
    asylumSeekers: number;
    idps: number;
    stateless: number;
    total: number;
  };
  countries: CountryDisplacement[];
  topFlows: DisplacementFlow[];
}
```

Before deleting, verify with grep that no file still imports `DisplacementFlow`, `CountryDisplacement`, or `UnhcrSummary` from `@/types`. If any remain, fix the import first.

Remove the comment, the `DisplacementFlow` interface, the `CountryDisplacement` interface, and the `UnhcrSummary` interface from `src/types/index.ts`.

**Step 3: Verify no remaining references.**

Grep the entire codebase for:
- `unhcr-population` (the legacy API path) -- should have zero matches in `src/` and `api/` (only allowed in `.planning/` docs)
- `from '@/services/unhcr'` -- should have zero matches
- `DisplacementFlow` from `@/types` -- should have zero matches
- `CountryDisplacement` from `@/types` -- should have zero matches
- `UnhcrSummary` from `@/types` -- should have zero matches

If any references remain, fix them.

**Step 4: Rebuild sidecar and type check.**

Run `npm run build:sidecar-sebuf` to rebuild (ensures no dangling references in the sidecar bundle).
Run `npx tsc --noEmit` to confirm zero errors.
Run `npm run build` to confirm the full Vite build succeeds.
  </action>
  <verify>
`api/unhcr-population.js` does not exist. `npx tsc --noEmit` passes. `npm run build` succeeds. No grep matches for `unhcr-population` in `src/` or `api/` (excluding planning docs). No grep matches for `DisplacementFlow`, `CountryDisplacement`, or `UnhcrSummary` in `src/types/index.ts`. No grep matches for `from '@/services/unhcr'` anywhere.
  </verify>
  <done>
Legacy displacement endpoint deleted. Dead `DisplacementFlow`, `CountryDisplacement`, and `UnhcrSummary` types removed from `src/types/index.ts`. No dangling references. Full build passes. Displacement domain is fully migrated to sebuf.
  </done>
</task>

</tasks>

<verification>
1. `src/services/displacement/index.ts` exports `fetchUnhcrPopulation`, `getDisplacementColor`, `getDisplacementBadge`, `formatPopulation`, `getOriginCountries`, `getHostCountries`, `UnhcrSummary`, `CountryDisplacement`, `DisplacementFlow`, `UnhcrFetchResult` (old `src/services/unhcr.ts` deleted)
2. `src/App.ts` imports `fetchUnhcrPopulation` from `@/services/displacement` (not `@/services/unhcr`)
3. `src/components/DisplacementPanel.ts` imports types from `@/services/displacement` (not `@/types`) and `formatPopulation` from `@/services/displacement` (not `@/services/unhcr`)
4. `src/components/DeckGLMap.ts` imports `DisplacementFlow` from `@/services/displacement` (not `@/types`)
5. `src/components/MapContainer.ts` imports `DisplacementFlow` from `@/services/displacement` (not `@/types`)
6. `src/services/conflict-impact.ts` imports `CountryDisplacement` from `@/services/displacement` (not `@/types`)
7. `src/services/country-instability.ts` imports `CountryDisplacement` from `@/services/displacement` (not `@/types`)
8. `api/unhcr-population.js` is deleted
9. `src/services/unhcr.ts` is deleted
10. `src/types/index.ts` no longer contains `DisplacementFlow`, `CountryDisplacement`, or `UnhcrSummary`
11. `npx tsc --noEmit` passes with zero errors
12. `npm run build` succeeds
13. Zero grep matches for displacement types from `@/types` across codebase
14. Zero grep matches for `from '@/services/unhcr'` across codebase
</verification>

<success_criteria>
All displacement data flows through the DisplacementServiceClient -> sebuf gateway -> displacement handler pipeline. The displacement service module maps proto shapes (int64 strings to numbers, GeoCoordinates to flat lat/lon) to legacy-compatible consumer shapes. Circuit breaker preserved for upstream failure protection. All 6 consumers use the new import path. Presentation helpers preserved verbatim. Legacy endpoint, legacy service, and dead types are deleted. Full build passes.
</success_criteria>

<output>
After completion, create `.planning/phases/2G-displacement-migration/2G-02-SUMMARY.md`
</output>
