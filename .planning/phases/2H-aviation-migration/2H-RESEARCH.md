# Phase 2H: Aviation Migration - Research

**Researched:** 2026-02-19
**Domain:** Aviation/FAA domain migration to sebuf (handler + service module + consumer rewiring)
**Confidence:** HIGH

## Summary

Aviation is the 6th domain migration following the established 2-plan pattern from phases 2C-2G. The domain consists of a single RPC (`ListAirportDelays`) that fetches FAA NASSTATUS XML data, parses it server-side, enriches it with the `MONITORED_AIRPORTS` configuration (airport metadata, severity thresholds, simulated delays for non-US airports), and returns proto-typed `AirportDelayAlert` records.

The critical technical challenge is **XML parsing in edge runtime**. The legacy `src/services/flights.ts` uses `DOMParser` which is a browser API not available in Vercel Edge Runtime or Node.js server context. The legacy `api/faa-status.js` sidesteps this entirely by proxying raw XML to the browser where `DOMParser` is available. The new handler must parse XML server-side. The recommended approach is `fast-xml-parser` -- a pure-JS XML parser with zero native dependencies, compatible with edge runtime environments.

The data flow changes fundamentally: currently the browser fetches raw XML via `/api/faa-status` and parses it client-side in `src/services/flights.ts`. After migration, the handler at `/api/aviation/v1/list-airport-delays` will fetch, parse, enrich, and return structured JSON. The service module (port/adapter) becomes a thin client wrapper, and consumers receive `AirportDelayAlert[]` already processed.

**Primary recommendation:** Use `fast-xml-parser` (v5.x, pure JS, no DOM dependency) in the handler to parse FAA XML server-side. Move ALL data processing (XML parse, severity determination, simulated delays, airport enrichment) into the handler. The service module becomes a simple client wrapper with proto-to-legacy type mapping, following the displacement service module pattern exactly.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-08 | Military domain proto -- FAA airport status (HTTP-only RPCs) | Aviation handler implements `ListAirportDelays` RPC, parsing FAA NASSTATUS XML, enriching with MONITORED_AIRPORTS config, generating simulated delays for non-US airports |
| SERVER-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | Handler proxies `https://nasstatus.faa.gov/api/airport-status-information`, uses `fast-xml-parser` for XML-to-JSON, maps to proto `AirportDelayAlert` shape |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fast-xml-parser | 5.x (latest 5.3.6) | Parse FAA NASSTATUS XML to JS objects | Pure JS, no C/C++ deps, works in edge runtime, 3500+ npm dependents, actively maintained |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | The handler and service module use existing project infrastructure (generated server/client, circuit breaker, etc.) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| fast-xml-parser | Regex-based manual parsing | Fragile, error-prone, hard to maintain -- the XML structure has 4 different delay categories with varying schemas |
| fast-xml-parser | linkedom / jsdom | Both pull in DOM polyfills -- heavier, slower, unnecessary for simple XML-to-object conversion |
| fast-xml-parser | DOMParser (browser) | Not available in edge runtime; the whole point of migration is to move parsing server-side |

**Installation:**
```bash
npm install fast-xml-parser
```

## Architecture Patterns

### Recommended Project Structure
```
api/
  server/
    worldmonitor/
      aviation/
        v1/
          handler.ts          # Plan 01: AviationServiceHandler implementation
  [[...path]].ts              # Plan 01: Mount aviation routes
  faa-status.js               # Plan 02: DELETE (legacy XML proxy)

src/
  services/
    aviation/
      index.ts                # Plan 02: Port/adapter service module
    flights.ts                # Plan 02: DELETE (legacy service)
  config/
    airports.ts               # KEEP (shared config, used by handler + consumers)
  types/
    index.ts                  # Plan 02: Remove dead aviation types
```

### Pattern 1: Handler with Embedded Config Data
**What:** The handler must include the MONITORED_AIRPORTS data (80+ airports with lat/lon/region/country) and DELAY_SEVERITY_THRESHOLDS because it runs in the `api/` scope. The handler cannot use `@/config` path aliases.
**When to use:** When the handler needs static configuration data that currently lives in `src/config/`.
**Approach:** Import via relative path from handler to `src/config/airports.ts`. The esbuild sidecar bundler will resolve and inline it. For Vercel, the TypeScript handler in `api/server/` can use `../../../../../src/config/airports` relative imports, following the same pattern as the generated server imports.

```typescript
// api/server/worldmonitor/aviation/v1/handler.ts
import type {
  AviationServiceHandler,
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
} from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

// Config imports via relative path (esbuild resolves for sidecar)
import { MONITORED_AIRPORTS, FAA_AIRPORTS, DELAY_SEVERITY_THRESHOLDS } from '../../../../../src/config/airports';
```

**IMPORTANT CAVEAT:** The `src/config/airports.ts` imports `MonitoredAirport` from `@/types`. For the handler to import it via relative path, `tsconfig.json` path aliases must resolve at build time. Since the existing handlers all use relative imports to `src/generated/server/...` and those files import from `@/types` path alias equivalents, this pattern is already proven to work via esbuild bundling. The handler's relative import of `src/config/airports` follows the same resolution chain.

### Pattern 2: XML Parsing with fast-xml-parser
**What:** Parse FAA NASSTATUS XML into structured JS objects without DOM APIs.
**When to use:** Whenever XML must be parsed in edge runtime or Node.js server context.

```typescript
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => {
    // Force array wrapping for list elements (even when single item)
    return ['Ground_Delay', 'Ground_Stop', 'Delay', 'Airport'].includes(name);
  },
});

const parsed = parser.parse(xmlString);
```

**Key difference from DOMParser:** fast-xml-parser returns a plain JS object tree, not a DOM tree. Instead of `doc.querySelectorAll('Ground_Delay_List Ground_Delay')`, you access `parsed.AIRPORT_STATUS_INFORMATION.Delay_type[N].Ground_Delay_List.Ground_Delay`.

### Pattern 3: Proto Enum Mapping in Handler
**What:** The handler must map string-based legacy types (`'ground_stop'`, `'severe'`, etc.) to proto enum string literals (`"FLIGHT_DELAY_TYPE_GROUND_STOP"`, `"FLIGHT_DELAY_SEVERITY_SEVERE"`, etc.).
**When to use:** In every handler that converts internal logic values to proto-shaped responses.

```typescript
function toProtoDelayType(t: string): FlightDelayType {
  const map: Record<string, FlightDelayType> = {
    'ground_stop': 'FLIGHT_DELAY_TYPE_GROUND_STOP',
    'ground_delay': 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
    'departure_delay': 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY',
    'arrival_delay': 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY',
    'general': 'FLIGHT_DELAY_TYPE_GENERAL',
  };
  return map[t] || 'FLIGHT_DELAY_TYPE_GENERAL';
}
```

### Pattern 4: Service Module Port/Adapter (Plan 02)
**What:** The service module wraps the generated `AviationServiceClient`, maps proto types back to consumer-friendly types (flat lat/lon, string enums back to short-form), and re-exports consumer-facing types.
**When to use:** For every migrated domain -- established pattern from 2C-2G.

```typescript
// src/services/aviation/index.ts
import {
  AviationServiceClient,
  type ListAirportDelaysResponse as ProtoResponse,
  type AirportDelayAlert as ProtoAlert,
} from '@/generated/client/worldmonitor/aviation/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// Consumer-friendly types (matching legacy shape)
export interface AirportDelayAlert {
  id: string;
  iata: string;
  // ...flat lat/lon instead of GeoCoordinates
  lat: number;
  lon: number;
  // Short-form enums instead of proto enums
  severity: 'normal' | 'minor' | 'moderate' | 'major' | 'severe';
  delayType: 'ground_stop' | 'ground_delay' | 'departure_delay' | 'arrival_delay' | 'general';
  source: 'faa' | 'eurocontrol' | 'computed';
  // ...
}
```

### Anti-Patterns to Avoid
- **Importing `@/config` in handler files:** Use relative paths. The `@/` alias may not resolve in the `api/` scope during Vercel build.
- **Using `DOMParser` in handler:** Not available in edge runtime. Always use `fast-xml-parser`.
- **Keeping XML parsing client-side:** The whole point of the migration is server-side processing. The handler should return fully processed JSON.
- **Duplicating airport data:** The handler should import from `src/config/airports.ts` via relative path, NOT copy-paste the 80+ airport records.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| XML parsing | Regex-based XML extraction | `fast-xml-parser` | XML has 4 different delay category schemas, edge cases with optional elements, single-vs-multiple items. Regex is fragile and error-prone. |
| Circuit breaker | Custom retry/timeout logic | `createCircuitBreaker` from `@/utils` | Already established project pattern, handles all edge cases |
| Type mapping proto<->legacy | Inline ad-hoc conversion | Dedicated `toDisplay*` functions in service module | Consistent with displacement, seismology patterns |

**Key insight:** The XML parsing is the only genuinely new technical challenge. Everything else follows established patterns from prior migrations.

## Common Pitfalls

### Pitfall 1: fast-xml-parser Array Handling
**What goes wrong:** When the FAA XML has only one `Ground_Delay` or `Ground_Stop` element, fast-xml-parser returns it as a single object instead of an array. Code that iterates with `.forEach()` fails.
**Why it happens:** XML parsers cannot distinguish `<List><Item>one</Item></List>` (one item) from `<List><Item>one</Item><Item>two</Item></List>` (array) without schema knowledge.
**How to avoid:** Use the `isArray` option in the parser configuration to force array wrapping for all list element names (`Ground_Delay`, `Ground_Stop`, `Delay`, `Airport`).
**Warning signs:** Tests pass with sample XML containing multiple delays, but production fails when only one airport has a delay.

### Pitfall 2: XML Element Path Differences vs DOMParser
**What goes wrong:** The legacy code uses CSS-like selectors (`doc.querySelectorAll('Ground_Delay_List Ground_Delay')`). With fast-xml-parser, navigation is via object property access (`parsed.AIRPORT_STATUS_INFORMATION.Delay_type`), and the structure may have intermediate wrapper elements.
**Why it happens:** FAA NASSTATUS XML wraps delay categories in `<Delay_type>` elements with a `<Name>` child. Multiple `<Delay_type>` elements exist at the top level.
**How to avoid:** Iterate over `Delay_type` array entries, check the `Name` field to determine category, then access the appropriate sub-list.
**Warning signs:** Handler returns empty alerts even though FAA API returns data.

### Pitfall 3: Simulated Delays Belong in the Handler
**What goes wrong:** If simulated delays for non-US airports are left in the service module (client-side), they regenerate on every poll, causing the map to flicker as random delays appear/disappear.
**Why it happens:** Misunderstanding about where the logic boundary is. The handler processes ALL data (real + simulated) and returns a complete response.
**How to avoid:** Move `generateSimulatedDelay()` logic into the handler. The simulated delays are part of the "upstream API proxy" concept -- the handler enriches FAA data with simulated international data.
**Warning signs:** Map layer flickers, delays jump around on refresh.

### Pitfall 4: Proto Enum String Mapping Direction
**What goes wrong:** The handler returns `'moderate'` (legacy string) instead of `'FLIGHT_DELAY_SEVERITY_MODERATE'` (proto enum string). The generated server expects proto enum strings.
**Why it happens:** Copy-pasting logic from `src/services/flights.ts` which uses short-form strings.
**How to avoid:** Create explicit mapping functions (`toProtoSeverity`, `toProtoDelayType`, `toProtoRegion`, `toProtoSource`) in the handler. The service module does the reverse mapping.
**Warning signs:** TypeScript compilation error on handler return type; or runtime: client receives proto enum strings and renders them literally on screen.

### Pitfall 5: GeoCoordinates Wrapping
**What goes wrong:** Legacy type has flat `lat`/`lon` fields. Proto type has `location: GeoCoordinates` with `latitude`/`longitude`. Forgetting to wrap/unwrap causes missing coordinates on map.
**Why it happens:** Shape mismatch between legacy and proto types.
**How to avoid:** Handler wraps lat/lon into `{ latitude, longitude }` for proto. Service module unwraps `location?.latitude` / `location?.longitude` back to flat `lat`/`lon`.
**Warning signs:** All flight delays show at lat=0, lon=0 on the map.

## Code Examples

### Example 1: Handler XML Parsing with fast-xml-parser

```typescript
import { XMLParser } from 'fast-xml-parser';
import type {
  AviationServiceHandler,
  ServerContext,
  ListAirportDelaysRequest,
  ListAirportDelaysResponse,
  AirportDelayAlert,
  FlightDelayType,
  FlightDelaySeverity,
  FlightDelaySource,
  AirportRegion,
} from '../../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { MONITORED_AIRPORTS, FAA_AIRPORTS, DELAY_SEVERITY_THRESHOLDS } from '../../../../../src/config/airports';

const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (_name, jpath) => {
    // Force arrays for list items regardless of count
    return /\.(Ground_Delay|Ground_Stop|Delay|Airport)$/.test(jpath);
  },
});

// Parse FAA XML into internal delay map
function parseFaaXml(xml: string): Map<string, { airport: string; reason: string; avgDelay: number; type: string }> {
  const delays = new Map();
  const parsed = xmlParser.parse(xml);
  const root = parsed?.AIRPORT_STATUS_INFORMATION;
  if (!root) return delays;

  // Delay_type is an array of delay categories
  const delayTypes = Array.isArray(root.Delay_type) ? root.Delay_type : (root.Delay_type ? [root.Delay_type] : []);

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
    // Closures
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

### Example 2: Service Module Adapter (Plan 02)

```typescript
// src/services/aviation/index.ts
import {
  AviationServiceClient,
  type ListAirportDelaysResponse as ProtoResponse,
  type AirportDelayAlert as ProtoAlert,
} from '@/generated/client/worldmonitor/aviation/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// Re-export consumer-friendly types
export interface AirportDelayAlert {
  id: string;
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  region: 'americas' | 'europe' | 'apac' | 'mena' | 'africa';
  delayType: 'ground_stop' | 'ground_delay' | 'departure_delay' | 'arrival_delay' | 'general';
  severity: 'normal' | 'minor' | 'moderate' | 'major' | 'severe';
  avgDelayMinutes: number;
  reason?: string;
  source: 'faa' | 'eurocontrol' | 'computed';
  updatedAt: Date;
}

const SEVERITY_MAP: Record<string, AirportDelayAlert['severity']> = {
  FLIGHT_DELAY_SEVERITY_NORMAL: 'normal',
  FLIGHT_DELAY_SEVERITY_MINOR: 'minor',
  FLIGHT_DELAY_SEVERITY_MODERATE: 'moderate',
  FLIGHT_DELAY_SEVERITY_MAJOR: 'major',
  FLIGHT_DELAY_SEVERITY_SEVERE: 'severe',
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
    reason: proto.reason || undefined,
    source: SOURCE_MAP[proto.source] ?? 'computed',
    updatedAt: new Date(proto.updatedAt),
  };
}

const client = new AviationServiceClient('');
const breaker = createCircuitBreaker<AirportDelayAlert[]>({ name: 'FAA Flight Delays' });

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

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Browser-side XML parsing via DOMParser | Server-side parsing via fast-xml-parser | This migration | XML parsing moves to handler; client receives structured JSON |
| Raw XML proxy endpoint (`api/faa-status.js`) | Proto-typed JSON endpoint (`/api/aviation/v1/list-airport-delays`) | This migration | Client no longer needs XML parsing capability |
| Client-side simulated delay generation | Server-side simulation in handler | This migration | Consistent data across refreshes (within same handler invocation) |
| Imports from `@/services` barrel with `flights.ts` | Imports from `@/services/aviation` module directory | This migration | Follows port/adapter pattern established in 2C-2G |

## Data Flow Analysis

### Current (Legacy) Flow
```
Browser                    Vercel Edge
  |                          |
  |-- GET /api/faa-status -->|-- fetch nasstatus.faa.gov -->
  |<-- raw XML --------------|<-- raw XML ------------------|
  |                          |
  | DOMParser(xml)           |
  | parseXMLDelays()         |
  | enrichWithAirportConfig()|
  | generateSimulatedDelays()|
  | determineSeverity()      |
  |                          |
  v                          |
  AirportDelayAlert[]        |
```

### Target (Sebuf) Flow
```
Browser                    Vercel Edge (Handler)
  |                          |
  |-- POST /api/aviation/ -->|-- fetch nasstatus.faa.gov -->
  |   /v1/list-airport-      |<-- raw XML ------------------|
  |   delays                 |                               |
  |                          | fast-xml-parser.parse(xml)    |
  |                          | enrichWithAirportConfig()     |
  |                          | generateSimulatedDelays()     |
  |                          | determineSeverity()           |
  |                          | mapToProtoShape()             |
  |                          |                               |
  |<-- JSON (proto-typed) ---|                               |
  |                          |
  | AviationServiceClient    |
  | toDisplayAlert()         |
  |                          |
  v                          |
  AirportDelayAlert[]        |
```

## Consumer Inventory (for Plan 02 rewiring)

### Primary Consumer: `src/App.ts`
- **Line 15:** Imports `fetchFlightDelays` from `@/services` barrel
- **Line 3925:** Calls `fetchFlightDelays()` in `loadFlightDelays()`
- **Line 2903:** Schedules `loadFlightDelays()` in layer tasks
- **Line 4284:** Schedules periodic refresh every 10 minutes
- **Action:** Change import source from `@/services` to `@/services/aviation`

### Type Consumers: `src/components/Map.ts`, `DeckGLMap.ts`, `MapContainer.ts`, `MapPopup.ts`
- Import `AirportDelayAlert` from `@/types`
- Used for flight delay rendering, popups, layer management
- **Action:** Change import to `@/services/aviation` (re-exported type)

### Config Consumers: `src/config/airports.ts`
- Exports `MONITORED_AIRPORTS`, `FAA_AIRPORTS`, `DELAY_SEVERITY_THRESHOLDS`
- **Action:** KEEP as-is. This config is shared between handler (via relative import) and any consumer that needs airport lookup.

### Test Consumer: `src/e2e/map-harness.ts`
- Imports `AirportDelayAlert` from `@/types`
- **Action:** Change import to `@/services/aviation`

### Barrel Export: `src/services/index.ts`
- Line 18: `export * from './flights'`
- **Action:** Remove this line. Replace with `export { fetchFlightDelays } from './aviation'` or update App.ts to import directly from `@/services/aviation`.

### Helper Functions to Preserve
- `getAirportByCode(code)` - Used nowhere outside flights.ts (no external consumers found)
- `getAllMonitoredAirports()` - Used nowhere outside flights.ts
- `getFlightsStatus()` - Returns circuit breaker status, used nowhere outside flights.ts
- **Action:** Only `fetchFlightDelays` needs to be re-exported from the service module. The helper functions are dead code or internal-only.

### Legacy Types to Remove from `src/types/index.ts`
- `FlightDelaySource` (line 623) -- replaced by proto enum via service module
- `FlightDelaySeverity` (line 624) -- replaced
- `FlightDelayType` (line 625) -- replaced
- `AirportRegion` (line 626) -- replaced
- `AirportDelayAlert` (lines 628-647) -- replaced by service module export
- `MonitoredAirport` (lines 649-658) -- **KEEP**: still used by `src/config/airports.ts` which is shared infrastructure. The handler imports it.

### Files to Delete
- `api/faa-status.js` -- Legacy XML proxy, no longer needed
- `src/services/flights.ts` -- Legacy service, replaced by `src/services/aviation/index.ts`

## Open Questions

1. **fast-xml-parser exact XML structure of FAA response**
   - What we know: The FAA NASSTATUS XML has `<AIRPORT_STATUS_INFORMATION>` root with `<Delay_type>` children. From the live API fetch, only Airport_Closure_List was present (likely because no delays were active at query time). The legacy parsing code in `src/services/flights.ts` handles Ground_Delay_List, Ground_Stop_List, Arrival_Departure_Delay_List, and Airport_Closure_List.
   - What's unclear: The exact nesting structure within `<Delay_type>` -- whether each delay category is its own `<Delay_type>` element or they're all under one. The legacy `DOMParser` code uses CSS selectors that handle both cases.
   - Recommendation: Parse defensively. Check for both array and single-object access patterns. The `isArray` option in fast-xml-parser handles the single-vs-multiple case. For the `Delay_type` wrapping, handle both array and single object.

2. **Should `MonitoredAirport` type stay in `src/types/index.ts`?**
   - What we know: `MonitoredAirport` is used by `src/config/airports.ts` (the config data) and by the handler (via config import). The handler's proto interface has its own `AirportDelayAlert` shape that doesn't use `MonitoredAirport`.
   - What's unclear: Whether removing it from types/index.ts breaks the config import chain since airports.ts imports it from `@/types`.
   - Recommendation: KEEP `MonitoredAirport` in `src/types/index.ts`. It defines the shape of the shared airport config data, not the API response type. It's used by `src/config/airports.ts` which is imported by both the handler and potentially other services.

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** -- All source files examined directly:
  - `api/faa-status.js` (legacy XML proxy endpoint)
  - `src/services/flights.ts` (legacy service with full XML parsing, simulated delays, circuit breaker)
  - `src/config/airports.ts` (MONITORED_AIRPORTS, FAA_AIRPORTS, DELAY_SEVERITY_THRESHOLDS)
  - `proto/worldmonitor/aviation/v1/service.proto`, `airport_delay.proto`, `list_airport_delays.proto`
  - `src/generated/server/worldmonitor/aviation/v1/service_server.ts` (generated handler interface)
  - `src/generated/client/worldmonitor/aviation/v1/service_client.ts` (generated client)
  - `api/[[...path]].ts` (catch-all gateway)
  - `api/server/worldmonitor/displacement/v1/handler.ts` (reference handler pattern)
  - `src/services/displacement/index.ts` (reference service module pattern)
  - `scripts/build-sidecar-sebuf.mjs` (esbuild sidecar config)
  - All consumer files (App.ts, Map.ts, DeckGLMap.ts, MapContainer.ts, MapPopup.ts, map-harness.ts)

### Secondary (MEDIUM confidence)
- [fast-xml-parser npm](https://www.npmjs.com/package/fast-xml-parser) -- v5.3.6, pure JS, 3500+ dependents
- [fast-xml-parser GitHub](https://github.com/NaturalIntelligence/fast-xml-parser) -- Getting started docs, isArray option
- [FAA NASSTATUS API](https://nasstatus.faa.gov/api/airport-status-information) -- Live XML endpoint confirmed working

### Tertiary (LOW confidence)
- FAA XML structure beyond Airport_Closure_List -- Only closures were present in live response at time of research. Ground_Delay, Ground_Stop, and Arrival_Departure_Delay structures are inferred from legacy parsing code (HIGH confidence from code, LOW from live API verification).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- fast-xml-parser is the clear choice for pure-JS XML parsing, widely used, well-documented
- Architecture: HIGH -- follows established 2-plan pattern from 5 prior migrations, same handler/gateway/service-module structure
- Pitfalls: HIGH -- pitfalls identified from direct code analysis and XML parsing experience; array handling is a known fast-xml-parser gotcha documented in their FAQ
- Consumer rewiring: HIGH -- comprehensive grep of all consumers, clear inventory of what imports what

**Research date:** 2026-02-19
**Valid until:** 2026-03-19 (stable domain, no fast-moving dependencies)
