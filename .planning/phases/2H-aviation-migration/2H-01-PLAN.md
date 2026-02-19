---
phase: 2H-aviation-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/aviation/v1/handler.ts
  - api/[[...path]].ts
  - package.json
autonomous: true
requirements: [DOMAIN-08, SERVER-02]

must_haves:
  truths:
    - "Handler installs and uses fast-xml-parser (not DOMParser) to parse FAA NASSTATUS XML server-side"
    - "Handler fetches from https://nasstatus.faa.gov/api/airport-status-information and parses Ground_Delay, Ground_Stop, Arrival_Departure_Delay, and Airport_Closure categories"
    - "Handler uses isArray option in fast-xml-parser config to force array wrapping for Ground_Delay, Ground_Stop, Delay, and Airport element names"
    - "Handler enriches FAA delay data with MONITORED_AIRPORTS config (lat, lon, name, city, country, icao, region) for US airports"
    - "Handler generates simulated delays for non-US airports using rush-hour and busy-airport weighted probability"
    - "Handler determines severity via DELAY_SEVERITY_THRESHOLDS (minor/moderate/major/severe thresholds)"
    - "Handler maps short-form strings to proto enum strings (e.g. 'ground_stop' -> 'FLIGHT_DELAY_TYPE_GROUND_STOP', 'severe' -> 'FLIGHT_DELAY_SEVERITY_SEVERE')"
    - "Handler wraps flat lat/lon into GeoCoordinates { latitude, longitude } for proto response"
    - "Handler returns graceful empty alerts array on ANY upstream failure"
    - "POST /api/aviation/v1/list-airport-delays is routable through the gateway"
    - "Sidecar bundle compiles with aviation routes included"
  artifacts:
    - path: "api/server/worldmonitor/aviation/v1/handler.ts"
      provides: "AviationServiceHandler implementation proxying FAA NASSTATUS XML API with XML parsing, airport enrichment, simulated delays, and severity classification"
      exports: ["aviationHandler"]
    - path: "api/[[...path]].ts"
      provides: "Gateway with aviation routes mounted alongside seismology, wildfire, climate, prediction, displacement"
      contains: "createAviationServiceRoutes"
  key_links:
    - from: "api/server/worldmonitor/aviation/v1/handler.ts"
      to: "src/generated/server/worldmonitor/aviation/v1/service_server.ts"
      via: "implements AviationServiceHandler interface"
      pattern: "AviationServiceHandler"
    - from: "api/server/worldmonitor/aviation/v1/handler.ts"
      to: "src/config/airports.ts"
      via: "imports MONITORED_AIRPORTS, FAA_AIRPORTS, DELAY_SEVERITY_THRESHOLDS via relative path"
      pattern: "MONITORED_AIRPORTS"
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/aviation/v1/handler.ts"
      via: "imports aviationHandler and mounts routes"
      pattern: "aviationHandler"
---

<objective>
Implement the AviationServiceHandler that fetches FAA NASSTATUS XML, parses it server-side with fast-xml-parser, enriches US airports with MONITORED_AIRPORTS metadata, generates simulated delays for non-US airports, classifies severity, and returns proto-typed AirportDelayAlert records. Wire it into the catch-all gateway and rebuild the sidecar bundle.

Purpose: This handler performs a fundamental data flow inversion. The legacy architecture proxies raw XML to the browser (`api/faa-status.js`) where `DOMParser` parses it client-side (`src/services/flights.ts`). The new handler does ALL processing server-side: XML fetch, parse, airport enrichment, simulated delay generation, severity classification, and proto enum mapping. The client receives fully processed JSON. The only new technical challenge is XML parsing in edge runtime -- solved by fast-xml-parser (pure JS, no native deps).

Output: Working POST /api/aviation/v1/list-airport-delays endpoint returning proto-typed AirportDelayAlert[] with FAA real delays and simulated non-US delays.
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

# Reference: existing handler patterns
@api/server/worldmonitor/displacement/v1/handler.ts
@api/server/worldmonitor/climate/v1/handler.ts

# Generated server interface (handler must implement this)
@src/generated/server/worldmonitor/aviation/v1/service_server.ts

# Legacy service being replaced (source of truth for parsing logic)
@src/services/flights.ts

# Legacy endpoint being replaced
@api/faa-status.js

# Airport config imported by handler via relative path
@src/config/airports.ts

# Gateway to wire into
@api/[[...path]].ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Install fast-xml-parser and implement aviation handler with XML parsing, airport enrichment, simulated delays, and severity classification</name>
  <files>
    api/server/worldmonitor/aviation/v1/handler.ts
    package.json
  </files>
  <action>
**Step 0: Install fast-xml-parser.**

Run `npm install fast-xml-parser`. This is a pure-JS XML parser with zero native dependencies, compatible with edge runtime. Verify it appears in `package.json` dependencies.

**Step 1: Create `api/server/worldmonitor/aviation/v1/handler.ts`.**

Import types from the generated server file via relative path:
```typescript
import { XMLParser } from 'fast-xml-parser';
import type {
  AviationServiceHandler,
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
  GeoCoordinates,
  FlightDelayType,
  FlightDelaySeverity,
  FlightDelaySource,
  AirportRegion,
} from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
```

Import airport config via relative path (esbuild resolves for sidecar):
```typescript
import { MONITORED_AIRPORTS, FAA_AIRPORTS, DELAY_SEVERITY_THRESHOLDS } from '../../../../../src/config/airports';
```

Export `aviationHandler` as a named const implementing `AviationServiceHandler`.

**Step 2: Configure the XMLParser instance.**

```typescript
const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (_name: string, jpath: string) => {
    // Force arrays for list items regardless of count to prevent single-item-as-object bug
    return /\.(Ground_Delay|Ground_Stop|Delay|Airport)$/.test(jpath);
  },
});
```

CRITICAL: The `isArray` option prevents the pitfall where fast-xml-parser returns a single object instead of an array when there's only one element. Without this, `.forEach()` calls would fail with single delays.

**Step 3: Implement `parseDelayTypeFromReason` helper.**

Port from legacy `src/services/flights.ts` lines 33-41:
```typescript
function parseDelayTypeFromReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('ground stop')) return 'ground_stop';
  if (r.includes('ground delay') || r.includes('gdp')) return 'ground_delay';
  if (r.includes('departure')) return 'departure_delay';
  if (r.includes('arrival')) return 'arrival_delay';
  if (r.includes('clos')) return 'ground_stop';
  return 'general';
}
```

**Step 4: Implement `parseFaaXml` function.**

Port the parsing logic from legacy `src/services/flights.ts` `parseXMLDelays()` (lines 43-116), but using fast-xml-parser object access instead of DOMParser CSS selectors:

```typescript
interface FAADelayInfo {
  airport: string;
  reason: string;
  avgDelay: number;
  type: string;
}

function parseFaaXml(xml: string): Map<string, FAADelayInfo> {
  const delays = new Map<string, FAADelayInfo>();
  const parsed = xmlParser.parse(xml);
  const root = parsed?.AIRPORT_STATUS_INFORMATION;
  if (!root) return delays;

  // Delay_type may be array or single object
  const delayTypes = Array.isArray(root.Delay_type)
    ? root.Delay_type
    : root.Delay_type ? [root.Delay_type] : [];

  for (const dt of delayTypes) {
    // Ground Delays
    if (dt.Ground_Delay_List?.Ground_Delay) {
      for (const gd of dt.Ground_Delay_List.Ground_Delay) {
        if (gd.ARPT) {
          delays.set(gd.ARPT, {
            airport: gd.ARPT,
            reason: gd.Reason || 'Ground delay',
            avgDelay: gd.Avg ? parseInt(gd.Avg, 10) : 30,
            type: 'ground_delay',
          });
        }
      }
    }
    // Ground Stops
    if (dt.Ground_Stop_List?.Ground_Stop) {
      for (const gs of dt.Ground_Stop_List.Ground_Stop) {
        if (gs.ARPT) {
          delays.set(gs.ARPT, {
            airport: gs.ARPT,
            reason: gs.Reason || 'Ground stop',
            avgDelay: 60,
            type: 'ground_stop',
          });
        }
      }
    }
    // Arrival/Departure Delays
    if (dt.Arrival_Departure_Delay_List?.Delay) {
      for (const d of dt.Arrival_Departure_Delay_List.Delay) {
        if (d.ARPT) {
          const min = parseInt(d.Arrival_Delay?.Min || d.Departure_Delay?.Min || '15', 10);
          const max = parseInt(d.Arrival_Delay?.Max || d.Departure_Delay?.Max || '30', 10);
          const existing = delays.get(d.ARPT);
          // Don't downgrade ground_stop to lesser delay
          if (!existing || existing.type !== 'ground_stop') {
            delays.set(d.ARPT, {
              airport: d.ARPT,
              reason: d.Reason || 'Delays',
              avgDelay: Math.round((min + max) / 2),
              type: parseDelayTypeFromReason(d.Reason || ''),
            });
          }
        }
      }
    }
    // Airport Closures
    if (dt.Airport_Closure_List?.Airport) {
      for (const ac of dt.Airport_Closure_List.Airport) {
        if (ac.ARPT && FAA_AIRPORTS.includes(ac.ARPT)) {
          delays.set(ac.ARPT, {
            airport: ac.ARPT,
            reason: 'Airport closure',
            avgDelay: 120,
            type: 'ground_stop',
          });
        }
      }
    }
  }

  return delays;
}
```

**Step 5: Implement proto enum mapping functions.**

Map short-form strings (used in internal logic) to proto enum string literals (required by generated handler interface):

```typescript
function toProtoDelayType(t: string): FlightDelayType {
  const map: Record<string, FlightDelayType> = {
    ground_stop: 'FLIGHT_DELAY_TYPE_GROUND_STOP',
    ground_delay: 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
    departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY',
    arrival_delay: 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY',
    general: 'FLIGHT_DELAY_TYPE_GENERAL',
  };
  return map[t] || 'FLIGHT_DELAY_TYPE_GENERAL';
}

function toProtoSeverity(s: string): FlightDelaySeverity {
  const map: Record<string, FlightDelaySeverity> = {
    normal: 'FLIGHT_DELAY_SEVERITY_NORMAL',
    minor: 'FLIGHT_DELAY_SEVERITY_MINOR',
    moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE',
    major: 'FLIGHT_DELAY_SEVERITY_MAJOR',
    severe: 'FLIGHT_DELAY_SEVERITY_SEVERE',
  };
  return map[s] || 'FLIGHT_DELAY_SEVERITY_NORMAL';
}

function toProtoRegion(r: string): AirportRegion {
  const map: Record<string, AirportRegion> = {
    americas: 'AIRPORT_REGION_AMERICAS',
    europe: 'AIRPORT_REGION_EUROPE',
    apac: 'AIRPORT_REGION_APAC',
    mena: 'AIRPORT_REGION_MENA',
    africa: 'AIRPORT_REGION_AFRICA',
  };
  return map[r] || 'AIRPORT_REGION_UNSPECIFIED';
}

function toProtoSource(s: string): FlightDelaySource {
  const map: Record<string, FlightDelaySource> = {
    faa: 'FLIGHT_DELAY_SOURCE_FAA',
    eurocontrol: 'FLIGHT_DELAY_SOURCE_EUROCONTROL',
    computed: 'FLIGHT_DELAY_SOURCE_COMPUTED',
  };
  return map[s] || 'FLIGHT_DELAY_SOURCE_COMPUTED';
}
```

**Step 6: Implement `determineSeverity` function.**

Port from legacy `src/services/flights.ts` lines 16-31, using the same DELAY_SEVERITY_THRESHOLDS:
```typescript
function determineSeverity(avgDelayMinutes: number, delayedPct?: number): string {
  const t = DELAY_SEVERITY_THRESHOLDS;
  if (avgDelayMinutes >= t.severe.avgDelayMinutes || (delayedPct && delayedPct >= t.severe.delayedPct)) return 'severe';
  if (avgDelayMinutes >= t.major.avgDelayMinutes || (delayedPct && delayedPct >= t.major.delayedPct)) return 'major';
  if (avgDelayMinutes >= t.moderate.avgDelayMinutes || (delayedPct && delayedPct >= t.moderate.delayedPct)) return 'moderate';
  if (avgDelayMinutes >= t.minor.avgDelayMinutes || (delayedPct && delayedPct >= t.minor.delayedPct)) return 'minor';
  return 'normal';
}
```

**Step 7: Implement `generateSimulatedDelay` function.**

Port from legacy `src/services/flights.ts` lines 147-209. This generates simulated delays for non-US airports based on rush-hour timing and busy-airport weighting. The function returns a proto-shaped `AirportDelayAlert` (with GeoCoordinates wrapping and proto enum strings):

```typescript
function generateSimulatedDelay(airport: typeof MONITORED_AIRPORTS[number]): AirportDelayAlert | null {
  const hour = new Date().getUTCHours();
  const isRushHour = (hour >= 6 && hour <= 10) || (hour >= 16 && hour <= 20);
  const busyAirports = ['LHR', 'CDG', 'FRA', 'JFK', 'LAX', 'ORD', 'PEK', 'HND', 'DXB', 'SIN'];
  const isBusy = busyAirports.includes(airport.iata);
  const random = Math.random();
  const delayChance = isRushHour ? 0.35 : 0.15;
  const hasDelay = random < (isBusy ? delayChance * 1.5 : delayChance);

  if (!hasDelay) return null;

  let avgDelayMinutes = 0;
  let delayType = 'general';
  let reason = 'Minor delays';

  const severityRoll = Math.random();
  if (severityRoll < 0.05) {
    avgDelayMinutes = 60 + Math.floor(Math.random() * 60);
    delayType = Math.random() < 0.3 ? 'ground_stop' : 'ground_delay';
    reason = Math.random() < 0.5 ? 'Weather conditions' : 'Air traffic volume';
  } else if (severityRoll < 0.2) {
    avgDelayMinutes = 45 + Math.floor(Math.random() * 20);
    delayType = 'ground_delay';
    reason = Math.random() < 0.5 ? 'Weather' : 'High traffic volume';
  } else if (severityRoll < 0.5) {
    avgDelayMinutes = 25 + Math.floor(Math.random() * 20);
    delayType = Math.random() < 0.5 ? 'departure_delay' : 'arrival_delay';
    reason = 'Congestion';
  } else {
    avgDelayMinutes = 15 + Math.floor(Math.random() * 15);
    delayType = 'general';
    reason = 'Minor delays';
  }

  const severity = determineSeverity(avgDelayMinutes);
  // Only return if severity is not normal (matching legacy behavior: filter out normal)
  if (severity === 'normal') return null;

  return {
    id: `sim-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    location: { latitude: airport.lat, longitude: airport.lon },
    region: toProtoRegion(airport.region),
    delayType: toProtoDelayType(delayType),
    severity: toProtoSeverity(severity),
    avgDelayMinutes,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason,
    source: toProtoSource('computed'),
    updatedAt: Date.now(),
  };
}
```

**Step 8: Implement the `listAirportDelays` handler method.**

This is the main handler orchestrating: FAA XML fetch + parse, US airport enrichment, simulated non-US delays, and proto response assembly:

```typescript
export const aviationHandler: AviationServiceHandler = {
  async listAirportDelays(
    _ctx: ServerContext,
    _req: ListAirportDelaysRequest,
  ): Promise<ListAirportDelaysResponse> {
    try {
      const alerts: AirportDelayAlert[] = [];

      // 1. Fetch and parse FAA XML
      const faaResponse = await fetch(FAA_URL, {
        headers: { Accept: 'application/xml' },
      });

      let faaDelays = new Map<string, FAADelayInfo>();
      if (faaResponse.ok) {
        const xml = await faaResponse.text();
        faaDelays = parseFaaXml(xml);
      }

      // 2. Enrich US airports with FAA delay data
      for (const iata of FAA_AIRPORTS) {
        const airport = MONITORED_AIRPORTS.find((a) => a.iata === iata);
        if (!airport) continue;

        const faaDelay = faaDelays.get(iata);
        if (faaDelay) {
          alerts.push({
            id: `faa-${iata}`,
            iata,
            icao: airport.icao,
            name: airport.name,
            city: airport.city,
            country: airport.country,
            location: { latitude: airport.lat, longitude: airport.lon },
            region: toProtoRegion(airport.region),
            delayType: toProtoDelayType(faaDelay.type),
            severity: toProtoSeverity(determineSeverity(faaDelay.avgDelay)),
            avgDelayMinutes: faaDelay.avgDelay,
            delayedFlightsPct: 0,
            cancelledFlights: 0,
            totalFlights: 0,
            reason: faaDelay.reason,
            source: toProtoSource('faa'),
            updatedAt: Date.now(),
          });
        }
      }

      // 3. Generate simulated delays for non-US airports
      const nonUsAirports = MONITORED_AIRPORTS.filter((a) => a.country !== 'USA');
      for (const airport of nonUsAirports) {
        const simulated = generateSimulatedDelay(airport);
        if (simulated) {
          alerts.push(simulated);
        }
      }

      return { alerts };
    } catch {
      // Graceful empty response on ANY failure (established pattern from 2F-01)
      return { alerts: [] };
    }
  },
};
```

**Step 9: Verify the handler compiles.**

Read the generated server file first to verify exact type names. Run `npx tsc -p tsconfig.api.json --noEmit` and confirm zero errors.
  </action>
  <verify>
Run `npx tsc -p tsconfig.api.json --noEmit` -- zero errors. Verify `api/server/worldmonitor/aviation/v1/handler.ts` exists and exports `aviationHandler`. Verify `fast-xml-parser` appears in `package.json` dependencies.
  </verify>
  <done>
Handler file exists at `api/server/worldmonitor/aviation/v1/handler.ts`, exports `aviationHandler` implementing `AviationServiceHandler`. Uses fast-xml-parser with isArray config to parse FAA NASSTATUS XML. Enriches US airports with MONITORED_AIRPORTS metadata. Generates simulated delays for 60+ non-US airports with rush-hour weighting. Maps short-form strings to proto enums. Wraps flat lat/lon to GeoCoordinates. Returns graceful empty alerts on failure. Type-checks cleanly.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire aviation routes into gateway and rebuild sidecar</name>
  <files>
    api/[[...path]].ts
  </files>
  <action>
**Step 1: Mount aviation routes in the catch-all gateway.**

In `api/[[...path]].ts`:
1. Add import for the aviation route creator after the existing displacement imports:
   ```typescript
   import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server';
   import { aviationHandler } from './server/worldmonitor/aviation/v1/handler';
   ```
2. Add aviation routes to `allRoutes` array (after the displacement line):
   ```typescript
   ...createAviationServiceRoutes(aviationHandler, serverOptions),
   ```

**Step 2: Rebuild the sidecar sebuf bundle.**

Run `npm run build:sidecar-sebuf` to rebuild the Tauri sidecar bundle with the new aviation routes included. This must succeed without errors.

**Step 3: Type check the full API layer.**

Run `npx tsc -p tsconfig.api.json --noEmit` to verify no type errors were introduced.
  </action>
  <verify>
Run `npx tsc -p tsconfig.api.json --noEmit` -- zero errors. Run `npm run build:sidecar-sebuf` -- succeeds. Grep `api/[[...path]].ts` for `createAviationServiceRoutes` to confirm it is wired in.
  </verify>
  <done>
Gateway mounts aviation routes alongside seismology, wildfire, climate, prediction, and displacement. Sidecar bundle compiles with aviation included. Full API type check passes.
  </done>
</task>

</tasks>

<verification>
1. `npx tsc -p tsconfig.api.json --noEmit` passes with zero errors
2. `npm run build:sidecar-sebuf` succeeds
3. `api/server/worldmonitor/aviation/v1/handler.ts` exists and exports `aviationHandler`
4. `api/[[...path]].ts` includes `createAviationServiceRoutes`
5. `fast-xml-parser` is in `package.json` dependencies
6. Handler uses `XMLParser` with `isArray` option for array safety
7. Handler imports `MONITORED_AIRPORTS`, `FAA_AIRPORTS`, `DELAY_SEVERITY_THRESHOLDS` from `src/config/airports` via relative path
8. Handler parses all 4 FAA delay categories: Ground_Delay, Ground_Stop, Arrival_Departure_Delay, Airport_Closure
9. Handler enriches US airports with MONITORED_AIRPORTS metadata (lat, lon, name, icao, etc.)
10. Handler generates simulated delays for non-US airports with rush-hour/busy-airport weighting
11. Handler maps short-form strings to proto enum strings (FlightDelayType, FlightDelaySeverity, AirportRegion, FlightDelaySource)
12. Handler wraps flat lat/lon into GeoCoordinates { latitude, longitude }
13. Handler returns graceful empty alerts array on failure
</verification>

<success_criteria>
POST /api/aviation/v1/list-airport-delays is a routable endpoint that fetches FAA NASSTATUS XML, parses it server-side via fast-xml-parser, enriches US airports with MONITORED_AIRPORTS config, generates simulated delays for non-US airports, classifies severity via DELAY_SEVERITY_THRESHOLDS, maps all values to proto enum strings, wraps coordinates in GeoCoordinates, and returns proto-typed AirportDelayAlert[]. Graceful degradation returns empty alerts on any upstream failure.
</success_criteria>

<output>
After completion, create `.planning/phases/2H-aviation-migration/2H-01-SUMMARY.md`
</output>
