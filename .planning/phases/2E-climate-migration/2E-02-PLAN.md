---
phase: 2E-climate-migration
plan: 02
type: execute
wave: 2
depends_on: [2E-01]
files_modified:
  - src/services/climate.ts (delete)
  - src/services/climate/index.ts (create)
  - src/App.ts
  - src/components/ClimateAnomalyPanel.ts
  - src/components/DeckGLMap.ts
  - src/components/MapContainer.ts
  - src/services/country-instability.ts
  - src/services/conflict-impact.ts
  - src/types/index.ts
  - api/climate-anomalies.js
autonomous: true
requirements: [DOMAIN-01, SERVER-02]

must_haves:
  truths:
    - "App.ts loads climate anomalies via the rewritten climate service module using ClimateServiceClient"
    - "ClimateAnomalyPanel displays anomalies with correct severity icons, temperature/precipitation deltas, and severity badges"
    - "DeckGLMap renders climate heatmap layer with correct position and weight from anomaly data"
    - "Country instability ingestion receives anomalies with lowercase severity strings matching existing comparison logic"
    - "Conflict impact correlation receives anomalies with zone and severity fields matching existing fuzzy-match logic"
    - "Legacy api/climate-anomalies.js endpoint is deleted"
    - "ClimateAnomaly and AnomalySeverity types removed from src/types/index.ts"
    - "getSeverityColor dead code is dropped from the rewritten service module"
  artifacts:
    - path: "src/services/climate/index.ts"
      provides: "Climate service port/adapter with fetchClimateAnomalies, getSeverityIcon, formatDelta"
      exports: ["fetchClimateAnomalies", "getSeverityIcon", "formatDelta", "ClimateAnomaly", "ClimateFetchResult"]
    - path: "src/App.ts"
      provides: "Climate data loading using new service module"
      contains: "@/services/climate"
  key_links:
    - from: "src/services/climate/index.ts"
      to: "src/generated/client/worldmonitor/climate/v1/service_client.ts"
      via: "ClimateServiceClient.listClimateAnomalies"
      pattern: "ClimateServiceClient"
    - from: "src/App.ts"
      to: "src/services/climate/index.ts"
      via: "import fetchClimateAnomalies"
      pattern: "@/services/climate"
    - from: "src/components/ClimateAnomalyPanel.ts"
      to: "src/services/climate/index.ts"
      via: "import ClimateAnomaly type + getSeverityIcon + formatDelta"
      pattern: "@/services/climate"
    - from: "src/components/DeckGLMap.ts"
      to: "src/services/climate/index.ts"
      via: "import ClimateAnomaly type for heatmap layer"
      pattern: "@/services/climate"
---

<objective>
Rewrite the climate service module as a port/adapter backed by ClimateServiceClient, rewire all 6 consumer files to import from the rewritten service module, delete the legacy endpoint, and remove dead types from @/types.

Purpose: Completes the climate domain migration end-to-end by connecting the frontend to the new ClimateServiceClient, using a service module that maps proto shapes (GeoCoordinates, enum severity/type) to the consumer-friendly legacy shape (flat lat/lon, lowercase strings).
Output: All climate data flows through sebuf. Legacy endpoint deleted. Dead types cleaned up.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2E-climate-migration/2E-RESEARCH.md
@.planning/phases/2E-climate-migration/2E-01-SUMMARY.md
@.planning/phases/2C-seismology-migration/2C-02-SUMMARY.md

@src/services/climate.ts (legacy, to be deleted and replaced with directory)
@src/services/wildfires/index.ts (reference for directory pattern)
@src/generated/client/worldmonitor/climate/v1/service_client.ts
@src/App.ts (lines 30-36, 3688-3707)
@src/components/ClimateAnomalyPanel.ts
@src/components/DeckGLMap.ts (lines 30-38, 264-266, 3194-3214, 3299-3304)
@src/components/MapContainer.ts (lines 25-31, 287-291)
@src/services/country-instability.ts (lines 1-8, 279-299)
@src/services/conflict-impact.ts (lines 1-18, 47-58)
@src/types/index.ts (lines 299-310)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Rewrite climate service module and rewire all consumers</name>
  <files>
    src/services/climate.ts (delete)
    src/services/climate/index.ts (create)
    src/App.ts
    src/components/ClimateAnomalyPanel.ts
    src/components/DeckGLMap.ts
    src/components/MapContainer.ts
    src/services/country-instability.ts
    src/services/conflict-impact.ts
  </files>
  <action>
**Step 1: Replace `src/services/climate.ts` with `src/services/climate/index.ts` directory module.**

Delete `src/services/climate.ts` and create `src/services/climate/index.ts`. Uses the directory-per-service pattern established by wildfires (`src/services/wildfires/index.ts`) for consistency — every domain gets its own directory under `src/services/`. Import paths (`@/services/climate`) resolve identically for both file and directory-with-index.

```typescript
import {
  ClimateServiceClient,
  type ClimateAnomaly as ProtoClimateAnomaly,
  type AnomalySeverity as ProtoAnomalySeverity,
  type AnomalyType as ProtoAnomalyType,
} from '@/generated/client/worldmonitor/climate/v1/service_client';

// Re-export consumer-friendly type matching legacy shape exactly.
// Consumers import this type from '@/services/climate' and see the same
// lat/lon/severity/type fields they always used. The proto -> legacy
// mapping happens internally in toDisplayAnomaly().
export interface ClimateAnomaly {
  zone: string;
  lat: number;
  lon: number;
  tempDelta: number;
  precipDelta: number;
  severity: 'normal' | 'moderate' | 'extreme';
  type: 'warm' | 'cold' | 'wet' | 'dry' | 'mixed';
  period: string;
}

export interface ClimateFetchResult {
  ok: boolean;
  anomalies: ClimateAnomaly[];
}

const client = new ClimateServiceClient('');

export async function fetchClimateAnomalies(): Promise<ClimateFetchResult> {
  try {
    const response = await client.listClimateAnomalies({});
    const anomalies = (response.anomalies ?? [])
      .map(toDisplayAnomaly)
      .filter(a => a.severity !== 'normal');
    return { ok: true, anomalies };
  } catch (error) {
    console.warn('[Climate] Fetch failed:', error);
    return { ok: false, anomalies: [] };
  }
}

// Presentation helpers (used by ClimateAnomalyPanel)
export function getSeverityIcon(anomaly: ClimateAnomaly): string {
  switch (anomaly.type) {
    case 'warm': return '\u{1F321}\u{FE0F}';   // 🌡️
    case 'cold': return '\u{2744}\u{FE0F}';     // ❄️
    case 'wet': return '\u{1F327}\u{FE0F}';     // 🌧️
    case 'dry': return '\u{2600}\u{FE0F}';      // ☀️
    case 'mixed': return '\u{26A1}';             // ⚡
    default: return '\u{1F321}\u{FE0F}';         // 🌡️
  }
}

export function formatDelta(value: number, unit: string): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}${unit}`;
}

// Internal: Map proto ClimateAnomaly -> consumer-friendly shape
function toDisplayAnomaly(proto: ProtoClimateAnomaly): ClimateAnomaly {
  return {
    zone: proto.zone,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    tempDelta: proto.tempDelta,
    precipDelta: proto.precipDelta,
    severity: mapSeverity(proto.severity),
    type: mapType(proto.type),
    period: proto.period,
  };
}

function mapSeverity(s: ProtoAnomalySeverity): ClimateAnomaly['severity'] {
  switch (s) {
    case 'ANOMALY_SEVERITY_EXTREME': return 'extreme';
    case 'ANOMALY_SEVERITY_MODERATE': return 'moderate';
    default: return 'normal';
  }
}

function mapType(t: ProtoAnomalyType): ClimateAnomaly['type'] {
  switch (t) {
    case 'ANOMALY_TYPE_WARM': return 'warm';
    case 'ANOMALY_TYPE_COLD': return 'cold';
    case 'ANOMALY_TYPE_WET': return 'wet';
    case 'ANOMALY_TYPE_DRY': return 'dry';
    case 'ANOMALY_TYPE_MIXED': return 'mixed';
    default: return 'warm';
  }
}
```

**Key design decisions:**
- **`getSeverityColor` is dropped**: Dead code -- grep confirms no consumer imports it. Only `getSeverityIcon` and `formatDelta` are re-exported.
- **`timestamp` field dropped from ClimateFetchResult**: App.ts never accesses `result.timestamp`.
- **`severity !== 'normal'` filter stays in service module**: Same as legacy -- handler returns all anomalies, service module filters for display.
- **Emoji encoding**: Use unicode escape sequences to avoid encoding issues in the source file.

**Step 2: Rewire `src/components/ClimateAnomalyPanel.ts`.**

Change import on line 3:
- FROM: `import type { ClimateAnomaly } from '@/types';`
- TO: `import type { ClimateAnomaly } from '@/services/climate';`

Line 4 import (`import { getSeverityIcon, formatDelta } from '@/services/climate';`) stays the same -- already points to `@/services/climate`.

No other changes needed. The panel accesses `a.zone`, `a.lat`, `a.lon`, `a.tempDelta`, `a.precipDelta`, `a.severity`, `a.type` -- all present in the re-exported `ClimateAnomaly` interface with identical types. CSS classes like `severity-${a.severity}` and i18n keys like `components.climate.severity.${a.severity}` will work because severity is still the lowercase string (`'extreme'`, `'moderate'`, `'normal'`).

**Step 3: Rewire `src/components/DeckGLMap.ts`.**

Change import on line 32:
- FROM: `ClimateAnomaly,` (inside the `from '@/types'` import block)
- TO: Remove `ClimateAnomaly` from the `@/types` import

Add new import:
```typescript
import type { ClimateAnomaly } from '@/services/climate';
```

Place it near the existing `import type { Earthquake } from '@/services/earthquakes';` line (line 39).

No other changes needed. The heatmap layer accesses `d.lon`, `d.lat`, `d.tempDelta`, `d.precipDelta` -- all present in the re-exported interface.

**Step 4: Rewire `src/components/MapContainer.ts`.**

Change import on line 28:
- FROM: `ClimateAnomaly,` (inside the `from '@/types'` import block)
- TO: Remove `ClimateAnomaly` from the `@/types` import

Add new import:
```typescript
import type { ClimateAnomaly } from '@/services/climate';
```

Place it near the existing `import type { Earthquake } from '@/services/earthquakes';` line (line 31).

No other changes needed -- `setClimateAnomalies(anomalies: ClimateAnomaly[])` just delegates to DeckGLMap.

**Step 5: Rewire `src/services/country-instability.ts`.**

Change import on line 8:
- FROM: `import type { CountryDisplacement, ClimateAnomaly } from '@/types';`
- TO: `import type { CountryDisplacement } from '@/types';`

Add new import:
```typescript
import type { ClimateAnomaly } from '@/services/climate';
```

No other changes needed. `ingestClimateForCII` accesses `a.severity` (comparing to `'normal'`, `'extreme'`) and `a.zone` -- both present in the re-exported interface with identical values.

**Step 6: Rewire `src/services/conflict-impact.ts`.**

Change import on line 1:
- FROM: `import type { UcdpGeoEvent, CountryDisplacement, ClimateAnomaly, PopulationExposure } from '@/types';`
- TO: `import type { UcdpGeoEvent, CountryDisplacement, PopulationExposure } from '@/types';`

Add new import:
```typescript
import type { ClimateAnomaly } from '@/services/climate';
```

No other changes needed. `correlateConflictImpact` accesses `a.zone` and `a.severity` (comparing to `'extreme'`, `'moderate'`) -- both present in the re-exported interface with identical values.

**Step 7: Verify App.ts needs no changes.**

App.ts already imports `fetchClimateAnomalies` from `@/services/climate` (line 34). It does NOT import `ClimateAnomaly` from `@/types`. It accesses `climateResult.ok` and `climateResult.anomalies` -- both present in the new `ClimateFetchResult` interface. The `ingestClimateForCII` import comes from `@/services/country-instability` which will have its own `ClimateAnomaly` from the climate service. **No changes needed in App.ts.**

**Step 8: Verify no remaining imports of `ClimateAnomaly` from `@/types`.**

Search for `ClimateAnomaly` imports from `@/types` across the codebase. After Steps 2-6, there should be zero matches.

**Step 9: Type check.**

Run `npx tsc --noEmit` to confirm zero errors.
  </action>
  <verify>
Run `npx tsc --noEmit` -- zero errors. Grep the codebase for `ClimateAnomaly.*from '@/types'` -- should have zero matches. Grep for `@/services/climate` -- should appear in App.ts, ClimateAnomalyPanel.ts, DeckGLMap.ts, MapContainer.ts, country-instability.ts, and conflict-impact.ts.
  </verify>
  <done>
Legacy `src/services/climate.ts` deleted. New climate service module at `src/services/climate/index.ts` as port/adapter using ClimateServiceClient (directory pattern matching wildfires). All 6 consumer files import ClimateAnomaly from `@/services/climate` instead of `@/types`. Proto enum and GeoCoordinates mapping handled internally by the service module. Severity icon and delta formatting helpers preserved. Dead `getSeverityColor` function dropped. Type check passes.
  </done>
</task>

<task type="auto">
  <name>Task 2: Delete legacy climate endpoint, remove dead types, and rebuild</name>
  <files>
    api/climate-anomalies.js
    src/types/index.ts
  </files>
  <action>
**Step 1: Delete the legacy endpoint.**

- Delete `api/climate-anomalies.js` -- replaced by `api/server/worldmonitor/climate/v1/handler.ts`

**Step 2: Remove dead types from `src/types/index.ts`.**

After all consumers are rewired to import `ClimateAnomaly` from `@/services/climate`, the following types in `src/types/index.ts` are dead code:

```typescript
export type AnomalySeverity = 'normal' | 'moderate' | 'extreme';

export interface ClimateAnomaly {
  zone: string;
  lat: number;
  lon: number;
  tempDelta: number;
  precipDelta: number;
  severity: AnomalySeverity;
  type: 'warm' | 'cold' | 'wet' | 'dry' | 'mixed';
  period: string;
}
```

Before deleting, verify with grep that no file still imports `ClimateAnomaly` or `AnomalySeverity` from `@/types`. If any remain, fix the import first.

Remove both the `AnomalySeverity` type alias and the `ClimateAnomaly` interface from `src/types/index.ts`.

**Step 3: Verify no remaining references.**

Grep the entire codebase for:
- `climate-anomalies` (the legacy API path) -- should have zero matches in `src/` (only allowed in `.planning/` docs)
- `AnomalySeverity` from `@/types` -- should have zero matches
- `ClimateAnomaly` from `@/types` -- should have zero matches
- `getSeverityColor` -- should have zero matches (dead code was in the old service file, now dropped)

If any references remain, fix them.

**Step 4: Rebuild sidecar and type check.**

Run `npm run build:sidecar-sebuf` to rebuild (ensures no dangling references in the sidecar bundle).
Run `npx tsc --noEmit` to confirm zero errors.
Run `npm run build` to confirm the full Vite build succeeds.
  </action>
  <verify>
`api/climate-anomalies.js` does not exist. `npx tsc --noEmit` passes. `npm run build` succeeds. No grep matches for `climate-anomalies` in `src/` or `api/` (excluding planning docs). No grep matches for `ClimateAnomaly` or `AnomalySeverity` in `src/types/index.ts`. No grep matches for `getSeverityColor` anywhere.
  </verify>
  <done>
Legacy climate endpoint deleted. Dead `ClimateAnomaly` and `AnomalySeverity` types removed from `src/types/index.ts`. No dangling references. Full build passes. Climate domain is fully migrated to sebuf.
  </done>
</task>

</tasks>

<verification>
1. `src/services/climate/index.ts` exports `fetchClimateAnomalies`, `getSeverityIcon`, `formatDelta`, `ClimateAnomaly`, `ClimateFetchResult` (old `src/services/climate.ts` deleted)
2. `src/App.ts` imports `fetchClimateAnomalies` from `@/services/climate` (unchanged)
3. `src/components/ClimateAnomalyPanel.ts` imports `ClimateAnomaly` from `@/services/climate` (not `@/types`)
4. `src/components/DeckGLMap.ts` imports `ClimateAnomaly` from `@/services/climate` (not `@/types`)
5. `src/components/MapContainer.ts` imports `ClimateAnomaly` from `@/services/climate` (not `@/types`)
6. `src/services/country-instability.ts` imports `ClimateAnomaly` from `@/services/climate` (not `@/types`)
7. `src/services/conflict-impact.ts` imports `ClimateAnomaly` from `@/services/climate` (not `@/types`)
8. `api/climate-anomalies.js` is deleted
9. `src/types/index.ts` no longer contains `ClimateAnomaly` or `AnomalySeverity`
10. `npx tsc --noEmit` passes with zero errors
11. `npm run build` succeeds
12. Zero grep matches for `ClimateAnomaly.*from '@/types'` across codebase
</verification>

<success_criteria>
All climate anomaly data flows through the ClimateServiceClient -> sebuf gateway -> climate handler pipeline. The climate service module maps proto shapes to legacy-compatible consumer shapes. All 6 consumers use the new import path. Legacy endpoint and dead types are deleted. Full build passes.
</success_criteria>

<output>
After completion, create `.planning/phases/2E-climate-migration/2E-02-SUMMARY.md`
</output>
