---
phase: 2H-aviation-migration
plan: 02
type: execute
wave: 2
depends_on: ["2H-01"]
files_modified:
  - src/services/flights.ts (delete)
  - src/services/aviation/index.ts (create)
  - src/services/index.ts
  - src/App.ts
  - src/components/Map.ts
  - src/components/DeckGLMap.ts
  - src/components/MapContainer.ts
  - src/components/MapPopup.ts
  - src/e2e/map-harness.ts
  - src/types/index.ts
  - api/faa-status.js (delete)
autonomous: true
requirements: [DOMAIN-08, SERVER-02]

must_haves:
  truths:
    - "App.ts loads flight delays via the rewritten aviation service module using AviationServiceClient"
    - "Map.ts, DeckGLMap.ts, MapContainer.ts, MapPopup.ts, map-harness.ts import AirportDelayAlert from @/services/aviation (not @/types)"
    - "Service module maps proto enum strings back to short-form strings (FLIGHT_DELAY_TYPE_GROUND_STOP -> ground_stop, FLIGHT_DELAY_SEVERITY_SEVERE -> severe)"
    - "Service module unwraps GeoCoordinates { latitude, longitude } to flat lat/lon fields"
    - "Service module converts proto updatedAt number (epoch ms) to Date object"
    - "fetchFlightDelays returns AirportDelayAlert[] with circuit breaker wrapping"
    - "Legacy api/faa-status.js endpoint is deleted"
    - "Legacy src/services/flights.ts is deleted"
    - "FlightDelaySource, FlightDelaySeverity, FlightDelayType, AirportRegion, AirportDelayAlert types removed from src/types/index.ts"
    - "MonitoredAirport type preserved in src/types/index.ts (used by src/config/airports.ts)"
    - "Barrel export in src/services/index.ts updated: flights removed, aviation added"
  artifacts:
    - path: "src/services/aviation/index.ts"
      provides: "Aviation service port/adapter with fetchFlightDelays and re-exported AirportDelayAlert type"
      exports: ["fetchFlightDelays", "AirportDelayAlert"]
    - path: "src/App.ts"
      provides: "Flight delay data loading using new aviation service module"
      contains: "@/services/aviation"
  key_links:
    - from: "src/services/aviation/index.ts"
      to: "src/generated/client/worldmonitor/aviation/v1/service_client.ts"
      via: "AviationServiceClient.listAirportDelays"
      pattern: "AviationServiceClient"
    - from: "src/App.ts"
      to: "src/services/aviation/index.ts"
      via: "import fetchFlightDelays (through barrel or direct)"
      pattern: "fetchFlightDelays"
    - from: "src/components/Map.ts"
      to: "src/services/aviation/index.ts"
      via: "import AirportDelayAlert type"
      pattern: "@/services/aviation"
    - from: "src/components/DeckGLMap.ts"
      to: "src/services/aviation/index.ts"
      via: "import AirportDelayAlert type"
      pattern: "@/services/aviation"
    - from: "src/components/MapContainer.ts"
      to: "src/services/aviation/index.ts"
      via: "import AirportDelayAlert type"
      pattern: "@/services/aviation"
    - from: "src/components/MapPopup.ts"
      to: "src/services/aviation/index.ts"
      via: "import AirportDelayAlert type"
      pattern: "@/services/aviation"
---

<objective>
Rewrite the aviation service module as a port/adapter backed by AviationServiceClient, mapping proto shapes (proto enum strings, GeoCoordinates objects, epoch-ms updatedAt) to legacy consumer shapes (short-form string unions, flat lat/lon, Date objects). Rewire all consumer files, update barrel export, delete the legacy endpoint and service, and remove dead types from @/types.

Purpose: Completes the aviation domain migration end-to-end by connecting the frontend to the new AviationServiceClient. The service module maps proto enum strings back to short-form strings consumers expect, unwraps GeoCoordinates to flat lat/lon, and converts updatedAt epoch-ms to Date objects. Circuit breaker is preserved from legacy. The consumer rewiring is straightforward -- all 5 component files import AirportDelayAlert from @/types, which gets redirected to @/services/aviation.

Output: All aviation data flows through sebuf. Legacy endpoint and service deleted. Dead types cleaned up. All consumer files rewired.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2H-aviation-migration/2H-RESEARCH.md
@.planning/phases/2H-aviation-migration/2H-01-SUMMARY.md

# Reference: prior service module patterns
@src/services/displacement/index.ts
@src/services/climate/index.ts

# Legacy service being replaced
@src/services/flights.ts

# Generated client (called by the service module)
@src/generated/client/worldmonitor/aviation/v1/service_client.ts

# Consumers to rewire
@src/App.ts
@src/components/Map.ts
@src/components/DeckGLMap.ts
@src/components/MapContainer.ts
@src/components/MapPopup.ts
@src/e2e/map-harness.ts

# Barrel export to update
@src/services/index.ts

# Types to clean up
@src/types/index.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create aviation service module and rewire all consumers</name>
  <files>
    src/services/flights.ts (delete)
    src/services/aviation/index.ts (create)
    src/services/index.ts
    src/App.ts
    src/components/Map.ts
    src/components/DeckGLMap.ts
    src/components/MapContainer.ts
    src/components/MapPopup.ts
    src/e2e/map-harness.ts
  </files>
  <action>
**Step 1: Create `src/services/aviation/index.ts` directory module.**

Create the directory and file. This is the port/adapter wrapping AviationServiceClient:

```typescript
import {
  AviationServiceClient,
  type ListAirportDelaysResponse as ProtoResponse,
  type AirportDelayAlert as ProtoAlert,
} from '@/generated/client/worldmonitor/aviation/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// ─── Consumer-friendly types (matching legacy shape exactly) ───

export type FlightDelaySource = 'faa' | 'eurocontrol' | 'computed';
export type FlightDelaySeverity = 'normal' | 'minor' | 'moderate' | 'major' | 'severe';
export type FlightDelayType = 'ground_stop' | 'ground_delay' | 'departure_delay' | 'arrival_delay' | 'general';
export type AirportRegion = 'americas' | 'europe' | 'apac' | 'mena' | 'africa';

export interface AirportDelayAlert {
  id: string;
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  region: AirportRegion;
  delayType: FlightDelayType;
  severity: FlightDelaySeverity;
  avgDelayMinutes: number;
  delayedFlightsPct?: number;
  cancelledFlights?: number;
  totalFlights?: number;
  reason?: string;
  source: FlightDelaySource;
  updatedAt: Date;
}

// ─── Internal: proto -> legacy mapping ───

const SEVERITY_MAP: Record<string, FlightDelaySeverity> = {
  FLIGHT_DELAY_SEVERITY_NORMAL: 'normal',
  FLIGHT_DELAY_SEVERITY_MINOR: 'minor',
  FLIGHT_DELAY_SEVERITY_MODERATE: 'moderate',
  FLIGHT_DELAY_SEVERITY_MAJOR: 'major',
  FLIGHT_DELAY_SEVERITY_SEVERE: 'severe',
};

const DELAY_TYPE_MAP: Record<string, FlightDelayType> = {
  FLIGHT_DELAY_TYPE_GROUND_STOP: 'ground_stop',
  FLIGHT_DELAY_TYPE_GROUND_DELAY: 'ground_delay',
  FLIGHT_DELAY_TYPE_DEPARTURE_DELAY: 'departure_delay',
  FLIGHT_DELAY_TYPE_ARRIVAL_DELAY: 'arrival_delay',
  FLIGHT_DELAY_TYPE_GENERAL: 'general',
};

const REGION_MAP: Record<string, AirportRegion> = {
  AIRPORT_REGION_AMERICAS: 'americas',
  AIRPORT_REGION_EUROPE: 'europe',
  AIRPORT_REGION_APAC: 'apac',
  AIRPORT_REGION_MENA: 'mena',
  AIRPORT_REGION_AFRICA: 'africa',
};

const SOURCE_MAP: Record<string, FlightDelaySource> = {
  FLIGHT_DELAY_SOURCE_FAA: 'faa',
  FLIGHT_DELAY_SOURCE_EUROCONTROL: 'eurocontrol',
  FLIGHT_DELAY_SOURCE_COMPUTED: 'computed',
};

function toDisplayAlert(proto: ProtoAlert): AirportDelayAlert {
  return {
    id: proto.id,
    iata: proto.iata,
    icao: proto.icao,
    name: proto.name,
    city: proto.city,
    country: proto.country,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    region: REGION_MAP[proto.region] ?? 'americas',
    delayType: DELAY_TYPE_MAP[proto.delayType] ?? 'general',
    severity: SEVERITY_MAP[proto.severity] ?? 'normal',
    avgDelayMinutes: proto.avgDelayMinutes,
    delayedFlightsPct: proto.delayedFlightsPct || undefined,
    cancelledFlights: proto.cancelledFlights || undefined,
    totalFlights: proto.totalFlights || undefined,
    reason: proto.reason || undefined,
    source: SOURCE_MAP[proto.source] ?? 'computed',
    updatedAt: new Date(proto.updatedAt),
  };
}

// ─── Client + circuit breaker ───

const client = new AviationServiceClient('');
const breaker = createCircuitBreaker<AirportDelayAlert[]>({ name: 'FAA Flight Delays' });

// ─── Main fetch (public API) ───

export async function fetchFlightDelays(): Promise<AirportDelayAlert[]> {
  return breaker.execute(async () => {
    const response = await client.listAirportDelays({
      region: 'AIRPORT_REGION_UNSPECIFIED',
      minSeverity: 'FLIGHT_DELAY_SEVERITY_UNSPECIFIED',
    });
    return response.alerts.map(toDisplayAlert);
  }, []);
}
```

Key design decisions:
- **Circuit breaker preserved**: Same `createCircuitBreaker` pattern from legacy `src/services/flights.ts` with identical name string.
- **Proto enum reverse mapping**: All four enum types (severity, delay type, region, source) mapped back to short-form strings matching what consumers expect.
- **GeoCoordinates unwrapped**: `proto.location?.latitude ?? 0` -> flat `lat`, matching legacy shape.
- **updatedAt**: Proto returns `number` (epoch ms via INT64_ENCODING_NUMBER). Service module converts to `Date` to match legacy `updatedAt: Date`.
- **Zero-to-undefined mapping**: `delayedFlightsPct`, `cancelledFlights`, `totalFlights` are 0 when unset in proto; mapped to `undefined` for legacy compatibility (these fields are optional).
- **No helper functions re-exported**: Legacy `getAirportByCode`, `getAllMonitoredAirports`, `getFlightsStatus` are dead code (confirmed in research -- no external consumers).

**Step 2: Delete `src/services/flights.ts`.**

Delete the file. It is fully replaced by `src/services/aviation/index.ts`.

**Step 3: Update barrel export in `src/services/index.ts`.**

Replace line 18:
```typescript
export * from './flights';
```
with:
```typescript
export * from './aviation';
```

This preserves `fetchFlightDelays` in the barrel export so `src/App.ts` (which imports from `@/services`) continues to work without changing that import.

**Step 4: Rewire `src/components/Map.ts`.**

Remove `AirportDelayAlert` from the `from '@/types'` import on line 7. Add a separate import:
```typescript
import type { AirportDelayAlert } from '@/services/aviation';
```

**Step 5: Rewire `src/components/DeckGLMap.ts`.**

Remove `AirportDelayAlert` from the `from '@/types'` import on line 24. Add a separate import:
```typescript
import type { AirportDelayAlert } from '@/services/aviation';
```

**Step 6: Rewire `src/components/MapContainer.ts`.**

Remove `AirportDelayAlert` from the `from '@/types'` import on line 20. Add a separate import:
```typescript
import type { AirportDelayAlert } from '@/services/aviation';
```

**Step 7: Rewire `src/components/MapPopup.ts`.**

Remove `AirportDelayAlert` from the `from '@/types'` import on line 1. Add a separate import:
```typescript
import type { AirportDelayAlert } from '@/services/aviation';
```

**Step 8: Rewire `src/e2e/map-harness.ts`.**

Remove `AirportDelayAlert` from the `from '@/types'` import on line 33. Add a separate import:
```typescript
import type { AirportDelayAlert } from '@/services/aviation';
```

**Step 9: Check `src/App.ts`.**

App.ts imports `fetchFlightDelays` from `@/services` (barrel). Since Step 3 updated the barrel to re-export from `./aviation`, no change is needed in App.ts itself. Verify this is the case by reading the import line.

**Step 10: Verify no remaining imports from legacy paths.**

Search the codebase for:
- `from '@/services/flights'` -- should have zero matches
- `AirportDelayAlert.*from '@/types'` -- should have zero matches
- `FlightDelaySeverity.*from '@/types'` -- should have zero matches (only flights.ts used these)
- `FlightDelayType.*from '@/types'` -- should have zero matches

If any remain, fix them.

**Step 11: Type check.**

Run `npx tsc --noEmit` to confirm zero errors.
  </action>
  <verify>
Run `npx tsc --noEmit` -- zero errors. Grep for `from '@/services/flights'` -- zero matches. Grep for `AirportDelayAlert.*from '@/types'` -- zero matches. Grep for `@/services/aviation` in components -- should appear in Map.ts, DeckGLMap.ts, MapContainer.ts, MapPopup.ts, map-harness.ts.
  </verify>
  <done>
Legacy `src/services/flights.ts` deleted. New aviation service module at `src/services/aviation/index.ts` as port/adapter using AviationServiceClient with circuit breaker. Proto enum strings mapped back to short-form (severity, delayType, region, source). GeoCoordinates unwrapped to flat lat/lon. updatedAt epoch-ms converted to Date. All 5 component consumers + e2e harness import AirportDelayAlert from `@/services/aviation`. Barrel export updated. Type check passes.
  </done>
</task>

<task type="auto">
  <name>Task 2: Delete legacy endpoint, remove dead types, and verify full build</name>
  <files>
    api/faa-status.js
    src/types/index.ts
  </files>
  <action>
**Step 1: Delete the legacy FAA endpoint.**

Delete `api/faa-status.js` -- fully replaced by the handler at `api/server/worldmonitor/aviation/v1/handler.ts` (Plan 2H-01).

**Step 2: Remove dead aviation types from `src/types/index.ts`.**

After all consumers are rewired to import from `@/services/aviation`, the following types in `src/types/index.ts` are dead code (approximately lines 622-647):

```typescript
// Flight Delay Types
export type FlightDelaySource = 'faa' | 'eurocontrol' | 'computed';
export type FlightDelaySeverity = 'normal' | 'minor' | 'moderate' | 'major' | 'severe';
export type FlightDelayType = 'ground_stop' | 'ground_delay' | 'departure_delay' | 'arrival_delay' | 'general';
export type AirportRegion = 'americas' | 'europe' | 'apac' | 'mena' | 'africa';

export interface AirportDelayAlert {
  id: string;
  iata: string;
  // ... all fields ...
  updatedAt: Date;
}
```

Remove the comment, the four type aliases (`FlightDelaySource`, `FlightDelaySeverity`, `FlightDelayType`, `AirportRegion`), and the `AirportDelayAlert` interface from `src/types/index.ts`.

**IMPORTANT: Keep `MonitoredAirport` interface** (lines 649-658). It is still used by `src/config/airports.ts` which is shared infrastructure imported by the handler.

**IMPORTANT: `AirportRegion` is used by `MonitoredAirport`** via the `region: AirportRegion` field. Since we are removing `AirportRegion` from `src/types/index.ts`, `MonitoredAirport` needs a replacement. Two options:
1. Inline the type: change `region: AirportRegion` to `region: 'americas' | 'europe' | 'apac' | 'mena' | 'africa'` directly in `MonitoredAirport`
2. Keep `AirportRegion` in types/index.ts for MonitoredAirport

Choose option 1 (inline) to cleanly remove all aviation-legacy types. The `AirportRegion` type is now re-exported from `@/services/aviation` if any consumer needs it as a standalone type.

Before deleting, verify with grep that no file still imports `AirportDelayAlert`, `FlightDelaySeverity`, `FlightDelayType`, `FlightDelaySource`, or `AirportRegion` from `@/types`. If any remain, fix the import first.

**Step 3: Verify no remaining references to legacy files.**

Grep the entire codebase for:
- `faa-status` (the legacy API path) -- should have zero matches in `src/` and `api/` (only allowed in `.planning/` docs)
- `from '@/services/flights'` -- should have zero matches
- `AirportDelayAlert` from `@/types` -- should have zero matches
- `FlightDelaySeverity` from `@/types` -- should have zero matches
- `FlightDelayType` from `@/types` -- should have zero matches

If any references remain, fix them.

**Step 4: Rebuild sidecar and type check.**

Run `npm run build:sidecar-sebuf` to rebuild (ensures no dangling references in the sidecar bundle).
Run `npx tsc --noEmit` to confirm zero errors.
Run `npm run build` to confirm the full Vite build succeeds.
  </action>
  <verify>
`api/faa-status.js` does not exist. `npx tsc --noEmit` passes. `npm run build` succeeds. No grep matches for `AirportDelayAlert` in `src/types/index.ts`. No grep matches for `FlightDelaySeverity`, `FlightDelayType`, `FlightDelaySource` in `src/types/index.ts`. `MonitoredAirport` still exists in `src/types/index.ts` with inlined region type. No grep matches for `from '@/services/flights'` anywhere.
  </verify>
  <done>
Legacy FAA endpoint deleted. Dead aviation types (FlightDelaySource, FlightDelaySeverity, FlightDelayType, AirportRegion, AirportDelayAlert) removed from src/types/index.ts. MonitoredAirport preserved with inlined region type. No dangling references. Full build passes. Aviation domain is fully migrated to sebuf.
  </done>
</task>

</tasks>

<verification>
1. `src/services/aviation/index.ts` exports `fetchFlightDelays` and `AirportDelayAlert` type (old `src/services/flights.ts` deleted)
2. `src/services/index.ts` has `export * from './aviation'` (not `./flights`)
3. `src/App.ts` imports `fetchFlightDelays` from `@/services` barrel -- works via updated barrel
4. `src/components/Map.ts` imports `AirportDelayAlert` from `@/services/aviation` (not `@/types`)
5. `src/components/DeckGLMap.ts` imports `AirportDelayAlert` from `@/services/aviation` (not `@/types`)
6. `src/components/MapContainer.ts` imports `AirportDelayAlert` from `@/services/aviation` (not `@/types`)
7. `src/components/MapPopup.ts` imports `AirportDelayAlert` from `@/services/aviation` (not `@/types`)
8. `src/e2e/map-harness.ts` imports `AirportDelayAlert` from `@/services/aviation` (not `@/types`)
9. `api/faa-status.js` is deleted
10. `src/services/flights.ts` is deleted
11. `src/types/index.ts` no longer contains `FlightDelaySource`, `FlightDelaySeverity`, `FlightDelayType`, `AirportRegion`, or `AirportDelayAlert`
12. `src/types/index.ts` still contains `MonitoredAirport` with inlined region type
13. `npx tsc --noEmit` passes with zero errors
14. `npm run build` succeeds
15. Zero grep matches for `AirportDelayAlert` from `@/types` across codebase
16. Zero grep matches for `from '@/services/flights'` across codebase
</verification>

<success_criteria>
All aviation/flight delay data flows through the AviationServiceClient -> sebuf gateway -> aviation handler pipeline. The aviation service module maps proto shapes (proto enum strings to short-form, GeoCoordinates to flat lat/lon, epoch-ms to Date) to legacy-compatible consumer shapes. Circuit breaker preserved for upstream failure protection. All 5 component consumers + e2e harness use the new import path. Barrel export updated. Legacy endpoint, legacy service, and dead types are deleted. MonitoredAirport preserved for shared config. Full build passes.
</success_criteria>

<output>
After completion, create `.planning/phases/2H-aviation-migration/2H-02-SUMMARY.md`
</output>
