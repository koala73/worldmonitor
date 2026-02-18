---
phase: 2E-climate-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/climate/v1/handler.ts
  - api/[[...path]].ts
autonomous: true
requirements: [DOMAIN-01, SERVER-02]

must_haves:
  truths:
    - "Handler fetches all 15 monitored zones from Open-Meteo Archive API in parallel"
    - "Handler computes 30-day baseline comparison (last 7 days vs preceding baseline)"
    - "Handler classifies severity (normal/moderate/extreme) and type (warm/cold/wet/dry/mixed) matching legacy logic exactly"
    - "Handler filters nulls from daily arrays and skips zones with fewer than 14 data points"
    - "Handler rounds tempDelta and precipDelta to 1 decimal place"
    - "Handler maps results to proto ClimateAnomaly objects with correct enum values and GeoCoordinates"
    - "POST /api/climate/v1/list-climate-anomalies is routable through the gateway"
    - "Sidecar bundle compiles with climate routes included"
  artifacts:
    - path: "api/server/worldmonitor/climate/v1/handler.ts"
      provides: "ClimateServiceHandler implementation"
      exports: ["climateHandler"]
    - path: "api/[[...path]].ts"
      provides: "Gateway with climate routes mounted"
      contains: "createClimateServiceRoutes"
  key_links:
    - from: "api/server/worldmonitor/climate/v1/handler.ts"
      to: "src/generated/server/worldmonitor/climate/v1/service_server.ts"
      via: "implements ClimateServiceHandler interface"
      pattern: "ClimateServiceHandler"
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/climate/v1/handler.ts"
      via: "imports climateHandler and mounts routes"
      pattern: "climateHandler"
---

<objective>
Implement the ClimateService server-side: create the handler that fetches 15 monitored zones from the Open-Meteo Archive API in parallel, computes 30-day baseline comparisons, classifies severity and type, and returns proto-typed ClimateAnomaly responses. Wire it into the catch-all gateway and rebuild the sidecar bundle.

Purpose: Establishes the backend for climate anomaly detection, validating the compute-heavy handler pattern (baseline comparison, multi-zone parallel fetch, classification logic) that differs from simple proxy handlers.
Output: Working POST /api/climate/v1/list-climate-anomalies endpoint returning proto-typed climate anomalies from all 15 monitored zones.
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

@api/server/worldmonitor/seismology/v1/handler.ts
@api/server/worldmonitor/wildfire/v1/handler.ts
@api/[[...path]].ts
@proto/worldmonitor/climate/v1/climate_anomaly.proto
@proto/worldmonitor/climate/v1/service.proto
@proto/worldmonitor/climate/v1/list_climate_anomalies.proto
@src/generated/server/worldmonitor/climate/v1/service_server.ts
@api/climate-anomalies.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement the climate handler with 15-zone monitoring and baseline comparison</name>
  <files>
    api/server/worldmonitor/climate/v1/handler.ts
  </files>
  <action>
**Step 1: Create `api/server/worldmonitor/climate/v1/handler.ts`.**

Follow the handler pattern established by seismology (`api/server/worldmonitor/seismology/v1/handler.ts`) and wildfire (`api/server/worldmonitor/wildfire/v1/handler.ts`) handlers. No proto changes are needed -- the ClimateAnomaly message already has all required fields.

Import types from the generated server file:
```typescript
import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateAnomaliesRequest,
  ListClimateAnomaliesResponse,
  AnomalySeverity,
  AnomalyType,
  ClimateAnomaly,
} from '../../../../../src/generated/server/worldmonitor/climate/v1/service_server';
```

Export `climateHandler` as a named const implementing `ClimateServiceHandler`.

**Step 2: Define the 15 monitored zones.**

Create a `ZONES` array with objects `{ name: string, lat: number, lon: number }`:

| Zone | Latitude | Longitude |
|------|----------|-----------|
| Ukraine | 48.4 | 31.2 |
| Middle East | 33.0 | 44.0 |
| Sahel | 14.0 | 0.0 |
| Horn of Africa | 8.0 | 42.0 |
| South Asia | 25.0 | 78.0 |
| California | 36.8 | -119.4 |
| Amazon | -3.4 | -60.0 |
| Australia | -25.0 | 134.0 |
| Mediterranean | 38.0 | 20.0 |
| Taiwan Strait | 24.0 | 120.0 |
| Myanmar | 19.8 | 96.7 |
| Central Africa | 4.0 | 22.0 |
| Southern Africa | -25.0 | 28.0 |
| Central Asia | 42.0 | 65.0 |
| Caribbean | 19.0 | -72.0 |

These must match the legacy `api/climate-anomalies.js` zone list exactly.

**Step 3: Implement `listClimateAnomalies` handler method.**

The handler must:

1. **Compute date range**: `endDate` = today (YYYY-MM-DD), `startDate` = 30 days ago (YYYY-MM-DD). Use `new Date()` for today, subtract 30 days: `new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)`. Format both as `YYYY-MM-DD` using `.toISOString().slice(0, 10)`.

2. **Fetch all 15 zones in parallel** using `Promise.allSettled`. For each zone, call a `fetchZone(zone, startDate, endDate)` helper (see Step 4).

3. **Collect results**: Filter `Promise.allSettled` results for `status === 'fulfilled'` and non-null values. Log rejected promises to `console.error` with `[CLIMATE]` prefix. Flatten into `anomalies: ClimateAnomaly[]`.

4. **Return**: `{ anomalies, pagination: undefined }`.

**Step 4: Implement `fetchZone` helper.**

`async function fetchZone(zone: { name: string; lat: number; lon: number }, startDate: string, endDate: string): Promise<ClimateAnomaly | null>`

1. **Build URL**: `https://archive-api.open-meteo.com/v1/archive?latitude=${zone.lat}&longitude=${zone.lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean,precipitation_sum&timezone=UTC`

2. **Fetch**: `const response = await fetch(url);` No API key needed (Open-Meteo is free). Check `response.ok`, throw if not.

3. **Parse JSON**: `const data = await response.json();` Expected shape:
   ```
   {
     daily: {
       temperature_2m_mean: (number | null)[],
       precipitation_sum: (number | null)[]
     }
   }
   ```

4. **Filter nulls from both arrays**: Create paired arrays of valid (temp, precip) data points where BOTH temp and precip are non-null for the same index:
   ```typescript
   const temps: number[] = [];
   const precips: number[] = [];
   const rawTemps = data.daily?.temperature_2m_mean ?? [];
   const rawPrecips = data.daily?.precipitation_sum ?? [];
   for (let i = 0; i < rawTemps.length; i++) {
     if (rawTemps[i] != null && rawPrecips[i] != null) {
       temps.push(rawTemps[i]!);
       precips.push(rawPrecips[i]!);
     }
   }
   ```

5. **Minimum data check**: If `temps.length < 14`, return `null` (insufficient data for this zone).

6. **Compute baseline comparison**: Split valid data into "recent" (last 7 entries) and "baseline" (everything before):
   ```typescript
   const recentTemps = temps.slice(-7);
   const baselineTemps = temps.slice(0, -7);
   const recentPrecips = precips.slice(-7);
   const baselinePrecips = precips.slice(0, -7);
   ```
   - Compute averages for each set (sum / length)
   - `tempDelta = recentTempAvg - baselineTempAvg` (rounded to 1 decimal: `Math.round(tempDelta * 10) / 10`)
   - `precipDelta = recentPrecipAvg - baselinePrecipAvg` (rounded to 1 decimal: `Math.round(precipDelta * 10) / 10`)

7. **Build period string**: `${startDate} to ${endDate}`

8. **Return proto ClimateAnomaly**:
   ```typescript
   return {
     zone: zone.name,
     location: { latitude: zone.lat, longitude: zone.lon },
     tempDelta,
     precipDelta,
     severity: classifySeverity(tempDelta, precipDelta),
     type: classifyType(tempDelta, precipDelta),
     period: `${startDate} to ${endDate}`,
   };
   ```

**Step 5: Implement `classifySeverity` helper.**

Must match legacy logic exactly:
```typescript
function classifySeverity(tempDelta: number, precipDelta: number): AnomalySeverity {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= 5 || absPrecip >= 80) return 'ANOMALY_SEVERITY_EXTREME';
  if (absTemp >= 3 || absPrecip >= 40) return 'ANOMALY_SEVERITY_MODERATE';
  return 'ANOMALY_SEVERITY_NORMAL';
}
```

**Step 6: Implement `classifyType` helper.**

Must match legacy logic exactly:
```typescript
function classifyType(tempDelta: number, precipDelta: number): AnomalyType {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= absPrecip / 20) {
    if (tempDelta > 0 && precipDelta < -20) return 'ANOMALY_TYPE_MIXED';
    if (tempDelta > 3) return 'ANOMALY_TYPE_WARM';
    if (tempDelta < -3) return 'ANOMALY_TYPE_COLD';
  }
  if (precipDelta > 40) return 'ANOMALY_TYPE_WET';
  if (precipDelta < -40) return 'ANOMALY_TYPE_DRY';
  if (tempDelta > 0) return 'ANOMALY_TYPE_WARM';
  return 'ANOMALY_TYPE_COLD';
}
```

**Step 7: Verify the handler compiles.**

Run `npx tsc --noEmit` and confirm zero errors. Read the generated server file first to verify exact type names for imports.
  </action>
  <verify>
Run `npx tsc --noEmit` and confirm zero errors. Verify the handler file exists at `api/server/worldmonitor/climate/v1/handler.ts` and exports `climateHandler`.
  </verify>
  <done>
Handler file exists at `api/server/worldmonitor/climate/v1/handler.ts`, exports `climateHandler` implementing `ClimateServiceHandler`. Contains 15 hardcoded zones, parallel fetch via Promise.allSettled, null filtering, minimum 14-point data check, 30-day baseline comparison with 7-day recent window, severity/type classification matching legacy thresholds, 1-decimal rounding, and proto ClimateAnomaly mapping. Type-checks cleanly.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire climate routes into gateway and rebuild sidecar</name>
  <files>
    api/[[...path]].ts
  </files>
  <action>
**Step 1: Mount climate routes in the catch-all gateway.**

In `api/[[...path]].ts`:
1. Add import for the climate route creator alongside the existing seismology and wildfire imports:
   ```typescript
   import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server';
   import { climateHandler } from './server/worldmonitor/climate/v1/handler';
   ```
2. Add climate routes to `allRoutes`:
   ```typescript
   ...createClimateServiceRoutes(climateHandler, serverOptions),
   ```
3. The same `serverOptions` const with `onError: mapErrorToResponse` works for climate since it is service-agnostic.

**Step 2: Rebuild the sidecar sebuf bundle.**

Run `npm run build:sidecar-sebuf` to rebuild the Tauri sidecar bundle with the new climate routes included. This must succeed without errors.

**Step 3: Type check the full project.**

Run `npx tsc --noEmit` to verify no type errors were introduced.
  </action>
  <verify>
Run `npx tsc --noEmit` -- zero errors. Run `npm run build:sidecar-sebuf` -- succeeds. Grep `api/[[...path]].ts` for `createClimateServiceRoutes` to confirm it is wired in.
  </verify>
  <done>
Gateway mounts climate routes alongside seismology and wildfire. Sidecar bundle compiles with climate included. Full type check passes.
  </done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` passes with zero errors
2. `npm run build:sidecar-sebuf` succeeds
3. `api/server/worldmonitor/climate/v1/handler.ts` exists and exports `climateHandler`
4. `api/[[...path]].ts` includes `createClimateServiceRoutes`
5. Handler contains 15 zone definitions matching legacy exactly
6. Handler has `classifySeverity` and `classifyType` with correct thresholds
</verification>

<success_criteria>
POST /api/climate/v1/list-climate-anomalies is a routable endpoint that fetches climate data from all 15 monitored zones via Open-Meteo Archive API, computes 30-day baseline comparisons, classifies severity and type, and returns proto-typed ClimateAnomaly objects. Zones with insufficient data (< 14 points) are skipped. All deltas are rounded to 1 decimal place.
</success_criteria>

<output>
After completion, create `.planning/phases/2E-climate-migration/2E-01-SUMMARY.md`
</output>
