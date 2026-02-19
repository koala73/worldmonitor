---
phase: 2L-maritime-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/maritime/v1/handler.ts
  - api/[[...path]].ts
autonomous: true
requirements:
  - DOMAIN-06
  - SERVER-02

must_haves:
  truths:
    - "POST /api/maritime/v1/get-vessel-snapshot returns JSON with snapshot object containing snapshotAt (epoch ms), densityZones array (id, name, location with latitude/longitude, intensity, deltaPct, shipsPerDay, note), and disruptions array (id, name, type as AIS_DISRUPTION_TYPE_*, location, severity as AIS_DISRUPTION_SEVERITY_*, changePct, windowHours, darkShips, vesselCount, region, description)"
    - "Handler converts WS_RELAY_URL env var from wss:// to https:// (or ws:// to http://) and fetches /ais/snapshot?candidates=false from the relay"
    - "When WS_RELAY_URL is missing, getVesselSnapshot returns empty snapshot (graceful degradation, no error thrown)"
    - "POST /api/maritime/v1/list-navigational-warnings returns JSON with warnings array containing id (NAVAREA-year-number), title, text, area, location (optional), issuedAt (epoch ms), expiresAt (0), authority"
    - "listNavigationalWarnings proxies https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A and maps raw NGA broadcast warnings to proto NavigationalWarning shape"
    - "When NGA API is unreachable, listNavigationalWarnings returns empty warnings array (graceful degradation)"
    - "Handler maps raw density[].lat/lon to proto densityZones[].location.latitude/longitude (GeoCoordinates nesting)"
    - "Handler maps raw disruptions[].type string (gap_spike) to proto AisDisruptionType enum (AIS_DISRUPTION_TYPE_GAP_SPIKE)"
    - "Handler maps raw disruptions[].severity string (elevated) to proto AisDisruptionSeverity enum (AIS_DISRUPTION_SEVERITY_ELEVATED)"
    - "NGA warning date parsing handles military format like '081653Z MAY 2024' and converts to epoch ms"
  artifacts:
    - path: "api/server/worldmonitor/maritime/v1/handler.ts"
      provides: "MaritimeServiceHandler with getVesselSnapshot and listNavigationalWarnings RPCs"
      exports: ["maritimeHandler"]
    - path: "api/[[...path]].ts"
      provides: "Maritime routes mounted in catch-all gateway"
      contains: "createMaritimeServiceRoutes"
  key_links:
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/maritime/v1/handler.ts"
      via: "import maritimeHandler"
      pattern: "import.*maritimeHandler.*from.*handler"
    - from: "api/server/worldmonitor/maritime/v1/handler.ts"
      to: "src/generated/server/worldmonitor/maritime/v1/service_server.ts"
      via: "implements MaritimeServiceHandler interface"
      pattern: "MaritimeServiceHandler"
---

<objective>
Implement the maritime domain handler with 2 RPCs (getVesselSnapshot, listNavigationalWarnings) that proxy two distinct upstream APIs, then mount routes in the catch-all gateway.

Purpose: Server-side consolidation of two legacy edge functions (api/ais-snapshot.js proxying the WS relay for AIS vessel data, api/nga-warnings.js proxying the NGA MSI API for navigational warnings) into a single proto-typed handler. The handler is a thin proxy -- NO caching (legacy 3-layer Redis+memory+stale caching was needed because the Vercel edge function was the sole gateway; the new architecture has client-side polling managing refresh intervals).
Output: Working handler at api/server/worldmonitor/maritime/v1/handler.ts, routes mounted in gateway, sidecar rebuilt.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2L-maritime-migration/2L-RESEARCH.md

# Reference handlers (patterns to follow)
@api/server/worldmonitor/conflict/v1/handler.ts
@api/server/worldmonitor/unrest/v1/handler.ts

# Generated server types (handler interface)
@src/generated/server/worldmonitor/maritime/v1/service_server.ts

# Legacy code to port logic FROM (do NOT modify these files)
@api/ais-snapshot.js
@api/nga-warnings.js

# Gateway to modify
@api/[[...path]].ts

# Sidecar build script
@scripts/build-sidecar-sebuf.mjs
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement MaritimeServiceHandler with 2 RPCs proxying WS relay and NGA MSI API</name>
  <files>api/server/worldmonitor/maritime/v1/handler.ts</files>
  <action>
Create `api/server/worldmonitor/maritime/v1/handler.ts` implementing the generated `MaritimeServiceHandler` interface with 2 RPC methods: `getVesselSnapshot`, `listNavigationalWarnings`.

**Process declaration (edge runtime):**
```typescript
declare const process: { env: Record<string, string | undefined> };
```

**Imports:**
- Types from `../../../../../src/generated/server/worldmonitor/maritime/v1/service_server`: `MaritimeServiceHandler`, `ServerContext`, `GetVesselSnapshotRequest`, `GetVesselSnapshotResponse`, `VesselSnapshot`, `AisDensityZone`, `AisDisruption`, `AisDisruptionType`, `AisDisruptionSeverity`, `ListNavigationalWarningsRequest`, `ListNavigationalWarningsResponse`, `NavigationalWarning`

---

**RPC 1: getVesselSnapshot** -- Port from `api/ais-snapshot.js` lines 59-66, 79-206

Top-level RPC wraps in try/catch returning empty on failure:

```typescript
async getVesselSnapshot(_ctx: ServerContext, _req: GetVesselSnapshotRequest): Promise<GetVesselSnapshotResponse> {
  try {
    const snapshot = await fetchVesselSnapshot();
    return { snapshot };
  } catch {
    return { snapshot: undefined };
  }
}
```

**CRITICAL: NO caching in the handler.** The legacy `api/ais-snapshot.js` had Redis + memory + stale fallback + in-flight deduplication. This is NOT needed because the handler is now behind the gateway, and the client-side service module manages polling at 10-second intervals. The handler is a thin proxy.

**WS Relay URL Conversion** -- Port exactly from `api/ais-snapshot.js` lines 59-66:
```typescript
function getRelayBaseUrl(): string | null {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')
    .replace(/\/$/, '');
}
```

**Disruption Type and Severity Enum Maps** (raw lowercase string -> proto enum):
```typescript
const DISRUPTION_TYPE_MAP: Record<string, AisDisruptionType> = {
  gap_spike: 'AIS_DISRUPTION_TYPE_GAP_SPIKE',
  chokepoint_congestion: 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION',
};

const SEVERITY_MAP: Record<string, AisDisruptionSeverity> = {
  low: 'AIS_DISRUPTION_SEVERITY_LOW',
  elevated: 'AIS_DISRUPTION_SEVERITY_ELEVATED',
  high: 'AIS_DISRUPTION_SEVERITY_HIGH',
};
```

**Helper: fetchVesselSnapshot()** -- Port from `api/ais-snapshot.js` handler body, simplified (no caching):
- Call `getRelayBaseUrl()`. If null, return `undefined`.
- Fetch `${relayBaseUrl}/ais/snapshot?candidates=false` with `{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }`.
- If `!response.ok`, return `undefined`.
- Parse JSON. Validate: `data && Array.isArray(data.disruptions) && Array.isArray(data.density)`. If invalid, return `undefined`.
- Map to proto `VesselSnapshot`:
  - `snapshotAt`: `Date.now()`
  - `densityZones`: `data.density.map((z: any): AisDensityZone => ({ ... }))` -- map `z.lat/lon` to `location: { latitude: Number(z.lat) || 0, longitude: Number(z.lon) || 0 }`, copy `id`, `name`, `intensity`, `deltaPct`, `shipsPerDay`, `note` with Number()/String() fallbacks
  - `disruptions`: `data.disruptions.map((d: any): AisDisruption => ({ ... }))` -- map `d.lat/lon` to `location: { latitude: Number(d.lat) || 0, longitude: Number(d.lon) || 0 }`, map `d.type` through `DISRUPTION_TYPE_MAP` with `'AIS_DISRUPTION_TYPE_UNSPECIFIED'` fallback, map `d.severity` through `SEVERITY_MAP` with `'AIS_DISRUPTION_SEVERITY_UNSPECIFIED'` fallback, copy `id`, `name`, `changePct`, `windowHours`, `darkShips`, `vesselCount`, `region`, `description` with Number()/String() fallbacks
- Return the `VesselSnapshot`.
- Wrap in try/catch, return `undefined` on any error.

---

**RPC 2: listNavigationalWarnings** -- Port from `api/nga-warnings.js`

Top-level RPC wraps in try/catch returning empty on failure:

```typescript
async listNavigationalWarnings(_ctx: ServerContext, req: ListNavigationalWarningsRequest): Promise<ListNavigationalWarningsResponse> {
  try {
    const warnings = await fetchNgaWarnings(req.area);
    return { warnings, pagination: undefined };
  } catch {
    return { warnings: [], pagination: undefined };
  }
}
```

**NGA URL Constant:**
```typescript
const NGA_WARNINGS_URL = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';
```

**Helper: fetchNgaWarnings(area?: string):**
- Fetch `NGA_WARNINGS_URL` with `{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }`.
- If `!response.ok`, return `[]`.
- Parse JSON. Extract warnings: `Array.isArray(data) ? data : (data?.broadcast_warn ?? [])`.
- Map each warning to `NavigationalWarning`:
  - `id`: `${w.navArea || ''}-${w.msgYear || ''}-${w.msgNumber || ''}` -- **encode navArea, msgYear, msgNumber into the id** (cable-activity.ts in Plan 02 will parse these back out)
  - `title`: `NAVAREA ${w.navArea || ''} ${w.msgNumber || ''}/${w.msgYear || ''}`
  - `text`: `w.text || ''`
  - `area`: `${w.navArea || ''}${w.subregion ? ' ' + w.subregion : ''}` -- **encode navArea and subregion into area** (cable-activity.ts will parse navArea from this)
  - `location`: `undefined` (NGA warnings don't reliably have parseable coordinates in a standard format)
  - `issuedAt`: `parseNgaDate(w.issueDate)`
  - `expiresAt`: `0` (NGA active warnings don't have explicit expiry)
  - `authority`: `w.authority || ''`
- If `area` is non-empty, filter warnings: `w.area.toLowerCase().includes(area.toLowerCase()) || w.text.toLowerCase().includes(area.toLowerCase())`.
- Return the filtered array.
- Wrap in try/catch, return `[]` on any error.

**Helper: parseNgaDate(dateStr: unknown): number** -- Port from `src/services/cable-activity.ts` parseIssueDate logic, adapted to return epoch ms:
```typescript
function parseNgaDate(dateStr: unknown): number {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  // Format: "081653Z MAY 2024"
  const match = dateStr.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!match) return Date.parse(dateStr) || 0;
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const day = parseInt(match[1]!, 10);
  const hours = parseInt(match[2]!.slice(0, 2), 10);
  const minutes = parseInt(match[2]!.slice(2, 4), 10);
  const month = months[match[3]!.toUpperCase()] ?? 0;
  const year = parseInt(match[4]!, 10);
  return Date.UTC(year, month, day, hours, minutes);
}
```

**Export:** `export const maritimeHandler: MaritimeServiceHandler = { ... }`

**All helpers are individually wrapped in try/catch returning empty on error.** The top-level RPCs also have try/catch for safety. No error logging on upstream failures (following established 2F-01 pattern).
  </action>
  <verify>
Run `npx tsc --noEmit -p tsconfig.api.json` -- must pass with no type errors in the handler file. Verify the file exists at the expected path.
  </verify>
  <done>Handler file implements MaritimeServiceHandler with 2 RPCs. getVesselSnapshot proxies WS relay HTTP endpoint (converting wss:// to https://) and maps raw density/disruption data to proto shape with GeoCoordinates nesting and enum string-to-proto mapping. listNavigationalWarnings proxies NGA MSI API and maps broadcast warnings to proto NavigationalWarning shape with military date parsing. Both RPCs have graceful degradation returning empty on failure. No caching in handler (client-side polling manages refresh).</done>
</task>

<task type="auto">
  <name>Task 2: Mount maritime routes in gateway and rebuild sidecar</name>
  <files>api/[[...path]].ts</files>
  <action>
**Gateway wiring** -- Add maritime to the catch-all gateway (`api/[[...path]].ts`):

1. Add import for route creator (after the conflict import):
   ```typescript
   import { createMaritimeServiceRoutes } from '../src/generated/server/worldmonitor/maritime/v1/service_server';
   ```

2. Add import for handler (after the conflictHandler import):
   ```typescript
   import { maritimeHandler } from './server/worldmonitor/maritime/v1/handler';
   ```

3. Add to `allRoutes` array (after the conflict spread):
   ```typescript
   ...createMaritimeServiceRoutes(maritimeHandler, serverOptions),
   ```

**Sidecar rebuild:**
Run `npm run build:sidecar-sebuf` to compile the updated gateway into the sidecar bundle. This ensures Tauri desktop app includes maritime routes.

**Verification:**
Run `npx tsc --noEmit -p tsconfig.api.json` to confirm all imports resolve and types align.
  </action>
  <verify>
1. `npx tsc --noEmit -p tsconfig.api.json` passes
2. `npm run build:sidecar-sebuf` succeeds with no errors
3. `grep -c 'createMaritimeServiceRoutes' api/[[...path]].ts` returns 1
  </verify>
  <done>Maritime routes mounted in catch-all gateway. Sidecar bundle rebuilt with maritime endpoints included. Two RPCs routable at POST /api/maritime/v1/get-vessel-snapshot and POST /api/maritime/v1/list-navigational-warnings.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit -p tsconfig.api.json` -- zero errors
2. `npm run build:sidecar-sebuf` -- successful build
3. Handler exports `maritimeHandler` implementing `MaritimeServiceHandler`
4. Gateway imports and mounts maritime routes
5. RPC paths /api/maritime/v1/get-vessel-snapshot and /api/maritime/v1/list-navigational-warnings reachable through the gateway router
6. NGA warning `id` encodes navArea-msgYear-msgNumber for downstream cable-activity parsing
7. NGA warning `area` encodes navArea + subregion for downstream cable-activity parsing
</verification>

<success_criteria>
- MaritimeServiceHandler implementation with 2 RPCs (getVesselSnapshot, listNavigationalWarnings)
- getVesselSnapshot proxies WS relay HTTP endpoint with ws->http URL conversion, maps density/disruptions to proto shape with GeoCoordinates nesting
- Disruption type/severity mapped from lowercase strings to proto enums (gap_spike -> AIS_DISRUPTION_TYPE_GAP_SPIKE)
- listNavigationalWarnings proxies NGA MSI public API, maps raw broadcast warnings to proto NavigationalWarning shape
- NGA warning id format: `${navArea}-${msgYear}-${msgNumber}` (parseable by cable-activity.ts)
- NGA warning area format: `${navArea} ${subregion}` (parseable by cable-activity.ts)
- NGA date parsing handles military format (081653Z MAY 2024) to epoch ms
- Both RPCs have graceful degradation: empty response on upstream failure
- No caching in handler (client-side polling manages refresh intervals)
- Routes mounted in catch-all gateway
- Sidecar bundle rebuilt
- TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2L-maritime-migration/2L-01-SUMMARY.md`
</output>
