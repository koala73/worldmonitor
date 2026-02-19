---
phase: 2J-unrest-migration
plan: 02
type: execute
wave: 2
depends_on:
  - 2J-01
files_modified:
  - src/services/unrest/index.ts
  - src/services/index.ts
  - api/acled.js
  - api/gdelt-geo.js
  - src/services/protests.ts
autonomous: true
requirements:
  - DOMAIN-07
  - SERVER-02

must_haves:
  truths:
    - "Service module exports fetchProtestEvents and getProtestStatus with same API surface as legacy protests.ts"
    - "fetchProtestEvents returns ProtestData with events (SocialUnrestEvent[]), byCountry, highSeverityCount, sources"
    - "Proto UnrestEvent fields mapped to legacy SocialUnrestEvent shape (location.latitude->lat, occurredAt->Date, SEVERITY_LEVEL_HIGH->'high', etc.)"
    - "getProtestStatus infers ACLED configuration from response events (ACLED-sourced events present = configured)"
    - "Services barrel re-exports from './unrest' instead of './protests'"
    - "Legacy files deleted: api/acled.js, api/gdelt-geo.js, src/services/protests.ts"
    - "api/acled-conflict.js is NOT deleted (belongs to conflict domain migration)"
  artifacts:
    - path: "src/services/unrest/index.ts"
      provides: "Port/adapter service module mapping proto UnrestEvent to legacy SocialUnrestEvent"
      exports: ["fetchProtestEvents", "getProtestStatus", "ProtestData"]
    - path: "src/services/index.ts"
      provides: "Updated barrel export with unrest replacing protests"
      contains: "export * from './unrest'"
  key_links:
    - from: "src/services/unrest/index.ts"
      to: "src/generated/client/worldmonitor/unrest/v1/service_client.ts"
      via: "import UnrestServiceClient"
      pattern: "UnrestServiceClient"
    - from: "src/services/unrest/index.ts"
      to: "@/utils"
      via: "import createCircuitBreaker"
      pattern: "createCircuitBreaker"
    - from: "src/services/index.ts"
      to: "src/services/unrest/index.ts"
      via: "barrel re-export"
      pattern: "export \\* from './unrest'"
---

<objective>
Create the unrest service module (port/adapter) mapping proto types to legacy SocialUnrestEvent shape, update the services barrel, and delete all legacy unrest/protest code.

Purpose: Complete the unrest domain migration by providing a service module that maintains backward compatibility with the 15+ consumers depending on SocialUnrestEvent shape (lat/lon, Date, string severity), while routing through the new proto-typed handler. This is the most consumer-heavy migration in the series -- the service module is a full adapter, not a thin wrapper.
Output: Service module at src/services/unrest/index.ts, updated barrel, 3 legacy files deleted.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2J-unrest-migration/2J-RESEARCH.md
@.planning/phases/2J-unrest-migration/2J-01-SUMMARY.md

# Reference service modules (patterns to follow)
@src/services/climate/index.ts
@src/services/displacement/index.ts

# Generated client (what the service module wraps)
@src/generated/client/worldmonitor/unrest/v1/service_client.ts

# Legacy service to port API surface FROM (then delete)
@src/services/protests.ts

# Services barrel to update
@src/services/index.ts

# Legacy types (DO NOT modify -- SocialUnrestEvent stays in src/types/index.ts)
@src/types/index.ts

# Legacy API endpoints to delete
@api/acled.js
@api/gdelt-geo.js

# Vite config (remove dev proxy entries for /api/acled and /api/gdelt-geo)
@vite.config.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create unrest service module with proto-to-legacy type mapping</name>
  <files>src/services/unrest/index.ts</files>
  <action>
Create `src/services/unrest/index.ts` implementing the port/adapter pattern with full type mapping from proto `UnrestEvent` to legacy `SocialUnrestEvent`.

**Why this is a full adapter (not thin wrapper like research 2I):** The proto `UnrestEvent` has different field shapes than `SocialUnrestEvent`:
- `location.latitude` / `location.longitude` -> `lat` / `lon` (flat numbers)
- `occurredAt` (epoch ms number) -> `time` (Date object)
- `'SEVERITY_LEVEL_HIGH'` -> `'high'`
- `'UNREST_EVENT_TYPE_PROTEST'` -> `'protest'`
- `'UNREST_SOURCE_TYPE_ACLED'` -> `'acled'`
- `fatalities: 0` -> `fatalities: undefined` (0 maps to undefined)

15+ consumer files (map components, CII, signal aggregator, geo-convergence) depend on the `SocialUnrestEvent` shape from `src/types/index.ts`. The type stays there; the service module maps to it.

**Imports:**
```typescript
import {
  UnrestServiceClient,
  type UnrestEvent,
  type ListUnrestEventsResponse,
} from '@/generated/client/worldmonitor/unrest/v1/service_client';
import type { SocialUnrestEvent, ProtestSeverity, ProtestEventType, ProtestSource } from '@/types';
import { createCircuitBreaker } from '@/utils';
```

**Client + Circuit Breaker:**
```typescript
const client = new UnrestServiceClient('');
const unrestBreaker = createCircuitBreaker<ListUnrestEventsResponse>({
  name: 'Unrest Events',
});
```

**Enum Mapping Functions** (4 mappers):
- `mapSeverity(s: string): ProtestSeverity` -- `SEVERITY_LEVEL_HIGH -> 'high'`, `SEVERITY_LEVEL_MEDIUM -> 'medium'`, default `'low'`
- `mapEventType(t: string): ProtestEventType` -- `UNREST_EVENT_TYPE_PROTEST -> 'protest'`, `_RIOT -> 'riot'`, `_STRIKE -> 'strike'`, `_DEMONSTRATION -> 'demonstration'`, default `'civil_unrest'`
- `mapSourceType(s: string): ProtestSource` -- `UNREST_SOURCE_TYPE_ACLED -> 'acled'`, `_GDELT -> 'gdelt'`, default `'rss'`
- `mapConfidence(c: string): 'high' | 'medium' | 'low'` -- `CONFIDENCE_LEVEL_HIGH -> 'high'`, `_MEDIUM -> 'medium'`, default `'low'`

**toSocialUnrestEvent(e: UnrestEvent): SocialUnrestEvent** -- The core adapter function:
```typescript
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
```

Note: `relatedHotspots` is omitted (optional field, was client-side enrichment using INTEL_HOTSPOTS config -- not in proto, dropping per research recommendation). `imageUrl` and `sentiment` also omitted (both optional, never populated meaningfully).

**Export: ProtestData interface** -- Same shape as legacy:
```typescript
export interface ProtestData {
  events: SocialUnrestEvent[];
  byCountry: Map<string, SocialUnrestEvent[]>;
  highSeverityCount: number;
  sources: { acled: number; gdelt: number };
}
```

**Export: fetchProtestEvents()** -- Main fetch function, same name as legacy:
- Call `unrestBreaker.execute()` with empty fallback `{ events: [], clusters: [], pagination: undefined }`.
- Inside breaker: `client.listUnrestEvents({ country: '', minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED' })`.
- Map `resp.events` through `toSocialUnrestEvent`.
- Group by country into `Map<string, SocialUnrestEvent[]>`.
- Count high severity: `events.filter(e => e.severity === 'high').length`.
- Count sources: filter by sourceType `'acled'` and `'gdelt'`.
- Update `acledConfigured` status: if response has any events with `sourceType === 'acled'` -> `acledConfigured = true`. If response has GDELT events but zero ACLED events -> `acledConfigured = false`. If completely empty response -> leave as `null`.
- Return `ProtestData`.

**Export: getProtestStatus()** -- Same signature as legacy:
```typescript
let acledConfigured: boolean | null = null;

export function getProtestStatus(): { acledConfigured: boolean | null; gdeltAvailable: boolean } {
  return { acledConfigured, gdeltAvailable: true };
}
```

The `acledConfigured` variable is updated by `fetchProtestEvents()` based on response analysis (heuristic approach per research recommendation for Open Question 1).
  </action>
  <verify>
1. `ls src/services/unrest/index.ts` -- exists
2. `npx tsc --noEmit` -- passes (service module types align with SocialUnrestEvent from @/types)
  </verify>
  <done>Unrest service module created with full proto-to-legacy type mapping. Exports fetchProtestEvents (returns ProtestData with SocialUnrestEvent[]), getProtestStatus, and ProtestData. All 15+ consumers of SocialUnrestEvent shape continue working without modification.</done>
</task>

<task type="auto">
  <name>Task 2: Update services barrel, remove vite proxy entries, and delete legacy files</name>
  <files>
    src/services/index.ts
    vite.config.ts
    api/acled.js
    api/gdelt-geo.js
    src/services/protests.ts
  </files>
  <action>
**1. Update services barrel** in `src/services/index.ts`:
- Change line 17 from `export * from './protests'` to `export * from './unrest'`
- This preserves the barrel export chain: consumers importing `fetchProtestEvents` from `@/services` will now get it from the new unrest module.

**2. Verify no direct imports** of `src/services/protests`:
- Grep for `from.*services/protests` across the codebase (excluding `.planning/`). Per research, `App.ts` and other consumers import via the barrel (`@/services`), not directly. But verify before deleting.
- If any direct imports exist, update them to import from `@/services` (barrel) or `@/services/unrest` (direct).

**3. Remove Vite dev proxy entries** from `vite.config.ts`:
- Remove the `/api/acled` proxy entry (the block with `target: 'https://acleddata.com'`, `changeOrigin: true`, and `rewrite` line). This was the legacy ACLED proxy for dev mode -- now handled by the sebuf handler.
- Remove the `/api/gdelt-geo` proxy entry (the block with `target: 'https://api.gdeltproject.org'`, `changeOrigin: true`, and `rewrite` to `/api/v2/geo/geo`). This was the legacy GDELT GEO proxy for dev mode -- now handled server-side in the handler.
- **DO NOT remove** the `/api/gdelt` proxy entry (without the `-geo` suffix) -- that's used by a different domain (GDELT event data, not GEO data).
- **DO NOT remove** the `/api/acled-conflict` proxy entry if it exists -- that's the conflict domain, NOT unrest.

**4. Delete legacy API endpoints:**
- `rm api/acled.js` -- replaced by handler's ACLED fetch
- `rm api/gdelt-geo.js` -- replaced by handler's GDELT fetch
- **DO NOT delete `api/acled-conflict.js`** -- belongs to conflict domain migration (separate future phase)

**5. Delete legacy service file:**
- `rm src/services/protests.ts` -- replaced by `src/services/unrest/index.ts`

**Verification:**
- Run `npx tsc --noEmit` to confirm no broken imports anywhere in the project
- Verify `api/acled-conflict.js` still exists (scope guard)
- Verify `src/types/index.ts` still has `SocialUnrestEvent` (scope guard)
  </action>
  <verify>
1. `npx tsc --noEmit` -- passes (no broken imports from deletion or barrel change)
2. `ls api/acled.js api/gdelt-geo.js src/services/protests.ts 2>&1` -- all "No such file"
3. `ls api/acled-conflict.js` -- still exists (scope guard)
4. `grep -c "SocialUnrestEvent" src/types/index.ts` -- > 0 (type preserved)
5. `grep "export.*from.*unrest" src/services/index.ts` -- shows new barrel export
6. `grep -c "/api/acled" vite.config.ts` -- returns 0 (proxy removed; note: /api/acled-conflict may still be present)
  </verify>
  <done>Services barrel updated (protests -> unrest). Vite dev proxy entries removed for /api/acled and /api/gdelt-geo. Three legacy files deleted (api/acled.js, api/gdelt-geo.js, src/services/protests.ts). api/acled-conflict.js preserved for future conflict migration. SocialUnrestEvent type preserved in src/types/index.ts. Full project TypeScript compilation passes.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` -- zero errors across entire project
2. Service module exports fetchProtestEvents, getProtestStatus, ProtestData
3. Proto-to-legacy type mapping covers all SocialUnrestEvent fields
4. Services barrel re-exports from './unrest' (not './protests')
5. No legacy protest/ACLED/GDELT-GEO files remain (3 files deleted)
6. api/acled-conflict.js NOT deleted (scope guard)
7. SocialUnrestEvent type NOT removed from src/types/index.ts (scope guard)
8. Vite dev proxy entries for /api/acled and /api/gdelt-geo removed
9. No broken imports anywhere in the codebase
</verification>

<success_criteria>
- src/services/unrest/index.ts exports fetchProtestEvents, getProtestStatus, ProtestData
- Full adapter maps UnrestEvent -> SocialUnrestEvent (lat/lon, Date, string severity/eventType/sourceType)
- acledConfigured heuristic infers status from response event sources
- Circuit breaker wraps client call with empty fallback
- Services barrel updated: './protests' -> './unrest'
- Legacy endpoints deleted (api/acled.js, api/gdelt-geo.js)
- Legacy service deleted (src/services/protests.ts)
- Vite proxy entries removed (/api/acled, /api/gdelt-geo)
- api/acled-conflict.js preserved (conflict domain scope guard)
- SocialUnrestEvent preserved in src/types/index.ts (consumer scope guard)
- Full project TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2J-unrest-migration/2J-02-SUMMARY.md`
</output>
