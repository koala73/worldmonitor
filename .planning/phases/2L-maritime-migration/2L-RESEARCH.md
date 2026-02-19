# Phase 2L: Maritime Migration - Research

**Researched:** 2026-02-19
**Domain:** Maritime domain migration to sebuf (AIS vessel snapshot + NGA navigational warnings) -- handler proxying WS relay for AIS data and NGA MSI API for navigational warnings, service module with port/adapter pattern preserving multi-strategy AIS fetch (Railway/Vercel/local) and snapshot caching, rewire all consumers, delete legacy endpoints
**Confidence:** HIGH

## Summary

The maritime migration is the 10th domain in the sebuf migration series (2C through 2L). It follows the established 2-plan pattern (Plan 01: handler + gateway wiring; Plan 02: service module + consumer rewiring + legacy deletion). The maritime domain has 2 RPCs: `GetVesselSnapshot` (proxying the WS relay for AIS vessel traffic data) and `ListNavigationalWarnings` (proxying the NGA MSI API for maritime safety warnings).

The proto definition is already complete at `proto/worldmonitor/maritime/v1/service.proto` with generated server types (`MaritimeServiceHandler` interface) and client code (`MaritimeServiceClient` class). The handler needs to implement both RPCs. `GetVesselSnapshot` proxies a WS relay URL (configured via `WS_RELAY_URL` env var) that provides AIS disruption zones, density zones, and vessel status data. The legacy `api/ais-snapshot.js` has complex multi-layer caching (Redis + in-memory + stale fallback + in-flight deduplication), but the handler should NOT replicate this caching -- the handler is a thin proxy, and caching was only needed because the Vercel edge function was the sole gateway. The new handler runs behind the gateway and caching at the handler level is unnecessary (the client-side service module handles polling intervals). `ListNavigationalWarnings` proxies `https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A` which is a simple public API with no auth.

The maritime domain has ONE legacy service file (`src/services/ais.ts`) and TWO legacy API endpoints (`api/ais-snapshot.js`, `api/nga-warnings.js`). Additionally, `src/services/cable-activity.ts` fetches NGA warnings via the legacy `/api/nga-warnings` endpoint and processes them for cable infrastructure advisories. The AIS service is consumed via the barrel (`@/services`) by `App.ts` (imports `fetchAisSignals`, `initAisStream`, `getAisStatus`, `disconnectAisStream`, `isAisConfigured`) and directly by `military-vessels.ts` (imports `registerAisCallback`, `unregisterAisCallback`, `isAisConfigured`, `initAisStream`, `AisPositionData`). The client-side AIS service has a complex polling/callback architecture for live vessel positions that is INDEPENDENT of the handler -- it orchestrates when to fetch and how to distribute data to subscribers.

**Primary recommendation:** Implement a 2-RPC handler (`getVesselSnapshot`, `listNavigationalWarnings`) that proxies the two upstream APIs. The `getVesselSnapshot` handler proxies the WS relay URL (converting ws:// to http://) and maps the response to proto `VesselSnapshot` shape. The `listNavigationalWarnings` handler proxies the NGA MSI API and maps each warning to proto `NavigationalWarning` shape. The service module wraps `MaritimeServiceClient` and provides adapter functions mapping proto types back to legacy types (`AisDisruptionEvent`, `AisDensityZone` from `@/types`). The client-side polling/callback architecture (initAisStream, registerAisCallback, etc.) stays in the service module because it is pure client-side orchestration logic. Consumer rewiring updates the barrel export and the `military-vessels.ts` direct import. The `cable-activity.ts` service must also be updated to use `ListNavigationalWarnings` instead of fetching from `/api/nga-warnings`. Legacy files deleted: 2 API endpoints + the parts of `ais.ts` that become the maritime service module.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-06 | Infrastructure domain proto (Cloudflare Radar outages, PizzINT, NGA maritime warnings) with service RPCs and HTTP annotations | The maritime proto files cover the NGA maritime warnings portion of DOMAIN-06: `service.proto` (2 RPCs with HTTP annotations), `vessel_snapshot.proto` (`VesselSnapshot`, `AisDensityZone`, `AisDisruption`, `NavigationalWarning` messages with `AisDisruptionType`/`AisDisruptionSeverity` enums), `list_navigational_warnings.proto` (request with pagination + area filter, response with warnings array). The `ListNavigationalWarnings` RPC directly addresses the NGA maritime warnings part of DOMAIN-06. Note: Cloudflare Radar outages and PizzINT are NOT part of this phase -- they are separate domains. |
| SERVER-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | Handler must implement `MaritimeServiceHandler` with 2 RPCs: `getVesselSnapshot` (proxies `${WS_RELAY_URL}/ais/snapshot` with ws->http URL conversion, maps density/disruption/status data to proto shape) and `listNavigationalWarnings` (proxies `https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A`, maps NGA broadcast warnings to proto `NavigationalWarning` shape). Both RPCs follow established graceful degradation pattern (return empty on failure). |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (none new) | - | All infrastructure already exists | No new dependencies needed for this migration |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | All infrastructure is existing project code (generated server/client, circuit breaker, CORS, error mapper) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Handler proxying WS relay HTTP endpoint | Direct WebSocket connection from handler | WS relay already exposes HTTP `/ais/snapshot` endpoint. Using HTTP fetch is simpler, stateless, and matches all other handler patterns. WebSocket would require connection management in an edge-function handler. |
| Removing multi-layer caching (Redis + memory) from handler | Replicating legacy caching in handler | The legacy `api/ais-snapshot.js` had complex 3-layer caching (Redis, in-memory, stale fallback, in-flight dedup) because it was the ONLY entry point. The new handler is a thin proxy behind the gateway -- the client service module already handles polling intervals (10s). Caching in the handler adds unnecessary complexity. |
| Keeping `cable-activity.ts` fetching from old NGA endpoint | Rewiring `cable-activity.ts` to use the maritime service client | `cable-activity.ts` currently fetches raw NGA warnings from `/api/nga-warnings` and processes them itself. After migration, it should fetch via the `MaritimeServiceClient.listNavigationalWarnings()` RPC. However, the NGA warnings returned by the proto shape (`NavigationalWarning`) differ from the raw NGA API response shape (`NgaWarning` with `msgYear`, `msgNumber`, `navArea`, `subregion`, `text`, `status`, `issueDate`, `authority`). The cable-activity processing code needs the RAW NGA fields (`navArea`, `msgYear`, `msgNumber`, `text`, `issueDate`), not the proto shape. See Open Question 1 for resolution. |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure
```
api/
  server/
    worldmonitor/
      maritime/
        v1/
          handler.ts              # Plan 01: MaritimeServiceHandler with 2 RPCs
  [[...path]].ts                  # Plan 01: Mount maritime routes (add import + spread)
  ais-snapshot.js                 # Plan 02: DELETE (legacy AIS snapshot proxy)
  nga-warnings.js                 # Plan 02: DELETE (legacy NGA warnings proxy)

src/
  services/
    maritime/
      index.ts                    # Plan 02: Port/adapter service module
    ais.ts                        # Plan 02: DELETE (legacy AIS client -- replaced by maritime module)
    cable-activity.ts             # Plan 02: UPDATE (rewire NGA fetch to use maritime client OR keep raw fetch -- see Open Question 1)
    military-vessels.ts           # Plan 02: UPDATE imports from './ais' to './maritime' (or './maritime/ais')
  types/
    index.ts                      # Plan 02: Keep AisDisruptionEvent, AisDensityZone, AisDisruptionType (used by map components + signal-aggregator)
```

### Pattern 1: Two-RPC Handler Proxying Distinct Upstream APIs
**What:** A single handler file implementing `MaritimeServiceHandler` with two RPC methods, each independently proxying a different upstream API.
**When to use:** For the `getVesselSnapshot` and `listNavigationalWarnings` RPCs.
**Key insight:** The two RPCs proxy completely different data sources:
1. `getVesselSnapshot` proxies the WS relay HTTP endpoint (`${WS_RELAY_URL}/ais/snapshot`) -- requires env var for URL, returns vessel density/disruption data
2. `listNavigationalWarnings` proxies the NGA MSI public API (`https://msi.nga.mil/api/publications/broadcast-warn`) -- no auth required, returns maritime safety warnings

```typescript
// api/server/worldmonitor/maritime/v1/handler.ts
import type {
  MaritimeServiceHandler,
  ServerContext,
  GetVesselSnapshotRequest,
  GetVesselSnapshotResponse,
  VesselSnapshot,
  AisDensityZone,
  AisDisruption,
  AisDisruptionType,
  AisDisruptionSeverity,
  ListNavigationalWarningsRequest,
  ListNavigationalWarningsResponse,
  NavigationalWarning,
} from '../../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

export const maritimeHandler: MaritimeServiceHandler = {
  async getVesselSnapshot(_ctx, req) { /* ... */ },
  async listNavigationalWarnings(_ctx, req) { /* ... */ },
};
```

### Pattern 2: WS Relay URL Conversion (from legacy `api/ais-snapshot.js`)
**What:** Converts WebSocket URL to HTTP for snapshot fetching.
**When to use:** For `getVesselSnapshot` RPC.
**Key insight:** The WS relay provides an HTTP endpoint at `/ais/snapshot`. The env var `WS_RELAY_URL` is a WebSocket URL (`wss://...`), so the handler must convert `wss://` to `https://` and `ws://` to `http://`. This is exactly the pattern from `api/ais-snapshot.js` lines 59-66.

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

### Pattern 3: AIS Snapshot Response Mapping
**What:** Maps raw AIS snapshot JSON to proto `VesselSnapshot` shape.
**When to use:** For `getVesselSnapshot` RPC.
**Key insight:** The raw AIS snapshot response has a different shape than the proto:

Raw (from WS relay):
```json
{
  "sequence": 42,
  "timestamp": "...",
  "status": { "connected": true, "vessels": 1234, "messages": 56789 },
  "disruptions": [{ "id": "...", "name": "...", "type": "gap_spike", ... }],
  "density": [{ "id": "...", "name": "...", "lat": 1.3, "lon": 103.8, ... }]
}
```

Proto `VesselSnapshot`:
```typescript
{
  snapshotAt: number,        // epoch ms
  densityZones: AisDensityZone[],   // location is GeoCoordinates { latitude, longitude }
  disruptions: AisDisruption[],      // location is GeoCoordinates, type/severity are enums
}
```

The handler must map:
- `density[].lat/lon` -> `densityZones[].location.latitude/longitude`
- `disruptions[].lat/lon` -> `disruptions[].location.latitude/longitude`
- `disruptions[].type` string -> `AisDisruptionType` enum (e.g., `'gap_spike'` -> `'AIS_DISRUPTION_TYPE_GAP_SPIKE'`)
- `disruptions[].severity` string -> `AisDisruptionSeverity` enum (e.g., `'elevated'` -> `'AIS_DISRUPTION_SEVERITY_ELEVATED'`)
- `timestamp` -> `snapshotAt` as epoch ms

### Pattern 4: NGA Warnings Response Mapping
**What:** Maps raw NGA broadcast warnings JSON to proto `NavigationalWarning` shape.
**When to use:** For `listNavigationalWarnings` RPC.
**Key insight:** The NGA MSI API returns an array of broadcast warnings. Each warning object has fields like `msgYear`, `msgNumber`, `navArea`, `subregion`, `text`, `status`, `issueDate`, `authority`. The proto `NavigationalWarning` has `id`, `title`, `text`, `area`, `location`, `issuedAt`, `expiresAt`, `authority`.

The handler must map:
- `id`: construct from `navArea + '-' + msgYear + '-' + msgNumber`
- `title`: construct from `'NAVAREA ' + navArea + ' ' + msgNumber + '/' + msgYear`
- `text`: `warning.text` (full warning text)
- `area`: `warning.navArea + (warning.subregion ? ' ' + warning.subregion : '')`
- `location`: parse coordinates from warning text (optional -- many NGA warnings don't have parseable coords in a simple format)
- `issuedAt`: parse `issueDate` (format like `"081653Z MAY 2024"`) to epoch ms
- `expiresAt`: 0 or not set (NGA active warnings don't have explicit expiry in the API response)
- `authority`: `warning.authority`

### Pattern 5: Service Module Preserving Polling/Callback Architecture
**What:** The maritime service module must preserve the complex client-side polling and callback architecture from the legacy `ais.ts`.
**When to use:** For the service module in Plan 02.
**Key insight:** Unlike other migrations where the service module is a simple adapter wrapping the client, the maritime service module must also maintain the ENTIRE polling/callback system from `src/services/ais.ts`. This includes:
1. `initAisStream()` / `disconnectAisStream()` -- polling lifecycle management
2. `registerAisCallback()` / `unregisterAisCallback()` -- position data subscription
3. `fetchAisSignals()` -- returns latest disruptions + density
4. `getAisStatus()` -- returns connection status
5. `isAisConfigured()` -- feature gate check

The polling logic calls the server (currently via `fetch('/api/ais-snapshot')` or Railway direct) on a 10-second interval. After migration, it should call `MaritimeServiceClient.getVesselSnapshot()` instead. The callback system for individual vessel positions (`AisPositionData` with MMSI, lat/lon, heading, speed) is handled through the `candidateReports` field of the raw snapshot response -- but note the proto `VesselSnapshot` does NOT have a `candidateReports` field. This is a critical design issue (see Open Question 2).

### Anti-Patterns to Avoid
- **Replicating the 3-layer cache in the handler:** The legacy `api/ais-snapshot.js` has Redis + memory + stale fallback + in-flight dedup caching. This was needed because the Vercel edge function was the direct entry point for the browser. The new handler is called via the service module which already polls at 10-second intervals. Do NOT replicate caching in the handler.
- **Deleting the polling/callback system:** The `initAisStream`, `registerAisCallback`, `pollSnapshot` logic is client-side orchestration, NOT server-side. It MUST be preserved in the service module.
- **Deleting `AisDisruptionEvent`/`AisDensityZone` from `src/types/index.ts`:** These legacy types are used by `DeckGLMap.ts`, `MapContainer.ts`, `Map.ts`, `MapPopup.ts`, `signal-aggregator.ts`, `e2e/map-harness.ts`. The service module adapter must map proto types TO these legacy types. The types must remain in `src/types/index.ts`.
- **Forgetting to update `cable-activity.ts`:** This file fetches from `/api/nga-warnings` directly. After the legacy endpoint is deleted, this will break. Must be addressed.
- **Forgetting to update `military-vessels.ts`:** This file imports directly from `'./ais'`. After the legacy AIS service is replaced, this import must point to the new maritime module.
- **Forgetting to update the barrel (`src/services/index.ts`):** The barrel re-exports `export * from './ais'`. This must change to `export * from './maritime'` (or wherever the new module lives).
- **Forgetting `desktop-readiness.ts`:** This file references `'src/services/ais.ts'` and `'/api/ais-snapshot'` in its parity feature list. These references should be updated to the new paths.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WS URL to HTTP conversion | Custom URL parser | Port existing `getRelayBaseUrl()` from `api/ais-snapshot.js` | Simple replace pattern, already handles both ws:// and wss:// |
| AIS snapshot validation | New validation logic | Port existing `isValidSnapshot()` from `api/ais-snapshot.js` | Validates presence of `status`, `disruptions`, `density` arrays |
| NGA warning date parsing | Custom date parser | Port existing `parseIssueDate()` from `src/services/cable-activity.ts` | Handles `"081653Z MAY 2024"` military date format correctly |
| Polling lifecycle management | New polling system | Port existing polling code from `src/services/ais.ts` | 10-second interval, in-flight dedup, stale detection are all tuned |
| Circuit breaker wrapping | Custom retry/fallback | Use existing `createCircuitBreaker` from `@/utils` | Established pattern across all service modules |

**Key insight:** This migration ports existing, working logic from legacy files. The AIS polling/callback system is particularly complex and should be ported with minimal changes, only updating the fetch mechanism from `fetch('/api/ais-snapshot')` to `MaritimeServiceClient.getVesselSnapshot()`.

## Common Pitfalls

### Pitfall 1: AIS Disruption Type/Severity Enum Mapping (Double Mapping)
**What goes wrong:** The legacy types use lowercase string unions (`'gap_spike' | 'chokepoint_congestion'` for type, `'low' | 'elevated' | 'high'` for severity). The proto uses uppercase enums (`'AIS_DISRUPTION_TYPE_GAP_SPIKE'`, `'AIS_DISRUPTION_SEVERITY_ELEVATED'`). The raw WS relay data uses lowercase strings. So the handler maps lowercase -> proto enum, and the service module must map proto enum -> legacy lowercase.
**Why it happens:** Three different representations of the same enum: raw API, proto enum, legacy TypeScript union.
**How to avoid:** Create explicit mapping functions at both levels. In the handler:
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
In the service module:
```typescript
const DISRUPTION_TYPE_REVERSE: Record<string, AisDisruptionType_Legacy> = {
  AIS_DISRUPTION_TYPE_GAP_SPIKE: 'gap_spike',
  AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION: 'chokepoint_congestion',
};
```
**Warning signs:** Map layer shows wrong disruption icons or missing disruptions entirely.

### Pitfall 2: GeoCoordinates Flattening (Proto Nested vs Legacy Flat)
**What goes wrong:** The legacy `AisDisruptionEvent` and `AisDensityZone` in `src/types/index.ts` use flat `lat: number; lon: number` fields. The proto `AisDisruption` and `AisDensityZone` use nested `location?: GeoCoordinates` with `latitude`/`longitude`. The raw WS relay data also uses flat `lat`/`lon`.
**Why it happens:** Proto uses the shared `worldmonitor.core.v1.GeoCoordinates` message; legacy used flat fields.
**How to avoid:** Handler maps flat -> nested (`{ latitude: e.lat, longitude: e.lon }`). Service module maps nested -> flat (`lat: proto.location?.latitude ?? 0, lon: proto.location?.longitude ?? 0`).
**Warning signs:** Disruptions/density zones appear at (0, 0) on the map.

### Pitfall 3: VesselSnapshot Missing `candidateReports` Field
**What goes wrong:** The legacy AIS snapshot response includes `candidateReports` (individual vessel position updates) which are consumed by the callback system in `ais.ts` for live vessel tracking. The proto `VesselSnapshot` does NOT have a `candidateReports` field -- it only has `densityZones` and `disruptions`.
**Why it happens:** The proto was designed for the snapshot view (density + disruptions), not for individual vessel tracking.
**How to avoid:** The service module must maintain the multi-strategy fetch approach for the candidate reports use case. When `shouldIncludeCandidates()` is true (callbacks registered), the service module should call the raw WS relay endpoint directly (bypassing the proto RPC) to get candidateReports, OR the proto response can be used for density/disruptions while a parallel raw fetch gets candidateReports. See Open Question 2 for detailed analysis.
**Warning signs:** Military vessel tracking stops working after migration.

### Pitfall 4: Cable Activity Breaking After NGA Endpoint Deletion
**What goes wrong:** `src/services/cable-activity.ts` fetches from `/api/nga-warnings` and processes the raw NGA warning format (`NgaWarning` interface with `msgYear`, `msgNumber`, `navArea`, `subregion`, `text`, `status`, `issueDate`, `authority`). After deleting `api/nga-warnings.js`, cable activity breaks.
**Why it happens:** The proto `NavigationalWarning` shape (`id`, `title`, `text`, `area`, `location`, `issuedAt`, `expiresAt`, `authority`) loses critical fields needed by cable-activity processing: `navArea`, `msgYear`, `msgNumber`, `subregion`, `issueDate` (raw format).
**How to avoid:** See Open Question 1 for resolution options. The simplest approach is to have the `listNavigationalWarnings` handler return enough information in the proto fields so that cable-activity can reconstruct what it needs, OR keep the NGA raw format accessible through the handler via a pass-through field.
**Warning signs:** Cable advisories panel shows zero results after migration.

### Pitfall 5: Consumer Import Chain (Barrel + Direct Imports)
**What goes wrong:** The AIS service is consumed via TWO import paths:
1. **Barrel:** `App.ts` imports `fetchAisSignals`, `initAisStream`, `getAisStatus`, `disconnectAisStream`, `isAisConfigured` from `@/services` (barrel re-export)
2. **Direct:** `military-vessels.ts` imports `registerAisCallback`, `unregisterAisCallback`, `isAisConfigured`, `initAisStream`, `AisPositionData` from `'./ais'`

Both must be updated. The barrel in `src/services/index.ts` has `export * from './ais'` which must change to `export * from './maritime'`. The direct import in `military-vessels.ts` must change from `'./ais'` to `'./maritime'`.
**Why it happens:** AIS has both barrel and direct consumers (unlike conflict which only had direct).
**How to avoid:** Plan 02 must update both import paths: the barrel line in `src/services/index.ts` AND the direct import in `src/services/military-vessels.ts`. Also update `desktop-readiness.ts` which references the old paths in its feature list.
**Warning signs:** TypeScript compilation errors after deleting `src/services/ais.ts`.

### Pitfall 6: AIS Feature Gate (`isAisConfigured`)
**What goes wrong:** The `isAisConfigured()` function checks `import.meta.env.VITE_ENABLE_AIS !== 'false'` and `isFeatureAvailable('aisRelay')`. This is a client-side runtime check that must be preserved exactly.
**Why it happens:** Unlike server-side env vars, this uses Vite env vars which are build-time injected.
**How to avoid:** Port `isAisConfigured()` exactly as-is from `src/services/ais.ts` to the new maritime service module. Do not change the feature gate logic.
**Warning signs:** AIS data stops loading on the client even though the server handler works.

## Code Examples

### Handler: getVesselSnapshot RPC (porting from `api/ais-snapshot.js`)
```typescript
// Source: api/ais-snapshot.js lines 59-66, 79-206
// Key difference from legacy: NO caching. Handler is a thin proxy.

declare const process: { env: Record<string, string | undefined> };

const DISRUPTION_TYPE_MAP: Record<string, AisDisruptionType> = {
  gap_spike: 'AIS_DISRUPTION_TYPE_GAP_SPIKE',
  chokepoint_congestion: 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION',
};

const SEVERITY_MAP: Record<string, AisDisruptionSeverity> = {
  low: 'AIS_DISRUPTION_SEVERITY_LOW',
  elevated: 'AIS_DISRUPTION_SEVERITY_ELEVATED',
  high: 'AIS_DISRUPTION_SEVERITY_HIGH',
};

function getRelayBaseUrl(): string | null {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')
    .replace(/\/$/, '');
}

async function fetchVesselSnapshot(): Promise<VesselSnapshot | undefined> {
  try {
    const relayBaseUrl = getRelayBaseUrl();
    if (!relayBaseUrl) return undefined;

    const response = await fetch(`${relayBaseUrl}/ais/snapshot?candidates=false`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return undefined;

    const data = await response.json();
    if (!data || !Array.isArray(data.disruptions) || !Array.isArray(data.density)) {
      return undefined;
    }

    return {
      snapshotAt: Date.now(),
      densityZones: data.density.map((z: any): AisDensityZone => ({
        id: z.id || '',
        name: z.name || '',
        location: { latitude: Number(z.lat) || 0, longitude: Number(z.lon) || 0 },
        intensity: Number(z.intensity) || 0,
        deltaPct: Number(z.deltaPct) || 0,
        shipsPerDay: Number(z.shipsPerDay) || 0,
        note: z.note || '',
      })),
      disruptions: data.disruptions.map((d: any): AisDisruption => ({
        id: d.id || '',
        name: d.name || '',
        type: DISRUPTION_TYPE_MAP[d.type] || 'AIS_DISRUPTION_TYPE_UNSPECIFIED',
        location: { latitude: Number(d.lat) || 0, longitude: Number(d.lon) || 0 },
        severity: SEVERITY_MAP[d.severity] || 'AIS_DISRUPTION_SEVERITY_UNSPECIFIED',
        changePct: Number(d.changePct) || 0,
        windowHours: Number(d.windowHours) || 0,
        darkShips: Number(d.darkShips) || 0,
        vesselCount: Number(d.vesselCount) || 0,
        region: d.region || '',
        description: d.description || '',
      })),
    };
  } catch {
    return undefined;
  }
}
```

### Handler: listNavigationalWarnings RPC (porting from `api/nga-warnings.js`)
```typescript
// Source: api/nga-warnings.js
// NGA MSI API is simple public proxy with no auth

const NGA_WARNINGS_URL = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';

async function fetchNgaWarnings(area?: string): Promise<NavigationalWarning[]> {
  try {
    const response = await fetch(NGA_WARNINGS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const data = await response.json();
    const warnings: any[] = Array.isArray(data) ? data : (data?.broadcast_warn ?? []);

    let mapped = warnings.map((w: any): NavigationalWarning => ({
      id: `${w.navArea || ''}-${w.msgYear || ''}-${w.msgNumber || ''}`,
      title: `NAVAREA ${w.navArea || ''} ${w.msgNumber || ''}/${w.msgYear || ''}`,
      text: w.text || '',
      area: `${w.navArea || ''}${w.subregion ? ' ' + w.subregion : ''}`,
      location: undefined, // NGA warnings don't always have parseable coordinates
      issuedAt: parseNgaDate(w.issueDate),
      expiresAt: 0,
      authority: w.authority || '',
    }));

    // Filter by area if requested
    if (area) {
      const areaLower = area.toLowerCase();
      mapped = mapped.filter(w =>
        w.area.toLowerCase().includes(areaLower) ||
        w.text.toLowerCase().includes(areaLower)
      );
    }

    return mapped;
  } catch {
    return [];
  }
}

function parseNgaDate(dateStr: unknown): number {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  // Format: "081653Z MAY 2024"
  const match = dateStr.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!match) return Date.parse(dateStr) || 0;
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const day = parseInt(match[1], 10);
  const hours = parseInt(match[2].slice(0, 2), 10);
  const minutes = parseInt(match[2].slice(2, 4), 10);
  const month = months[match[3].toUpperCase()] ?? 0;
  const year = parseInt(match[4], 10);
  return Date.UTC(year, month, day, hours, minutes);
}
```

### Service Module: Adapter Functions (for Plan 02)
```typescript
// Source: src/services/maritime/index.ts
import {
  MaritimeServiceClient,
  type VesselSnapshot as ProtoSnapshot,
  type AisDensityZone as ProtoDensityZone,
  type AisDisruption as ProtoDisruption,
  type GetVesselSnapshotResponse,
} from '@/generated/client/worldmonitor/maritime/v1/service_client';
import type { AisDisruptionEvent, AisDensityZone, AisDisruptionType } from '@/types';
import { createCircuitBreaker } from '@/utils';

// Map proto AisDisruption -> legacy AisDisruptionEvent
const DISRUPTION_TYPE_REVERSE: Record<string, AisDisruptionType> = {
  AIS_DISRUPTION_TYPE_GAP_SPIKE: 'gap_spike',
  AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION: 'chokepoint_congestion',
};

function toDisruptionEvent(proto: ProtoDisruption): AisDisruptionEvent {
  return {
    id: proto.id,
    name: proto.name,
    type: DISRUPTION_TYPE_REVERSE[proto.type] || 'gap_spike',
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    severity: proto.severity === 'AIS_DISRUPTION_SEVERITY_HIGH' ? 'high'
      : proto.severity === 'AIS_DISRUPTION_SEVERITY_ELEVATED' ? 'elevated' : 'low',
    changePct: proto.changePct,
    windowHours: proto.windowHours,
    darkShips: proto.darkShips,
    vesselCount: proto.vesselCount,
    region: proto.region,
    description: proto.description,
  };
}

// Map proto AisDensityZone -> legacy AisDensityZone
function toDensityZone(proto: ProtoDensityZone): AisDensityZone {
  return {
    id: proto.id,
    name: proto.name,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    intensity: proto.intensity,
    deltaPct: proto.deltaPct,
    shipsPerDay: proto.shipsPerDay,
    note: proto.note,
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Legacy Vercel edge functions (api/ais-snapshot.js, api/nga-warnings.js) with Redis+memory caching | Sebuf-generated routes with proto-typed handler | Phase 2L | Proto typing, consistent error handling, sidecar compatibility |
| Client-side multi-strategy fetch (Railway/Vercel/localhost) in `src/services/ais.ts` | Service module wraps `MaritimeServiceClient` for snapshot data; polling/callback architecture preserved | Phase 2L | Unified endpoint (proto RPC), but polling logic unchanged |
| Direct `/api/nga-warnings` fetch in `cable-activity.ts` | (TBD -- see Open Question 1) | Phase 2L | Must be addressed to avoid breaking cable advisories |
| Two separate legacy files (ais.ts + cable-activity.ts NGA fetch) | Single maritime service module | Phase 2L | Consolidated module with cleaner imports |

**Deprecated/outdated:**
- `api/ais-snapshot.js` -- replaced by `getVesselSnapshot` RPC handler
- `api/nga-warnings.js` -- replaced by `listNavigationalWarnings` RPC handler
- `src/services/ais.ts` -- replaced by `src/services/maritime/index.ts`

## Open Questions

1. **Cable Activity NGA Data Shape Mismatch**
   - What we know: `src/services/cable-activity.ts` fetches raw NGA warnings from `/api/nga-warnings` and needs the raw `NgaWarning` shape with `navArea`, `msgYear`, `msgNumber`, `subregion`, `text`, `issueDate`, `authority`. The proto `NavigationalWarning` shape loses `navArea`, `msgYear`, `msgNumber` as separate fields (they are merged into `id` and `title`). The `issueDate` raw string (e.g., `"081653Z MAY 2024"`) is converted to epoch ms `issuedAt`.
   - What's unclear: How should `cable-activity.ts` get the data it needs after the legacy endpoint is deleted?
   - Recommendation: **Option A (Recommended): Encode the raw fields into proto fields.** The `id` field can be `"NAVAREA_IV-2024-42"` (parseable), `area` can include navArea and subregion, and `authority` stays. The `cable-activity.ts` processing code would need updating to parse from proto shape, but it's straightforward: extract navArea from `area.split(' ')[0]`, parse msgYear/msgNumber from `id.split('-')`, etc. This keeps everything through the proto path.
   - **Option B: Have `cable-activity.ts` call the maritime service's `listNavigationalWarnings` and adapt.** The processing code would parse what it needs from the proto `NavigationalWarning` fields.
   - **Option C: Keep `cable-activity.ts` fetching directly from the NGA URL** (not through the handler). This avoids the shape mismatch but means cable-activity has its own fetch path outside the proto system. This is the simplest but least unified approach. Since `cable-activity.ts` is client-side code, it can't directly fetch from `msi.nga.mil` (CORS). So this option requires keeping the `/api/nga-warnings` legacy endpoint alive OR adding a new raw proxy.
   - **Best approach: Option A.** Encode enough information in the proto `NavigationalWarning` fields (specifically the `id` format and `area` format) so that `cable-activity.ts` can parse what it needs. Update `cable-activity.ts` to call `MaritimeServiceClient.listNavigationalWarnings()` and extract navArea/msgYear/msgNumber from the returned fields.

2. **VesselSnapshot `candidateReports` Not in Proto**
   - What we know: The legacy AIS snapshot response includes `candidateReports: SnapshotCandidateReport[]` which contains individual vessel position updates (MMSI, lat, lon, heading, speed, course). These are consumed by the callback system (`registerAisCallback`) for live vessel position tracking, used by `military-vessels.ts` for military vessel identification. The proto `VesselSnapshot` has only `densityZones` and `disruptions` -- no individual vessel data.
   - What's unclear: How should the service module get candidateReports after migration?
   - Recommendation: **The service module should use a HYBRID approach.** For density/disruption data (the `fetchAisSignals` use case), use the proto RPC `MaritimeServiceClient.getVesselSnapshot()`. For candidate reports (the `registerAisCallback` use case), continue fetching the raw WS relay HTTP endpoint directly (same multi-strategy approach as before). This is because:
     1. Adding candidateReports to the proto would bloat the snapshot response for all consumers
     2. CandidateReports are only needed when callbacks are registered (military vessel tracking)
     3. The raw endpoint is already optimized for this use case
     4. The `?candidates=true/false` query param on the raw endpoint controls inclusion
   - The service module `pollSnapshot()` function would be updated to: (a) always call the proto RPC for density/disruptions, (b) when `shouldIncludeCandidates()` is true, ALSO fetch the raw relay endpoint for candidateReports, OR (c) fetch the raw relay endpoint for everything when candidates are needed (simpler, but bypasses proto for the full response).
   - **Simplest correct approach (Option C):** The service module's `pollSnapshot()` fetches from the raw WS relay endpoint when candidates are needed (preserving existing multi-strategy fetch), and fetches via the proto RPC when candidates are not needed. The proto RPC path gives type safety for the common snapshot use case; the raw path preserves military vessel tracking.

3. **Multi-Strategy Fetch in Service Module vs Handler**
   - What we know: The legacy `src/services/ais.ts` has a 3-tier fetch strategy: Railway direct -> Vercel API -> localhost fallback. The handler runs server-side and proxies the WS relay. The service module runs client-side.
   - What's unclear: Does the multi-strategy fetch still make sense when the service module calls the proto RPC?
   - Recommendation: **The multi-strategy fetch becomes unnecessary for the proto path.** The client service module calls `MaritimeServiceClient.getVesselSnapshot()` which hits the local proto endpoint (`/api/maritime/v1/get-vessel-snapshot`), and the HANDLER proxies the WS relay. The Railway-direct and localhost-fallback strategies were workarounds for when the Vercel API was the only path. After migration, the proto RPC is the single path, and the handler handles the upstream fetch. However, for the candidateReports use case (Open Question 2), the raw multi-strategy fetch may still be needed.

4. **`desktop-readiness.ts` References**
   - What we know: `src/services/desktop-readiness.ts` line 71 references `'src/services/ais.ts'` and line 72 references `'/api/ais-snapshot'`. These are string literals in a configuration array, not imports.
   - What's unclear: Should these be updated to the new paths?
   - Recommendation: **Yes, update the string literals** to reflect the new file paths (`'src/services/maritime/index.ts'` and the new RPC path `/api/maritime/v1/get-vessel-snapshot`). This is a non-breaking cosmetic change but keeps the desktop readiness inventory accurate.

## Sources

### Primary (HIGH confidence)
- `proto/worldmonitor/maritime/v1/service.proto` -- Maritime service definition with 2 RPCs, HTTP annotations
- `proto/worldmonitor/maritime/v1/vessel_snapshot.proto` -- VesselSnapshot, AisDensityZone, AisDisruption, NavigationalWarning messages + enums
- `proto/worldmonitor/maritime/v1/get_vessel_snapshot.proto` -- Request with optional BoundingBox, response with snapshot
- `proto/worldmonitor/maritime/v1/list_navigational_warnings.proto` -- Request with pagination + area filter, response with warnings array
- `src/generated/server/worldmonitor/maritime/v1/service_server.ts` -- Generated MaritimeServiceHandler interface, route creator, types
- `src/generated/client/worldmonitor/maritime/v1/service_client.ts` -- Generated MaritimeServiceClient class
- `api/ais-snapshot.js` -- Legacy AIS snapshot proxy (WS relay, Redis+memory+stale caching, in-flight dedup)
- `api/nga-warnings.js` -- Legacy NGA warnings proxy (simple pass-through to msi.nga.mil)
- `src/services/ais.ts` -- Legacy AIS client (multi-strategy fetch, polling, callback system, AisPositionData)
- `src/services/cable-activity.ts` -- NGA warnings consumer (fetches from `/api/nga-warnings`, processes cable-related warnings)
- `src/services/military-vessels.ts` -- AIS callback consumer (imports registerAisCallback, unregisterAisCallback, isAisConfigured, initAisStream)
- `src/services/index.ts` -- Services barrel (`export * from './ais'`, `export * from './cable-activity'`)
- `src/App.ts` -- Primary consumer (imports fetchAisSignals, initAisStream, getAisStatus, disconnectAisStream, isAisConfigured, fetchCableActivity from @/services)
- `src/types/index.ts` -- AisDisruptionEvent, AisDensityZone, AisDisruptionType types (used by map components)
- `src/services/signal-aggregator.ts` -- Consumer of AisDisruptionEvent (ingestAisDisruptions method)
- `src/components/DeckGLMap.ts`, `MapContainer.ts`, `Map.ts`, `MapPopup.ts` -- Map consumers of AisDisruptionEvent, AisDensityZone
- `api/[[...path]].ts` -- Gateway catch-all (where to add maritime routes)
- `.planning/phases/2K-conflict-migration/2K-RESEARCH.md` -- Reference research for pattern (3-RPC handler)
- `.planning/phases/2K-conflict-migration/2K-01-PLAN.md` -- Reference plan for handler + gateway pattern
- `.planning/phases/2K-conflict-migration/2K-02-PLAN.md` -- Reference plan for service module + consumer rewiring pattern
- `src/services/conflict/index.ts` -- Reference service module (most recent, port/adapter pattern)
- `api/server/worldmonitor/conflict/v1/handler.ts` -- Reference handler (most recent)
- `api/_upstash-cache.js` -- Shared caching infrastructure (used by legacy ais-snapshot.js but NOT needed for new handler)
- `api/_cache-telemetry.js` -- Cache telemetry (used by legacy ais-snapshot.js but NOT needed for new handler)
- `src/services/desktop-readiness.ts` -- Desktop parity feature list (references ais.ts and /api/ais-snapshot)

### Secondary (MEDIUM confidence)
- `src/e2e/map-harness.ts` -- E2E test consumer of AisDisruptionEvent, AisDensityZone (must continue to work)

### Tertiary (LOW confidence)
- (none)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies, all infrastructure exists and is well-documented by 9 prior migration phases
- Architecture: HIGH - 2-RPC handler + service module follows established pattern; proto definitions are complete and generated code exists. The complexity lies in the polling/callback preservation and candidateReports gap (Open Question 2), both of which have clear resolution paths.
- Pitfalls: HIGH - All pitfalls identified from direct codebase analysis (enum double-mapping, GeoCoordinates flattening, candidateReports gap, cable-activity shape mismatch, import chain updates)

**Research date:** 2026-02-19
**Valid until:** 2026-03-19 (stable -- WS relay and NGA MSI API are long-lived data sources)
