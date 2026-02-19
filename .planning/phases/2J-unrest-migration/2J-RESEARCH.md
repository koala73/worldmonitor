# Phase 2J: Unrest Migration - Research

**Researched:** 2026-02-19
**Domain:** Unrest domain migration to sebuf (ACLED protests/riots/strikes, optional GDELT enrichment) -- handler proxying ACLED API with auth token, event clustering, severity classification, service module with port/adapter pattern, consumer rewiring, legacy endpoint deletion
**Confidence:** HIGH

## Summary

The unrest migration is the 8th domain in the sebuf migration series (2C through 2J). It follows the established 2-plan pattern (Plan 01: handler + gateway wiring; Plan 02: service module + consumer rewiring + legacy deletion) but introduces several unique challenges that make it the most complex consumer rewiring in the series so far.

The unrest domain has TWO legacy API endpoints (`api/acled.js` for protests and `api/acled-conflict.js` for battles/violence) that both proxy the same ACLED API with the same `ACLED_ACCESS_TOKEN`. However, the proto architecture separates these into TWO different services: `UnrestService` (package `worldmonitor.unrest.v1`) for protests/riots/strikes and `ConflictService` (package `worldmonitor.conflict.v1`) for battles/explosions/violence. **This phase (2J) only migrates the unrest/protest side** -- the conflict side belongs to a separate future phase. The handler proxies ACLED for protest-type events (`event_type: 'Protests'`) and optionally enriches with GDELT GEO data (no auth needed). The ACLED auth token is accessed server-side via `process.env.ACLED_ACCESS_TOKEN`.

Critically, unlike the research migration (2I) where all consumers were orphaned, the unrest domain has **heavy active consumer usage**. The `src/services/protests.ts` module is imported by `src/services/index.ts` (barrel export), consumed by `App.ts` (which calls `fetchProtestEvents()` and `getProtestStatus()`), and the `SocialUnrestEvent[]` data flows through `geo-convergence.ts`, `signal-aggregator.ts`, `country-instability.ts`, map components (`Map.ts`, `DeckGLMap.ts`, `MapContainer.ts`, `MapPopup.ts`), and `CIIPanel.ts`. The service module must therefore maintain backward compatibility with the `SocialUnrestEvent` interface from `src/types/index.ts`, mapping proto types (enum strings like `SEVERITY_LEVEL_HIGH`) to legacy types (simple strings like `'high'`).

**Primary recommendation:** Implement a single-RPC handler (`listUnrestEvents`) that proxies ACLED for protest events and optionally merges GDELT GEO data. The handler performs server-side data normalization, event type mapping, severity classification, and deduplication -- all logic currently in `src/services/protests.ts`. The service module wraps the generated `UnrestServiceClient`, maps proto `UnrestEvent` objects to legacy `SocialUnrestEvent` objects, and maintains the existing `fetchProtestEvents()` and `getProtestStatus()` API surface. Consumer rewiring updates `App.ts` and the services barrel to import from the new module. Legacy files `api/acled.js` and `api/gdelt-geo.js` are deleted; `api/acled-conflict.js` is NOT deleted (belongs to conflict domain migration).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-07 | Geopolitical domain proto (ACLED conflicts, UCDP events, GDELT tensions, HAPI humanitarian, UNHCR refugees) with service RPCs and HTTP annotations | The unrest proto files exist and are fully defined (`proto/worldmonitor/unrest/v1/service.proto`, `unrest_event.proto`, `list_unrest_events.proto`). Generated server (`UnrestServiceHandler` with `listUnrestEvents` RPC) and client (`UnrestServiceClient`) code present. The proto covers `UnrestEvent` (id, title, summary, eventType, city, country, region, location, occurredAt, severity, fatalities, sources, sourceType, tags, actors, confidence) and `UnrestCluster` (id, country, region, eventCount, events, severity, startAt, endAt, primaryCause). Handler implementation is the remaining work. Note: This phase covers only the unrest portion of DOMAIN-07; the conflict portion (ACLED battles, UCDP, HAPI) is a separate phase. |
| SERVER-02 | Each domain handler follows the established pattern (handler.ts in api/server/worldmonitor/{domain}/v1/) | Handler must implement `UnrestServiceHandler` with 1 RPC: `listUnrestEvents`. Proxies ACLED API (`https://acleddata.com/api/acled/read`) with `Bearer ${ACLED_ACCESS_TOKEN}` auth. Optionally enriches with GDELT GEO API (`https://api.gdeltproject.org/api/v2/geo/geo`). Returns proto-shaped `ListUnrestEventsResponse` with `events[]` and `clusters[]`. Returns empty on failure (established graceful degradation pattern). |
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
| Server-side GDELT fetch in handler | Keep GDELT as client-side fetch | Moving GDELT to handler is cleaner (single response), but adds latency to the ACLED fetch path. Use `Promise.all` for parallel fetching. |
| Deduplication in handler | Deduplication in service module | Handler-side is better (reduces response payload, client gets clean data) |

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
      unrest/
        v1/
          handler.ts          # Plan 01: UnrestServiceHandler with 1 RPC
  [[...path]].ts              # Plan 01: Mount unrest routes (add import + spread)
  acled.js                    # Plan 02: DELETE (legacy protest proxy)
  gdelt-geo.js                # Plan 02: DELETE (legacy GDELT geo proxy) -- now handled server-side in handler
  acled-conflict.js           # DO NOT DELETE -- belongs to conflict domain migration

src/
  services/
    unrest/
      index.ts                # Plan 02: Port/adapter service module
    protests.ts               # Plan 02: DELETE (legacy service)
  types/
    index.ts                  # Plan 02: Keep SocialUnrestEvent (still used by map components) OR update consumers
```

### Pattern 1: Handler with ACLED Auth Token + GDELT Enrichment
**What:** Single RPC handler that fetches from ACLED API (requires auth) and optionally from GDELT GEO API (no auth), merges and deduplicates results, classifies severity, and returns proto-typed response.
**When to use:** For the `listUnrestEvents` RPC.
**Key insight:** The handler consolidates logic from THREE legacy files: `api/acled.js` (ACLED proxy), `api/gdelt-geo.js` (GDELT proxy), and `src/services/protests.ts` (client-side merging/deduplication). After migration, the client receives ready-to-use data.

```typescript
// api/server/worldmonitor/unrest/v1/handler.ts
import type {
  UnrestServiceHandler,
  ServerContext,
  ListUnrestEventsRequest,
  ListUnrestEventsResponse,
  UnrestEvent,
  UnrestCluster,
  UnrestEventType,
  UnrestSourceType,
  SeverityLevel,
  ConfidenceLevel,
} from '../../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

// ACLED API constants
const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const GDELT_GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';

export const unrestHandler: UnrestServiceHandler = {
  async listUnrestEvents(
    _ctx: ServerContext,
    req: ListUnrestEventsRequest,
  ): Promise<ListUnrestEventsResponse> {
    try {
      const [acledEvents, gdeltEvents] = await Promise.all([
        fetchAcledProtests(req),
        fetchGdeltEvents(),
      ]);
      const merged = deduplicateEvents([...acledEvents, ...gdeltEvents]);
      const sorted = sortBySeverityAndRecency(merged);
      const clusters = clusterEvents(sorted);
      return { events: sorted, clusters, pagination: undefined };
    } catch {
      return { events: [], clusters: [], pagination: undefined };
    }
  },
};
```

### Pattern 2: ACLED API Proxying with Auth Token
**What:** Fetch protest events from ACLED API using server-side `ACLED_ACCESS_TOKEN`. The token is stored as an environment variable (not exposed to client). If token is missing, return empty events (graceful degradation).
**When to use:** In the handler's ACLED fetch helper.
**Critical:** The ACLED API uses `Authorization: Bearer ${token}` header. The event_type filter is `'Protests'` (note: `api/acled-conflict.js` uses `'Battles|Explosions/Remote violence|Violence against civilians'` -- that's the conflict domain, NOT this handler).

```typescript
async function fetchAcledProtests(req: ListUnrestEventsRequest): Promise<UnrestEvent[]> {
  const token = process.env.ACLED_ACCESS_TOKEN;
  if (!token) return []; // Graceful degradation when unconfigured

  const now = Date.now();
  const startMs = req.timeRange?.start ?? (now - 30 * 24 * 60 * 60 * 1000);
  const endMs = req.timeRange?.end ?? now;
  const startDate = new Date(startMs).toISOString().split('T')[0];
  const endDate = new Date(endMs).toISOString().split('T')[0];

  const params = new URLSearchParams({
    event_type: 'Protests',
    event_date: `${startDate}|${endDate}`,
    event_date_where: 'BETWEEN',
    limit: '500',
    _format: 'json',
  });

  // Add country filter if provided
  if (req.country) {
    params.set('country', req.country);
  }

  const response = await fetch(`${ACLED_API_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return [];

  const rawData = await response.json();
  const events = Array.isArray(rawData?.data) ? rawData.data : [];

  return events
    .filter((e: any) => {
      const lat = parseFloat(e.latitude);
      const lon = parseFloat(e.longitude);
      return Number.isFinite(lat) && Number.isFinite(lon) &&
             lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    })
    .map((e: any): UnrestEvent => ({
      id: `acled-${e.event_id_cnty}`,
      title: (e.notes?.slice(0, 200) || `${e.sub_event_type} in ${e.location}`),
      summary: typeof e.notes === 'string' ? e.notes.substring(0, 500) : '',
      eventType: mapAcledEventType(e.event_type, e.sub_event_type),
      city: e.location || '',
      country: e.country || '',
      region: e.admin1 || '',
      location: { latitude: parseFloat(e.latitude), longitude: parseFloat(e.longitude) },
      occurredAt: new Date(e.event_date).getTime(),
      severity: classifySeverity(parseInt(e.fatalities, 10) || 0, e.event_type),
      fatalities: parseInt(e.fatalities, 10) || 0,
      sources: [e.source].filter(Boolean),
      sourceType: 'UNREST_SOURCE_TYPE_ACLED' as UnrestSourceType,
      tags: e.tags?.split(';').map((t: string) => t.trim()).filter(Boolean) ?? [],
      actors: [e.actor1, e.actor2].filter(Boolean),
      confidence: 'CONFIDENCE_LEVEL_HIGH' as ConfidenceLevel,
    }));
}
```

### Pattern 3: GDELT GEO Enrichment (No Auth)
**What:** Fetch protest-related geographic events from GDELT GEO 2.0 API. No authentication needed. This replaces both the legacy `api/gdelt-geo.js` Vercel endpoint and the client-side `fetchGdeltEvents()` in `src/services/protests.ts`.
**When to use:** In the handler as a parallel fetch alongside ACLED.
**Key concern:** GDELT returns GeoJSON `FeatureCollection`. Events are deduplicated by location grid + date before merging with ACLED events.

```typescript
async function fetchGdeltEvents(): Promise<UnrestEvent[]> {
  const params = new URLSearchParams({
    query: 'protest',
    format: 'geojson',
    maxrecords: '250',
    timespan: '7d',
  });

  const response = await fetch(`${GDELT_GEO_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) return [];

  const data = await response.json();
  const features = data?.features || [];
  const seenLocations = new Set<string>();
  const events: UnrestEvent[] = [];

  for (const feature of features) {
    const name = feature.properties?.name || '';
    if (!name || seenLocations.has(name)) continue;

    const count = feature.properties?.count || 1;
    if (count < 5) continue; // Filter noise

    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    seenLocations.add(name);
    const country = name.split(',').pop()?.trim() || name;

    events.push({
      id: `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${Date.now()}`,
      title: `${name} (${count} reports)`,
      summary: '',
      eventType: classifyGdeltEventType(name),
      city: name.split(',')[0]?.trim() || '',
      country,
      region: '',
      location: { latitude: lat, longitude: lon },
      occurredAt: Date.now(),
      severity: classifyGdeltSeverity(count, name),
      fatalities: 0,
      sources: ['GDELT'],
      sourceType: 'UNREST_SOURCE_TYPE_GDELT' as UnrestSourceType,
      tags: [],
      actors: [],
      confidence: count > 20
        ? ('CONFIDENCE_LEVEL_HIGH' as ConfidenceLevel)
        : ('CONFIDENCE_LEVEL_MEDIUM' as ConfidenceLevel),
    });
  }

  return events;
}
```

### Pattern 4: Severity Classification and Event Type Mapping
**What:** Server-side classification logic currently embedded in `src/services/protests.ts`. Must output proto enum string values.
**When to use:** In the handler helper functions.

```typescript
function mapAcledEventType(eventType: string, subEventType: string): UnrestEventType {
  const lower = (eventType + ' ' + subEventType).toLowerCase();
  if (lower.includes('riot') || lower.includes('mob violence'))
    return 'UNREST_EVENT_TYPE_RIOT';
  if (lower.includes('strike'))
    return 'UNREST_EVENT_TYPE_STRIKE';
  if (lower.includes('demonstration'))
    return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  if (lower.includes('protest'))
    return 'UNREST_EVENT_TYPE_PROTEST';
  return 'UNREST_EVENT_TYPE_CIVIL_UNREST';
}

function classifySeverity(fatalities: number, eventType: string): SeverityLevel {
  if (fatalities > 0 || eventType.toLowerCase().includes('riot'))
    return 'SEVERITY_LEVEL_HIGH';
  if (eventType.toLowerCase().includes('protest'))
    return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}
```

### Pattern 5: Service Module with Legacy Type Mapping (Port/Adapter)
**What:** Unlike research (2I) where proto types were clean and consumers orphaned, the unrest service module MUST map proto types to the existing `SocialUnrestEvent` interface because numerous map components, CII, signal aggregator, and App.ts depend on the legacy shape (`lat`/`lon` instead of `location.latitude`/`location.longitude`, `Date` instead of epoch ms, `'high'` instead of `'SEVERITY_LEVEL_HIGH'`, etc.).
**When to use:** Plan 02, service module creation.
**Key insight:** This is the most consumer-heavy migration in the series. The service module is a full adapter, not a thin wrapper.

```typescript
// src/services/unrest/index.ts
import {
  UnrestServiceClient,
  type UnrestEvent,
  type UnrestCluster,
  type ListUnrestEventsResponse,
} from '@/generated/client/worldmonitor/unrest/v1/service_client';
import type { SocialUnrestEvent, ProtestSeverity, ProtestSource, ProtestEventType } from '@/types';
import { createCircuitBreaker } from '@/utils';

const client = new UnrestServiceClient('');
const unrestBreaker = createCircuitBreaker<ListUnrestEventsResponse>({ name: 'Unrest Events' });

// Map proto enums to legacy string types
function mapSeverity(s: string): ProtestSeverity {
  if (s === 'SEVERITY_LEVEL_HIGH') return 'high';
  if (s === 'SEVERITY_LEVEL_MEDIUM') return 'medium';
  return 'low';
}

function mapEventType(t: string): ProtestEventType {
  if (t === 'UNREST_EVENT_TYPE_PROTEST') return 'protest';
  if (t === 'UNREST_EVENT_TYPE_RIOT') return 'riot';
  if (t === 'UNREST_EVENT_TYPE_STRIKE') return 'strike';
  if (t === 'UNREST_EVENT_TYPE_DEMONSTRATION') return 'demonstration';
  return 'civil_unrest';
}

function mapSourceType(s: string): ProtestSource {
  if (s === 'UNREST_SOURCE_TYPE_ACLED') return 'acled';
  if (s === 'UNREST_SOURCE_TYPE_GDELT') return 'gdelt';
  return 'rss';
}

function mapConfidence(c: string): 'high' | 'medium' | 'low' {
  if (c === 'CONFIDENCE_LEVEL_HIGH') return 'high';
  if (c === 'CONFIDENCE_LEVEL_MEDIUM') return 'medium';
  return 'low';
}

function toSocialUnrestEvent(e: UnrestEvent): SocialUnrestEvent {
  return {
    id: e.id,
    title: e.title,
    summary: e.summary || undefined,
    eventType: mapEventType(e.eventType),
    city: e.city || undefined,
    country: e.country,
    region: e.region || undefined,
    lat: e.location?.latitude ?? 0,
    lon: e.location?.longitude ?? 0,
    time: new Date(e.occurredAt),
    severity: mapSeverity(e.severity),
    fatalities: e.fatalities > 0 ? e.fatalities : undefined,
    sources: e.sources,
    sourceType: mapSourceType(e.sourceType),
    tags: e.tags.length > 0 ? e.tags : undefined,
    actors: e.actors.length > 0 ? e.actors : undefined,
    confidence: mapConfidence(e.confidence),
    validated: mapConfidence(e.confidence) === 'high',
  };
}

export interface ProtestData {
  events: SocialUnrestEvent[];
  byCountry: Map<string, SocialUnrestEvent[]>;
  highSeverityCount: number;
  sources: { acled: number; gdelt: number };
}

export async function fetchProtestEvents(): Promise<ProtestData> {
  const resp = await unrestBreaker.execute(async () => {
    return client.listUnrestEvents({
      country: '',
      minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED',
    });
  }, { events: [], clusters: [], pagination: undefined });

  const events = resp.events.map(toSocialUnrestEvent);
  const byCountry = new Map<string, SocialUnrestEvent[]>();
  for (const e of events) {
    const existing = byCountry.get(e.country) || [];
    existing.push(e);
    byCountry.set(e.country, existing);
  }

  return {
    events,
    byCountry,
    highSeverityCount: events.filter(e => e.severity === 'high').length,
    sources: {
      acled: events.filter(e => e.sourceType === 'acled').length,
      gdelt: events.filter(e => e.sourceType === 'gdelt').length,
    },
  };
}

// Track ACLED configuration status (mirrors legacy getProtestStatus)
let acledConfigured: boolean | null = null;

export function getProtestStatus(): { acledConfigured: boolean | null; gdeltAvailable: boolean } {
  return { acledConfigured, gdeltAvailable: true };
}
```

### Anti-Patterns to Avoid
- **Deleting `api/acled-conflict.js`:** This belongs to the conflict domain migration (separate phase), NOT unrest. Only delete `api/acled.js` and `api/gdelt-geo.js`.
- **Breaking the `SocialUnrestEvent` interface:** Many map components, CII, signal aggregator, and geo-convergence depend on `lat`/`lon` as top-level numbers and `time` as a `Date`. The service module MUST map from proto shape to legacy shape.
- **Ignoring `getProtestStatus()`:** `App.ts` calls this at lines 3667, 4017, 4043 to show "ACLED not configured" messages. The new service module must maintain this function.
- **Removing `SocialUnrestEvent` from `src/types/index.ts`:** The type is used by 15+ files including map components, e2e harnesses, and signal aggregator. Keep it as-is; the service module maps to it.
- **Using `generateId()` for GDELT event IDs:** The legacy code imports `generateId` from `@/utils` for GDELT events. The handler runs server-side where this utility may not be available. Use coordinate-based deterministic IDs instead (e.g., `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${timestamp}`).
- **Forgetting INTEL_HOTSPOTS:** The legacy `protests.ts` uses `findNearbyHotspots()` to add `relatedHotspots` to events. This uses the `INTEL_HOTSPOTS` config from `@/config`. The handler runs on the edge and should NOT import client-side config. The `relatedHotspots` field is not in the proto (it was client-side enrichment); it should remain as optional client-side enrichment in the service module if needed, or be dropped (it's used only for display context).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Circuit breaker | Custom retry/timeout | `createCircuitBreaker` from `@/utils` | Established project pattern |
| HTTP client | Raw fetch with error handling | Generated `UnrestServiceClient` (in service module) | Type-safe, handles serialization |
| Event deduplication | New algorithm | Port existing `deduplicateEvents` from `src/services/protests.ts` | Proven logic with grid-based location keys |
| Severity classification | New rules | Port existing `acledSeverity` from `src/services/protests.ts` | Existing business logic |
| Event type mapping | New mapping | Port existing `mapAcledEventType` from `src/services/protests.ts` | Maps ACLED types to proto enum values |

**Key insight:** The handler is primarily a port of existing logic from `api/acled.js` (ACLED fetch + auth), `api/gdelt-geo.js` (GDELT fetch), and `src/services/protests.ts` (merge + deduplicate + classify) into a single server-side handler. Almost all logic is existing code being relocated, not new code being written.

## Common Pitfalls

### Pitfall 1: ACLED Auth Token Access
**What goes wrong:** Handler fails to access `ACLED_ACCESS_TOKEN` because it's not set in the environment or is prefixed with `VITE_`.
**Why it happens:** ACLED token is deliberately NOT prefixed with `VITE_` to keep it server-side only (comment in `api/acled.js` line 2). In the sidecar (Tauri desktop), it's available through `ALLOWED_ENV_KEYS` in `local-api-server.mjs`.
**How to avoid:** Access via `process.env.ACLED_ACCESS_TOKEN`. If missing, return empty events (graceful degradation, matching legacy behavior at `api/acled.js` line 71-80). The handler must NOT throw when token is absent.
**Warning signs:** All protest events come from GDELT only (no ACLED events); `getProtestStatus()` returns `acledConfigured: false`.

### Pitfall 2: Scope Confusion with acled-conflict.js
**What goes wrong:** Developer deletes `api/acled-conflict.js` during this phase, breaking the conflict event flow that `App.ts` and `country-instability.ts` depend on.
**Why it happens:** Both `api/acled.js` (protests) and `api/acled-conflict.js` (conflicts) call the same ACLED API with the same token, just with different `event_type` filters. It's tempting to consolidate them.
**How to avoid:** This phase ONLY handles the unrest (protest) side. The conflict side (`api/acled-conflict.js` -> `src/services/conflicts.ts`) is a separate future migration to `ConflictService` (`worldmonitor.conflict.v1`). Delete only `api/acled.js`, NOT `api/acled-conflict.js`.
**Warning signs:** After migration, `fetchConflictEvents()` in `App.ts` line 3686 throws or returns empty.

### Pitfall 3: SocialUnrestEvent Type Mapping Completeness
**What goes wrong:** Service module maps most fields correctly but misses edge cases like `validated` (boolean derived from confidence), `relatedHotspots` (client-side enrichment), or `imageUrl` (GDELT-only).
**Why it happens:** The proto `UnrestEvent` has different fields than `SocialUnrestEvent`. Fields like `validated`, `relatedHotspots`, `imageUrl`, and `sentiment` exist in the legacy type but not in the proto.
**How to avoid:** Map all proto fields to their legacy equivalents. For fields not in proto:
  - `validated`: derive from confidence (`'high'` -> true, else false)
  - `relatedHotspots`: omit (optional field, was client-side enrichment)
  - `imageUrl`: GDELT can optionally include `shareimage` -- add to handler if feasible, otherwise omit
  - `sentiment`: always undefined (was never populated)
**Warning signs:** Map popup renders missing data; CII calculations produce different scores.

### Pitfall 4: Consumer Rewiring Scope
**What goes wrong:** Updating `src/services/protests.ts` but forgetting to update `src/services/index.ts` barrel export, or breaking imports in files that import directly from `protests.ts` vs from the barrel.
**Why it happens:** The protests service is re-exported via `src/services/index.ts` line 17: `export * from './protests'`. Files import `fetchProtestEvents` either from `@/services` (barrel) or directly from `@/services/protests`. After renaming to `unrest/index.ts`, both paths break.
**How to avoid:**
  1. Create `src/services/unrest/index.ts` with same exported function names (`fetchProtestEvents`, `getProtestStatus`, `ProtestData`)
  2. Update barrel in `src/services/index.ts`: change `export * from './protests'` to `export * from './unrest'`
  3. Update any direct imports (grep for `from.*services/protests`)
  4. Delete `src/services/protests.ts`
**Warning signs:** TypeScript compilation errors about missing module `./protests` or missing exports.

### Pitfall 5: GDELT GEO API Response Format
**What goes wrong:** Handler expects GeoJSON format but receives something else, or misinterprets coordinates as [lat, lon] instead of GeoJSON's [lon, lat].
**Why it happens:** GeoJSON standard uses [longitude, latitude] order (NOT [latitude, longitude]). Easy to swap.
**How to avoid:** Follow the existing pattern in `src/services/protests.ts` line 179: `const [lon, lat] = coords;`. Always destructure as `[lon, lat]` from GeoJSON coordinates.
**Warning signs:** Events appear at wrong locations on the map (swapped lat/lon).

### Pitfall 6: ACLED Configuration Status Tracking
**What goes wrong:** The new service module always reports `acledConfigured: null` because it has no mechanism to learn whether the server-side token exists.
**Why it happens:** In the legacy flow, the client calls `/api/acled` directly and gets `configured: false` in the response when the token is missing. In the sebuf flow, the handler returns empty events when unconfigured, but the client can't distinguish "no events because ACLED is down" from "no events because token is missing."
**How to avoid:** The handler should include a signal in the response when ACLED is unconfigured. Options:
  - Return a specific field or response metadata
  - The service module can infer from response patterns (if no ACLED-sourced events in response, assume unconfigured)
  - Simplest: check if ANY events have `sourceType === 'UNREST_SOURCE_TYPE_ACLED'` -- if none and GDELT events exist, likely unconfigured
**Warning signs:** App.ts always shows "ACLED not configured" or never shows it.

### Pitfall 7: Event Deduplication Logic
**What goes wrong:** Deduplication in the handler produces different results than the legacy client-side deduplication, causing event count discrepancies.
**Why it happens:** The legacy `deduplicateEvents` in `src/services/protests.ts` uses a grid-based approach (0.5 degree grid + date key) and merges sources when events overlap. If the handler uses a different algorithm, counts diverge.
**How to avoid:** Port the exact deduplication algorithm from `src/services/protests.ts` lines 226-258 to the handler. Use the same grid resolution (`Math.round(lat * 2) / 2`) and merge strategy (prefer ACLED, combine sources).
**Warning signs:** Total event count changes significantly after migration.

## Code Examples

### Example 1: ACLED API Response Shape

The raw ACLED API returns JSON with a `data` array:
```json
{
  "success": true,
  "data": [
    {
      "event_id_cnty": "USA12345",
      "event_date": "2024-01-15",
      "event_type": "Protests",
      "sub_event_type": "Peaceful protest",
      "actor1": "Labor Group",
      "actor2": "",
      "country": "United States",
      "admin1": "California",
      "location": "Los Angeles",
      "latitude": "34.0522",
      "longitude": "-118.2437",
      "fatalities": "0",
      "notes": "Hundreds of workers protested outside...",
      "source": "Los Angeles Times",
      "tags": "labor; economic"
    }
  ]
}
```

Note: All numeric fields (`latitude`, `longitude`, `fatalities`) are STRING type in ACLED API responses. Must `parseFloat`/`parseInt`.

### Example 2: GDELT GEO API Response Shape

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [-118.2437, 34.0522]  // [lon, lat] -- GeoJSON order!
      },
      "properties": {
        "name": "Los Angeles, California, United States",
        "count": 47,
        "shareimage": "https://..."
      }
    }
  ]
}
```

### Example 3: Proto Type vs Legacy Type Mapping

| Proto `UnrestEvent` field | Proto value | Legacy `SocialUnrestEvent` field | Legacy value |
|---------------------------|-------------|----------------------------------|--------------|
| `eventType` | `"UNREST_EVENT_TYPE_PROTEST"` | `eventType` | `"protest"` |
| `severity` | `"SEVERITY_LEVEL_HIGH"` | `severity` | `"high"` |
| `sourceType` | `"UNREST_SOURCE_TYPE_ACLED"` | `sourceType` | `"acled"` |
| `confidence` | `"CONFIDENCE_LEVEL_HIGH"` | `confidence` | `"high"` |
| `location.latitude` | `34.0522` | `lat` | `34.0522` |
| `location.longitude` | `-118.2437` | `lon` | `-118.2437` |
| `occurredAt` | `1705276800000` | `time` | `new Date(1705276800000)` |
| `fatalities` | `0` | `fatalities` | `undefined` (0 -> undefined) |
| (not in proto) | - | `validated` | `true` (derived from confidence) |
| (not in proto) | - | `relatedHotspots` | `[]` (was client-side enrichment) |
| (not in proto) | - | `imageUrl` | `undefined` (GDELT shareimage) |
| (not in proto) | - | `sentiment` | `undefined` (never populated) |

### Example 4: Gateway Wiring (api/[[...path]].ts)

```typescript
// Add these imports:
import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server';
import { unrestHandler } from './server/worldmonitor/unrest/v1/handler';

// Add to allRoutes:
const allRoutes = [
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),
  ...createUnrestServiceRoutes(unrestHandler, serverOptions),  // NEW
];
```

## Data Flow Analysis

### Current (Legacy) Flow
```
Browser (App.ts)
  |
  |-- fetchProtestEvents() -- src/services/protests.ts
  |     |
  |     |-- fetchAcledEvents()
  |     |     |-- GET /api/acled ---------> Vercel Edge (api/acled.js)
  |     |     |                              |-- fetch acleddata.com/api/acled/read
  |     |     |                              |   (Bearer ${ACLED_ACCESS_TOKEN})
  |     |     |<-- raw ACLED JSON ----------|
  |     |     |-- parse, validate coords
  |     |     |-- map to SocialUnrestEvent[]
  |     |
  |     |-- fetchGdeltEvents()
  |     |     |-- GET /api/gdelt-geo -----> Vercel Edge (api/gdelt-geo.js)
  |     |     |                              |-- fetch api.gdeltproject.org
  |     |     |<-- GeoJSON FeatureCollection|
  |     |     |-- parse features
  |     |     |-- map to SocialUnrestEvent[]
  |     |
  |     |-- deduplicateEvents(acled + gdelt)
  |     |-- sortEvents()
  |     |-- group byCountry
  |     |-- return ProtestData
  |
  |-- ingestProtests(events) -> geo-convergence
  |-- ingestProtestsForCII(events) -> country-instability
  |-- signalAggregator.ingestProtests(events)
  |-- map.setProtests(events)
  |-- dataFreshness.recordUpdate('acled', count)
```

### Target (Sebuf) Flow
```
Browser (App.ts)
  |
  |-- fetchProtestEvents() -- src/services/unrest/index.ts
  |     |
  |     |-- UnrestServiceClient.listUnrestEvents()
  |     |     |-- POST /api/unrest/v1/list-unrest-events
  |     |     |     |
  |     |     |     |-- Handler (api/server/worldmonitor/unrest/v1/handler.ts)
  |     |     |     |     |-- Promise.all([
  |     |     |     |     |     fetchAcledProtests(req),  // server-side ACLED fetch
  |     |     |     |     |     fetchGdeltEvents(),       // server-side GDELT fetch
  |     |     |     |     |   ])
  |     |     |     |     |-- deduplicateEvents()  // server-side
  |     |     |     |     |-- clusterEvents()      // server-side
  |     |     |     |     |-- return { events, clusters }
  |     |     |     |
  |     |     |<-- JSON { events: UnrestEvent[], clusters: UnrestCluster[] }
  |     |
  |     |-- map UnrestEvent[] -> SocialUnrestEvent[]  (proto -> legacy shape)
  |     |-- group byCountry
  |     |-- return ProtestData
  |
  |-- (same downstream consumers, no changes needed)
  |-- ingestProtests(events) -> geo-convergence
  |-- ingestProtestsForCII(events) -> country-instability
  |-- signalAggregator.ingestProtests(events)
  |-- map.setProtests(events)
  |-- dataFreshness.recordUpdate('acled', count)
```

## Consumer Inventory (for Plan 02 rewiring)

### Direct Consumers of `src/services/protests.ts`
1. **`src/services/index.ts`** line 17: `export * from './protests'` -- barrel re-export. MUST update to `export * from './unrest'`.
2. **`src/App.ts`** line 16: imports `fetchProtestEvents, getProtestStatus` (from barrel `@/services`). No change needed if barrel is updated.

### Consumers of `SocialUnrestEvent` type (from `src/types/index.ts`)
These files import `SocialUnrestEvent` from `@/types` -- **NO CHANGES NEEDED** since the type stays in `src/types/index.ts`:
- `src/components/Map.ts` (line 7, 124, 3404)
- `src/components/DeckGLMap.ts` (line 22, 252, 308, 516, 548, 720, 3254)
- `src/components/MapContainer.ts` (line 19, 219)
- `src/components/MapPopup.ts` (line 1, 98, 122, 380, 899)
- `src/services/geo-convergence.ts` (line 1, 67)
- `src/services/signal-aggregator.ts` (line 11, 190)
- `src/services/country-instability.ts` (line 1, 31, 211)
- `src/e2e/map-harness.ts` (line 44, 717, 749)
- `src/App.ts` (line 1, 3617, 3653)

### Consumers of `fetchProtestEvents` function
- `src/App.ts` lines 3655, 4032 -- calls via barrel import

### Consumers of `getProtestStatus` function
- `src/App.ts` lines 3667, 4017, 4043 -- calls via barrel import

### Consumers of `ProtestData` type
- `src/App.ts` line 3617 (inline type matching) -- uses barrel import indirectly

### Legacy Files to Delete
- `api/acled.js` -- legacy ACLED protest proxy (replaced by handler)
- `api/gdelt-geo.js` -- legacy GDELT GEO proxy (replaced by handler's server-side GDELT fetch)
- `src/services/protests.ts` -- legacy service module (replaced by `src/services/unrest/index.ts`)

### Legacy Files to NOT Delete
- `api/acled-conflict.js` -- belongs to conflict domain migration (separate phase)
- `src/services/conflicts.ts` -- belongs to conflict domain migration
- `src/types/index.ts` (`SocialUnrestEvent`, `ProtestSeverity`, `ProtestEventType`, `ProtestCluster`) -- still needed by 15+ consumers

### Config/Feature Flag Entries
- `src/services/runtime-config.ts` line 30: `acledConflicts` feature flag -- covers both protests AND conflicts. Do NOT remove; still needed for conflict domain.
- `src/services/runtime-config.ts` line 117-122: `acledConflicts` feature definition with `requiredSecrets: ['ACLED_ACCESS_TOKEN']` -- keep; still needed.
- `src/services/data-freshness.ts` lines 10, 68: `acled` data source tracking -- keep; the new service module should still record freshness.
- `src/services/desktop-readiness.ts` line 72: includes `/api/acled-conflict` in API routes -- references the conflict endpoint, NOT the protest endpoint. Keep.

### Services Barrel Export Update
- `src/services/index.ts` line 17: Change `export * from './protests'` to `export * from './unrest'`

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Client-side dual fetch (ACLED proxy + GDELT proxy) with client-side merge | Server-side dual fetch with server-side merge in handler | This migration | Single POST request gets merged, deduplicated data; reduced client complexity |
| Raw JSON proxy endpoints (`api/acled.js`, `api/gdelt-geo.js`) | Proto-typed JSON endpoint (`/api/unrest/v1/list-unrest-events`) | This migration | Type-safe, consistent error handling, graceful degradation |
| Client-side severity classification and event type mapping | Server-side classification in handler | This migration | Classification logic runs once on server, not on every client |
| Client-side deduplication | Server-side deduplication in handler | This migration | Reduced payload size, cleaner client code |
| Separate protest and GDELT data flows | Combined unrest data flow with proto clusters | This migration | Response includes both events and clusters |

## Open Questions

1. **ACLED configuration status signaling**
   - What we know: Legacy flow returns `{ configured: false }` from `api/acled.js` when `ACLED_ACCESS_TOKEN` is missing. The client-side `protests.ts` tracks this in `acledConfigured` state.
   - What's unclear: How the new handler signals "unconfigured" vs "no events found" since it returns proto-typed responses without a `configured` field.
   - Recommendation: The service module can infer ACLED configuration status from the response: if the response has GDELT events but zero ACLED events, set `acledConfigured = false`. If response has ACLED events, set `acledConfigured = true`. If response is completely empty, leave as `null`. This heuristic matches the legacy behavior in practice.

2. **Event clustering in handler**
   - What we know: The proto response includes `clusters: UnrestCluster[]`. The legacy flow has no server-side clustering (clustering is only for news, via `src/services/clustering.ts`).
   - What's unclear: Whether the handler should implement geographic clustering or return empty clusters.
   - Recommendation: Start with empty clusters (`clusters: []`). The proto definition supports them for future use. The map components already handle clustering via Supercluster on the client side (`DeckGLMap.ts` line 548: `rebuildProtestSupercluster`). Adding server-side clustering is a future enhancement.

3. **`relatedHotspots` enrichment**
   - What we know: The legacy `protests.ts` calls `findNearbyHotspots(lat, lon)` using `INTEL_HOTSPOTS` from `@/config` to add context about nearby intelligence hotspots. This field is NOT in the proto.
   - What's unclear: Whether any consumer actually uses `relatedHotspots` for display or logic.
   - Recommendation: Drop `relatedHotspots` from the service module mapping (set to `undefined`). The field is optional on `SocialUnrestEvent`. If consumers need it, it can be added back as client-side enrichment in the service module (import `INTEL_HOTSPOTS` there, compute haversine distance). But this is low priority -- no evidence of active UI display of this field.

4. **GDELT `shareimage` for `imageUrl`**
   - What we know: GDELT GEO features include `properties.shareimage` (URL to a thumbnail). The legacy `protests.ts` maps this to `imageUrl` on `SocialUnrestEvent`.
   - What's unclear: Whether to forward this through the proto (no field for it) or handle in service module.
   - Recommendation: The handler can include the shareimage URL in the `summary` field or a `tags` entry as a workaround. Alternatively, drop `imageUrl` (it's optional and likely unused in map popups). Simplest approach: omit for now, add proto field later if needed.

5. **GDELT event IDs**
   - What we know: Legacy `protests.ts` uses `generateId()` from `@/utils` to create unique IDs for GDELT events. The handler runs server-side where this utility may not be available.
   - What's unclear: Whether `generateId()` works in edge runtime (it uses `crypto.randomUUID()` or similar).
   - Recommendation: Use coordinate-based deterministic IDs in the handler: `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${Date.now()}`. This is deterministic enough for deduplication and doesn't depend on client utilities.

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** -- All source files examined directly:
  - `api/acled.js` (legacy protest ACLED proxy, 200 lines)
  - `api/acled-conflict.js` (legacy conflict ACLED proxy -- NOT in scope, but examined for scope boundary)
  - `api/gdelt-geo.js` (legacy GDELT GEO proxy, 86 lines)
  - `src/services/protests.ts` (legacy service module, 323 lines, 11 functions)
  - `src/services/conflicts.ts` (legacy conflict service -- NOT in scope, but examined for scope boundary)
  - `proto/worldmonitor/unrest/v1/service.proto` (1 RPC)
  - `proto/worldmonitor/unrest/v1/unrest_event.proto` (UnrestEvent, UnrestCluster, enums)
  - `proto/worldmonitor/unrest/v1/list_unrest_events.proto` (request/response)
  - `proto/worldmonitor/conflict/v1/service.proto` (separate service -- scope boundary)
  - `src/generated/server/worldmonitor/unrest/v1/service_server.ts` (UnrestServiceHandler)
  - `src/generated/client/worldmonitor/unrest/v1/service_client.ts` (UnrestServiceClient)
  - `api/[[...path]].ts` (catch-all gateway, 83 lines)
  - `api/server/router.ts` (Map-based route matcher)
  - `api/server/worldmonitor/research/v1/handler.ts` (reference: most recent handler)
  - `src/services/research/index.ts` (reference: most recent service module)
  - `src/services/index.ts` (barrel export)
  - `src/types/index.ts` (SocialUnrestEvent, ProtestSeverity, ProtestEventType, ProtestCluster)
  - `src/App.ts` (primary consumer: lines 3653-3674, 4014-4051)
  - `src/services/geo-convergence.ts` (ingestProtests)
  - `src/services/signal-aggregator.ts` (ingestProtests)
  - `src/services/country-instability.ts` (ingestProtestsForCII)
  - `src/services/data-freshness.ts` (acled/gdelt tracking)
  - `src/services/runtime-config.ts` (acledConflicts feature flag)
  - `src/services/desktop-readiness.ts` (API route list)
  - `vite.config.ts` (dev proxy config for /api/acled and /api/gdelt-geo)
  - `vercel.json` (no rewrites for ACLED/GDELT)
  - `src-tauri/sidecar/local-api-server.mjs` (ACLED token verification)
  - `scripts/build-sidecar-sebuf.mjs` (esbuild bundle for sidecar)
  - `.planning/phases/2I-research-migration/2I-RESEARCH.md` (reference: prior migration research)
  - `.planning/phases/2I-research-migration/2I-01-PLAN.md` (reference: handler plan)
  - `.planning/phases/2I-research-migration/2I-02-PLAN.md` (reference: service module plan)

### Secondary (MEDIUM confidence)
- ACLED API format -- inferred from `api/acled.js` code and response handling
- GDELT GEO API format -- inferred from `api/gdelt-geo.js` code and `src/services/protests.ts` parsing

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies; all infrastructure exists in the project
- Architecture: HIGH -- follows established 2-plan migration pattern from 7 prior domains (2C-2I); identical handler/gateway/service-module structure
- Pitfalls: HIGH -- pitfalls identified from direct code analysis of legacy code, consumer inventory, and proto-to-legacy type mapping analysis; ACLED auth handling verified in 3 locations (api/acled.js, sidecar, runtime-config)
- Consumer rewiring: HIGH -- comprehensive grep of all 55 files referencing protests/acled/unrest; complete consumer inventory with line numbers; clear mapping between proto and legacy types

**Research date:** 2026-02-19
**Valid until:** 2026-03-19 (stable domain, no fast-moving dependencies)
