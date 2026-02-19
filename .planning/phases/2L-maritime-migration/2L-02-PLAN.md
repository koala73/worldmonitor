---
phase: 2L-maritime-migration
plan: 02
type: execute
wave: 2
depends_on:
  - 2L-01
files_modified:
  - src/services/maritime/index.ts
  - src/services/cable-activity.ts
  - src/services/military-vessels.ts
  - src/services/index.ts
  - src/services/desktop-readiness.ts
  - api/ais-snapshot.js
  - api/nga-warnings.js
  - src/services/ais.ts
autonomous: true
requirements:
  - DOMAIN-06
  - SERVER-02

must_haves:
  truths:
    - "Service module exports fetchAisSignals returning { disruptions: AisDisruptionEvent[]; density: AisDensityZone[] } matching legacy ais.ts signature"
    - "Service module exports initAisStream, disconnectAisStream, getAisStatus, isAisConfigured with same signatures as legacy ais.ts"
    - "Service module exports registerAisCallback, unregisterAisCallback, AisPositionData for military-vessels.ts consumption"
    - "Polling architecture preserved: 10-second interval, in-flight dedup, stale detection, sequence-based candidate emission"
    - "Hybrid fetch: when no callbacks registered, pollSnapshot uses MaritimeServiceClient.getVesselSnapshot() proto RPC; when callbacks registered (candidates needed), pollSnapshot fetches raw WS relay HTTP endpoint directly to get candidateReports"
    - "Proto AisDisruption mapped to legacy AisDisruptionEvent (type enum reversed: AIS_DISRUPTION_TYPE_GAP_SPIKE -> gap_spike, location.latitude -> lat)"
    - "Proto AisDensityZone mapped to legacy AisDensityZone (location.latitude -> lat, location.longitude -> lon)"
    - "cable-activity.ts updated to fetch NGA warnings via MaritimeServiceClient.listNavigationalWarnings() instead of legacy /api/nga-warnings endpoint"
    - "cable-activity.ts NgaWarning shape reconstructed from proto NavigationalWarning by parsing id (navArea-year-number) and area (navArea subregion)"
    - "military-vessels.ts imports updated from './ais' to './maritime'"
    - "Services barrel updated from 'export * from ./ais' to 'export * from ./maritime'"
    - "desktop-readiness.ts references updated to new paths"
    - "Legacy files deleted: api/ais-snapshot.js, api/nga-warnings.js, src/services/ais.ts"
    - "AisDisruptionEvent, AisDensityZone, AisDisruptionType types preserved in src/types/index.ts (used by map components + signal-aggregator)"
  artifacts:
    - path: "src/services/maritime/index.ts"
      provides: "Port/adapter service module with polling/callback architecture, proto-to-legacy type mapping, hybrid fetch strategy"
      exports: ["fetchAisSignals", "initAisStream", "disconnectAisStream", "getAisStatus", "isAisConfigured", "registerAisCallback", "unregisterAisCallback", "AisPositionData"]
    - path: "src/services/cable-activity.ts"
      provides: "Updated cable activity service fetching NGA warnings via proto RPC"
      exports: ["fetchCableActivity"]
  key_links:
    - from: "src/services/maritime/index.ts"
      to: "src/generated/client/worldmonitor/maritime/v1/service_client.ts"
      via: "import MaritimeServiceClient for proto RPC path"
      pattern: "MaritimeServiceClient"
    - from: "src/services/maritime/index.ts"
      to: "@/types"
      via: "import AisDisruptionEvent, AisDensityZone, AisDisruptionType for legacy type mapping"
      pattern: "from '@/types'"
    - from: "src/services/cable-activity.ts"
      to: "src/generated/client/worldmonitor/maritime/v1/service_client.ts"
      via: "import MaritimeServiceClient for NGA warning fetch"
      pattern: "MaritimeServiceClient"
    - from: "src/services/military-vessels.ts"
      to: "src/services/maritime/index.ts"
      via: "import registerAisCallback, unregisterAisCallback, isAisConfigured, initAisStream, AisPositionData"
      pattern: "from.*'\\./maritime'"
    - from: "src/services/index.ts"
      to: "src/services/maritime/index.ts"
      via: "barrel re-export"
      pattern: "export.*from.*'\\./maritime'"
---

<objective>
Create the maritime service module (port/adapter) preserving the full polling/callback architecture from legacy ais.ts, update cable-activity.ts to fetch NGA warnings via proto RPC, rewire all consumer imports, and delete legacy files.

Purpose: Complete the maritime domain migration by providing a service module that:
1. Preserves the complex client-side AIS polling/callback system (initAisStream, registerAisCallback, fetchAisSignals, etc.) that App.ts and military-vessels.ts depend on
2. Uses a HYBRID fetch strategy: proto RPC for snapshot data (density/disruptions) when no callbacks, raw WS relay HTTP for candidateReports when callbacks are registered (because proto VesselSnapshot lacks candidateReports field)
3. Maps proto types back to legacy AisDisruptionEvent/AisDensityZone shapes for map component consumption
4. Rewires cable-activity.ts to use ListNavigationalWarnings RPC instead of deleted /api/nga-warnings endpoint
5. Updates all consumer imports (military-vessels.ts, barrel, desktop-readiness.ts)

This is the most complex service module in the series due to the stateful polling/callback architecture and the hybrid proto/raw fetch strategy.
Output: Service module at src/services/maritime/index.ts, updated cable-activity.ts, updated consumers, 3 legacy files deleted.
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
@.planning/phases/2L-maritime-migration/2L-01-SUMMARY.md

# Reference service modules (patterns to follow)
@src/services/conflict/index.ts
@src/services/unrest/index.ts

# Generated client (what the service module wraps for proto path)
@src/generated/client/worldmonitor/maritime/v1/service_client.ts

# Legacy service to port logic FROM (then delete)
@src/services/ais.ts

# Legacy types (DO NOT delete AisDisruptionEvent, AisDensityZone, AisDisruptionType from src/types/index.ts)
@src/types/index.ts

# Consumers to rewire
@src/services/cable-activity.ts
@src/services/military-vessels.ts
@src/services/index.ts
@src/services/desktop-readiness.ts

# Legacy API endpoints to delete
@api/ais-snapshot.js
@api/nga-warnings.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create maritime service module with hybrid fetch and polling/callback preservation</name>
  <files>src/services/maritime/index.ts</files>
  <action>
Create `src/services/maritime/index.ts` implementing the port/adapter pattern with the FULL polling/callback architecture from legacy `src/services/ais.ts`.

**Why this is the most complex service module:** Unlike other migrations where the service module is a thin adapter wrapping the generated client, the maritime module must preserve the entire client-side polling and callback system. Additionally, it uses a HYBRID fetch strategy because the proto `VesselSnapshot` lacks `candidateReports` (individual vessel positions needed by military-vessels.ts).

**Imports:**
```typescript
import {
  MaritimeServiceClient,
  type VesselSnapshot as ProtoSnapshot,
  type AisDensityZone as ProtoDensityZone,
  type AisDisruption as ProtoDisruption,
} from '@/generated/client/worldmonitor/maritime/v1/service_client';
import type { AisDisruptionEvent, AisDensityZone, AisDisruptionType } from '@/types';
import { dataFreshness } from './data-freshness';
import { isFeatureAvailable } from './runtime-config';
```

**Client instantiation:**
```typescript
const client = new MaritimeServiceClient('');
```

---

**Proto-to-Legacy Type Mapping** (reverse of handler's enum mapping):

Disruption type reverse map (proto enum -> legacy lowercase):
```typescript
const DISRUPTION_TYPE_REVERSE: Record<string, AisDisruptionType> = {
  AIS_DISRUPTION_TYPE_GAP_SPIKE: 'gap_spike',
  AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION: 'chokepoint_congestion',
};
```

Severity reverse map (proto enum -> legacy lowercase):
```typescript
const SEVERITY_REVERSE: Record<string, 'low' | 'elevated' | 'high'> = {
  AIS_DISRUPTION_SEVERITY_LOW: 'low',
  AIS_DISRUPTION_SEVERITY_ELEVATED: 'elevated',
  AIS_DISRUPTION_SEVERITY_HIGH: 'high',
};
```

**toDisruptionEvent(proto: ProtoDisruption): AisDisruptionEvent** -- Map proto to legacy shape:
- `id`: `proto.id`
- `name`: `proto.name`
- `type`: `DISRUPTION_TYPE_REVERSE[proto.type] || 'gap_spike'`
- `lat`: `proto.location?.latitude ?? 0`
- `lon`: `proto.location?.longitude ?? 0`
- `severity`: `SEVERITY_REVERSE[proto.severity] || 'low'`
- `changePct`: `proto.changePct`
- `windowHours`: `proto.windowHours`
- `darkShips`: `proto.darkShips`
- `vesselCount`: `proto.vesselCount`
- `region`: `proto.region`
- `description`: `proto.description`

**toDensityZone(proto: ProtoDensityZone): AisDensityZone** -- Map proto to legacy shape:
- `id`: `proto.id`
- `name`: `proto.name`
- `lat`: `proto.location?.latitude ?? 0`
- `lon`: `proto.location?.longitude ?? 0`
- `intensity`: `proto.intensity`
- `deltaPct`: `proto.deltaPct`
- `shipsPerDay`: `proto.shipsPerDay`
- `note`: `proto.note`

---

**Port the ENTIRE polling/callback system from `src/services/ais.ts`** (lines 1-289), with these changes:

1. **Feature gating** -- Port exactly as-is:
   ```typescript
   const isClientRuntime = typeof window !== 'undefined';
   const aisConfigured = isClientRuntime && import.meta.env.VITE_ENABLE_AIS !== 'false';

   export function isAisConfigured(): boolean {
     return aisConfigured && isFeatureAvailable('aisRelay');
   }
   ```

2. **AisPositionData interface** -- Port exactly from `src/services/ais.ts` line 26-35. Export it.

3. **All internal state variables** -- Port exactly:
   - `SnapshotStatus`, `SnapshotCandidateReport`, `AisSnapshotResponse` interfaces
   - `AisCallback` type, `positionCallbacks` Set, `lastCallbackTimestampByMmsi` Map
   - `pollInterval`, `inFlight`, `isPolling`, `lastPollAt`, `lastSequence`
   - `latestDisruptions: AisDisruptionEvent[]`, `latestDensity: AisDensityZone[]`, `latestStatus: SnapshotStatus`
   - `shouldIncludeCandidates()`, `parseSnapshot()`, `pruneCallbackTimestampIndex()`, `emitCandidateReports()`
   - Constants: `SNAPSHOT_POLL_INTERVAL_MS`, `SNAPSHOT_STALE_MS`, `CALLBACK_RETENTION_MS`, `MAX_CALLBACK_TRACKED_VESSELS`

4. **HYBRID fetchSnapshotPayload** -- **THIS IS THE KEY CHANGE from legacy.** Replace the old multi-strategy fetch with:

   ```typescript
   async function fetchSnapshotPayload(includeCandidates: boolean): Promise<unknown> {
     if (includeCandidates) {
       // When candidates are needed (military vessel tracking), bypass proto RPC
       // and fetch raw WS relay endpoint directly, because proto VesselSnapshot
       // does NOT have candidateReports field.
       return fetchRawRelaySnapshot(true);
     }

     // When no candidates needed, use proto RPC for type-safe snapshot
     try {
       const response = await client.getVesselSnapshot({});
       if (response.snapshot) {
         // Convert proto snapshot back to the raw format that parseSnapshot() expects
         // This is necessary because the rest of the polling system (parseSnapshot,
         // latestDisruptions, latestDensity) expects the legacy AisDisruptionEvent shape
         return {
           sequence: 0, // Proto doesn't carry sequence; use 0 (safe: no candidates)
           status: { connected: true, vessels: 0, messages: 0 },
           disruptions: response.snapshot.disruptions.map(toDisruptionEvent),
           density: response.snapshot.densityZones.map(toDensityZone),
           candidateReports: [],
         };
       }
       return null;
     } catch {
       // Proto RPC failed, try raw fallback
       return fetchRawRelaySnapshot(false);
     }
   }
   ```

5. **fetchRawRelaySnapshot(includeCandidates: boolean)** -- Port the legacy multi-strategy fetch logic from `src/services/ais.ts` lines 108-127, but simplified:
   - The `wsRelayUrl` from `import.meta.env.VITE_WS_RELAY_URL` is still needed for the raw path. Port the URL conversion and constants:
     ```typescript
     const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
     const RAILWAY_SNAPSHOT_URL = wsRelayUrl
       ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/ais/snapshot'
       : '';
     const LOCAL_SNAPSHOT_FALLBACK = 'http://localhost:3004/ais/snapshot';
     const isLocalhost = isClientRuntime && window.location.hostname === 'localhost';
     ```
   - Try RAILWAY_SNAPSHOT_URL first (if set), then LOCAL_SNAPSHOT_FALLBACK (if localhost).
   - **NOTE: Remove the VERCEL_SNAPSHOT_API ('/api/ais-snapshot') strategy** since that legacy endpoint will be deleted. The proto RPC (`client.getVesselSnapshot()`) is the replacement for the Vercel API path.
   - Return raw JSON payload or throw.

6. **pollSnapshot()** -- Port exactly from `src/services/ais.ts` lines 190-227. No changes needed -- it calls `fetchSnapshotPayload(includeCandidates)` which now uses the hybrid strategy.

7. **All exported functions** -- Port exactly:
   - `startPolling()` (internal)
   - `registerAisCallback(callback)` -- export
   - `unregisterAisCallback(callback)` -- export
   - `initAisStream()` -- export
   - `disconnectAisStream()` -- export
   - `getAisStatus()` -- export
   - `fetchAisSignals()` -- export (returns `{ disruptions: AisDisruptionEvent[]; density: AisDensityZone[] }`)

**Key insight:** The `fetchAisSignals()` function returns `latestDisruptions` and `latestDensity` which are already in `AisDisruptionEvent[]` / `AisDensityZone[]` legacy shape because the hybrid `fetchSnapshotPayload` maps proto types to legacy types before storing them.
  </action>
  <verify>
1. `ls src/services/maritime/index.ts` -- exists
2. `npx tsc --noEmit` -- passes (service module types align with legacy shapes from @/types)
3. Verify exports: `grep -c 'export function\|export interface\|export type' src/services/maritime/index.ts` -- at least 8 exports
  </verify>
  <done>Maritime service module created with full polling/callback architecture, hybrid fetch strategy (proto RPC for snapshot-only, raw relay for candidates), and proto-to-legacy type mapping. Exports fetchAisSignals, initAisStream, disconnectAisStream, getAisStatus, isAisConfigured, registerAisCallback, unregisterAisCallback, AisPositionData. All consumers receive identical type shapes.</done>
</task>

<task type="auto">
  <name>Task 2: Rewire cable-activity, military-vessels, barrel, desktop-readiness, and delete legacy files</name>
  <files>
    src/services/cable-activity.ts
    src/services/military-vessels.ts
    src/services/index.ts
    src/services/desktop-readiness.ts
    api/ais-snapshot.js
    api/nga-warnings.js
    src/services/ais.ts
  </files>
  <action>
**1. Rewire cable-activity.ts to use proto RPC instead of legacy /api/nga-warnings endpoint:**

This is the most significant consumer update in this plan. `cable-activity.ts` currently:
- Fetches from `/api/nga-warnings` (line 20: `const NGA_API_URL = '/api/nga-warnings'`)
- Expects raw `NgaWarning` shape with `msgYear`, `msgNumber`, `navArea`, `subregion`, `text`, `status`, `issueDate`, `authority`
- Processes warnings into cable advisories and repair ships

After migration, it must fetch via the proto client and reconstruct the `NgaWarning` shape from the proto `NavigationalWarning` fields (which encode navArea, msgYear, msgNumber in the `id` and `area` fields per Plan 01's design).

**Changes to cable-activity.ts:**

a. Add import for MaritimeServiceClient:
   ```typescript
   import { MaritimeServiceClient, type NavigationalWarning } from '@/generated/client/worldmonitor/maritime/v1/service_client';
   ```

b. Add client instantiation:
   ```typescript
   const maritimeClient = new MaritimeServiceClient('');
   ```

c. Remove the `NGA_API_URL` constant (line 20: `const NGA_API_URL = '/api/nga-warnings'`).

d. Replace the `fetchCableActivity()` function body. Instead of `fetch(NGA_API_URL, ...)`, call `maritimeClient.listNavigationalWarnings({ area: '' })` to get all warnings. Then convert each proto `NavigationalWarning` back to the `NgaWarning` shape for `processWarnings()`:

   ```typescript
   function protoToNgaWarning(w: NavigationalWarning): NgaWarning {
     // Parse id format: "navArea-msgYear-msgNumber" (e.g., "IV-2024-42")
     const idParts = w.id.split('-');
     const navArea = idParts.length >= 3 ? idParts.slice(0, -2).join('-') : (idParts[0] || '');
     const msgYear = idParts.length >= 2 ? Number(idParts[idParts.length - 2]) || 0 : 0;
     const msgNumber = idParts.length >= 1 ? Number(idParts[idParts.length - 1]) || 0 : 0;

     // Parse area format: "navArea subregion" (e.g., "IV 21")
     const areaParts = w.area.split(' ');
     const subregion = areaParts.length > 1 ? areaParts.slice(1).join(' ') : '';

     return {
       msgYear,
       msgNumber,
       navArea,
       subregion,
       text: w.text,
       status: 'A', // All warnings from the active endpoint have status A
       issueDate: w.issuedAt ? formatNgaDate(w.issuedAt) : '',
       authority: w.authority,
     };
   }

   function formatNgaDate(epochMs: number): string {
     // Reverse of parseNgaDate: convert epoch ms back to "DDHHMMZ MON YYYY"
     // The parseIssueDate function in this file handles parsing this format,
     // so we need to produce it. BUT actually, processWarnings calls parseIssueDate
     // which also handles Date objects. Simpler: just pass a parseable ISO string.
     // Actually, parseIssueDate is called with w.issueDate which is a string.
     // The simplest approach: since we have epoch ms, we can use a Date ISO string
     // which parseIssueDate will handle via its fallback `return new Date()`.
     // BETTER: construct the military date format that parseIssueDate expects.
     if (!epochMs) return '';
     const d = new Date(epochMs);
     const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
     const day = String(d.getUTCDate()).padStart(2, '0');
     const hours = String(d.getUTCHours()).padStart(2, '0');
     const minutes = String(d.getUTCMinutes()).padStart(2, '0');
     const month = months[d.getUTCMonth()] || 'JAN';
     const year = d.getUTCFullYear();
     return `${day}${hours}${minutes}Z ${month} ${year}`;
   }
   ```

   Updated `fetchCableActivity()`:
   ```typescript
   export async function fetchCableActivity(): Promise<CableActivity> {
     try {
       const response = await maritimeClient.listNavigationalWarnings({ area: '' });
       const warnings: NgaWarning[] = response.warnings.map(protoToNgaWarning);
       console.log(`[CableActivity] Fetched ${warnings.length} NGA warnings`);

       const activity = processWarnings(warnings);
       console.log(`[CableActivity] Found ${activity.advisories.length} advisories, ${activity.repairShips.length} repair ships`);

       return activity;
     } catch (error) {
       console.error('[CableActivity] Failed to fetch NGA warnings:', error);
       return { advisories: [], repairShips: [] };
     }
   }
   ```

e. Keep all the processing functions (isCableRelated, parseCoordinates, extractCableshipName, findNearestCable, parseIssueDate, determineSeverity, determineShipStatus, slugify, processWarnings) UNCHANGED. The `processWarnings` function receives `NgaWarning[]` which is now reconstructed from proto.

---

**2. Update military-vessels.ts imports** (line 10-15):

Replace:
```typescript
import {
  registerAisCallback,
  unregisterAisCallback,
  isAisConfigured,
  initAisStream,
  type AisPositionData,
} from './ais';
```

With:
```typescript
import {
  registerAisCallback,
  unregisterAisCallback,
  isAisConfigured,
  initAisStream,
  type AisPositionData,
} from './maritime';
```

**No other changes needed** -- function signatures and types are identical.

---

**3. Update services barrel** (`src/services/index.ts`):

Replace line 15:
```typescript
export * from './ais';
```

With:
```typescript
export * from './maritime';
```

**No other barrel changes needed** -- `export * from './cable-activity'` remains unchanged (cable-activity still exports `fetchCableActivity`).

---

**4. Update desktop-readiness.ts** string references:

In the `DESKTOP_PARITY_FEATURES` array, find the `map-layers-core` entry (around line 71-77):
- Update `serviceFiles`: replace `'src/services/ais.ts'` with `'src/services/maritime/index.ts'`
- Update `apiRoutes`: replace `'/api/ais-snapshot'` with `'/api/maritime/v1/get-vessel-snapshot'`
- Update `apiHandlers`: replace `'api/ais-snapshot.js'` with `'api/server/worldmonitor/maritime/v1/handler.ts'`

These are string literals in a configuration array, not imports. This is a cosmetic update to keep the desktop readiness inventory accurate.

---

**5. Delete legacy API endpoints (2 files):**
- `rm api/ais-snapshot.js`
- `rm api/nga-warnings.js`

**6. Delete legacy service file (1 file):**
- `rm src/services/ais.ts`

---

**7. Scope guards -- DO NOT delete or modify:**
- `src/types/index.ts` -- `AisDisruptionEvent`, `AisDensityZone`, `AisDisruptionType` types MUST remain (used by DeckGLMap.ts, MapContainer.ts, Map.ts, MapPopup.ts, signal-aggregator.ts, e2e/map-harness.ts)
- The `parseIssueDate` function in `cable-activity.ts` MUST remain (still used by `processWarnings`)

---

**8. Verify no other direct imports of deleted files:**
- Grep for `from.*services/ais[^/]` (excluding maritime/), `from.*'./ais'`, `from.*api/ais-snapshot`, `from.*api/nga-warnings` across all `.ts` files.
- If any additional imports found, update them.

---

**Verification:**
- Run `npx tsc --noEmit` to confirm no broken imports anywhere in the project
- Verify `AisDisruptionEvent` still exists in `src/types/index.ts` (scope guard)
- Verify none of the 3 deleted files exist
  </action>
  <verify>
1. `npx tsc --noEmit` -- passes (no broken imports from deletion or import rewiring)
2. `ls api/ais-snapshot.js api/nga-warnings.js src/services/ais.ts 2>&1` -- all "No such file"
3. `grep -c "AisDisruptionEvent" src/types/index.ts` -- > 0 (type preserved)
4. `grep "from.*'\\./maritime'" src/services/military-vessels.ts` -- shows updated import
5. `grep "export.*from.*'\\./maritime'" src/services/index.ts` -- shows updated barrel
6. `grep "MaritimeServiceClient" src/services/cable-activity.ts` -- shows proto client usage
7. `grep "ais-snapshot" src/services/desktop-readiness.ts` -- returns 0 matches (old reference removed)
  </verify>
  <done>cable-activity.ts rewired to fetch NGA warnings via MaritimeServiceClient.listNavigationalWarnings() with NgaWarning shape reconstruction from proto fields. military-vessels.ts imports updated from './ais' to './maritime'. Services barrel updated. desktop-readiness.ts references updated. 3 legacy files deleted (2 API endpoints + 1 service file). AisDisruptionEvent/AisDensityZone/AisDisruptionType preserved in src/types/index.ts for map component consumers. Full project TypeScript compilation passes.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` -- zero errors across entire project
2. Service module exports all 7 functions: fetchAisSignals, initAisStream, disconnectAisStream, getAisStatus, isAisConfigured, registerAisCallback, unregisterAisCallback
3. Service module exports AisPositionData type
4. Proto-to-legacy type mapping covers disruptions (enum + GeoCoordinates flattening) and density (GeoCoordinates flattening)
5. Hybrid fetch: proto RPC when no callbacks, raw relay when callbacks registered
6. cable-activity.ts fetches via MaritimeServiceClient, reconstructs NgaWarning from proto fields
7. military-vessels.ts imports from './maritime' (not './ais')
8. Services barrel re-exports from './maritime' (not './ais')
9. desktop-readiness.ts references updated
10. 3 legacy files deleted (api/ais-snapshot.js, api/nga-warnings.js, src/services/ais.ts)
11. AisDisruptionEvent, AisDensityZone, AisDisruptionType NOT removed from src/types/index.ts (scope guard)
12. No broken imports anywhere in the codebase
</verification>

<success_criteria>
- src/services/maritime/index.ts exports fetchAisSignals, initAisStream, disconnectAisStream, getAisStatus, isAisConfigured, registerAisCallback, unregisterAisCallback, AisPositionData
- Full polling/callback architecture preserved (10s interval, in-flight dedup, stale detection, sequence-based emission)
- Hybrid fetch: proto RPC for snapshot-only (no candidates), raw relay for candidates (military vessel tracking)
- Proto AisDisruption -> legacy AisDisruptionEvent (type enum reversed, location flattened)
- Proto AisDensityZone -> legacy AisDensityZone (location flattened)
- cable-activity.ts uses MaritimeServiceClient.listNavigationalWarnings() instead of /api/nga-warnings
- cable-activity.ts reconstructs NgaWarning from proto NavigationalWarning (id->navArea/msgYear/msgNumber, area->navArea/subregion)
- military-vessels.ts imports from './maritime' with identical function signatures
- Services barrel updated
- desktop-readiness.ts updated
- Legacy files deleted: api/ais-snapshot.js, api/nga-warnings.js, src/services/ais.ts
- AisDisruptionEvent/AisDensityZone/AisDisruptionType preserved in src/types/index.ts
- Full project TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2L-maritime-migration/2L-02-SUMMARY.md`
</output>
