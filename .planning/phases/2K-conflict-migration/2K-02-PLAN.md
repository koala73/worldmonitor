---
phase: 2K-conflict-migration
plan: 02
type: execute
wave: 2
depends_on:
  - 2K-01
files_modified:
  - src/services/conflict/index.ts
  - src/App.ts
  - src/services/country-instability.ts
  - api/acled-conflict.js
  - api/ucdp-events.js
  - api/ucdp.js
  - api/hapi.js
  - src/services/conflicts.ts
  - src/services/ucdp.ts
  - src/services/ucdp-events.ts
  - src/services/hapi.ts
  - src/services/conflict-impact.ts
autonomous: true
requirements:
  - DOMAIN-07
  - SERVER-02

must_haves:
  truths:
    - "Service module exports fetchConflictEvents returning ConflictData with same shape as legacy conflicts.ts (events: ConflictEvent[], byCountry, totalFatalities, count)"
    - "Service module exports fetchUcdpClassifications returning Map<string, UcdpConflictStatus> with same shape as legacy ucdp.ts"
    - "Service module exports fetchHapiSummary returning Map<string, HapiConflictSummary> with same shape as legacy hapi.ts"
    - "Service module exports fetchUcdpEvents returning UcdpEventsResponse with data: UcdpGeoEvent[] compatible with legacy shape"
    - "Service module exports deduplicateAgainstAcled with same signature as legacy ucdp-events.ts (haversine + date + fatality matching)"
    - "Proto AcledConflictEvent mapped to legacy ConflictEvent shape (location.latitude->lat, occurredAt->Date, eventType string->ConflictEventType)"
    - "Proto UcdpViolenceEvent mapped to legacy UcdpGeoEvent shape (dateStart number->date_start string, location->flat lat/lon, violenceType enum->type_of_violence string)"
    - "Proto HumanitarianCountrySummary mapped to legacy HapiConflictSummary shape (populationAffected string->eventsTotal number, etc.)"
    - "UCDP classifications derived heuristically from GED events (many recent deaths=war, some events=minor, none=none)"
    - "App.ts imports updated from 4 direct imports to single @/services/conflict import"
    - "country-instability.ts imports updated from 3 direct imports to @/services/conflict"
    - "Legacy files deleted: 4 service files (conflicts.ts, ucdp.ts, ucdp-events.ts, hapi.ts) + 4 API endpoints (acled-conflict.js, ucdp.js, ucdp-events.js, hapi.js) + 1 dead code file (conflict-impact.ts)"
    - "UcdpGeoEvent and UcdpEventType types preserved in src/types/index.ts (used by map components)"
  artifacts:
    - path: "src/services/conflict/index.ts"
      provides: "Port/adapter service module mapping proto types to legacy ConflictEvent, UcdpConflictStatus, HapiConflictSummary, UcdpGeoEvent shapes"
      exports: ["fetchConflictEvents", "fetchUcdpClassifications", "fetchHapiSummary", "fetchUcdpEvents", "deduplicateAgainstAcled", "groupByCountry", "groupByType", "ConflictData", "ConflictEvent", "ConflictEventType", "UcdpConflictStatus", "ConflictIntensity", "HapiConflictSummary"]
  key_links:
    - from: "src/services/conflict/index.ts"
      to: "src/generated/client/worldmonitor/conflict/v1/service_client.ts"
      via: "import ConflictServiceClient"
      pattern: "ConflictServiceClient"
    - from: "src/services/conflict/index.ts"
      to: "@/utils"
      via: "import createCircuitBreaker"
      pattern: "createCircuitBreaker"
    - from: "src/App.ts"
      to: "src/services/conflict/index.ts"
      via: "import fetchConflictEvents, fetchUcdpClassifications, fetchHapiSummary, fetchUcdpEvents, deduplicateAgainstAcled"
      pattern: "from '@/services/conflict'"
    - from: "src/services/country-instability.ts"
      to: "src/services/conflict/index.ts"
      via: "import type ConflictEvent, UcdpConflictStatus, HapiConflictSummary"
      pattern: "from.*services/conflict"
---

<objective>
Create the conflict service module (port/adapter) mapping proto types to 4 legacy type shapes, update all consumer imports, and delete all legacy conflict code (9 files).

Purpose: Complete the conflict domain migration by providing a service module that maintains backward compatibility with App.ts (which calls 4 separate fetch functions + deduplicateAgainstAcled), country-instability.ts (which uses ConflictEvent, UcdpConflictStatus, HapiConflictSummary types), and map components (which use UcdpGeoEvent). This is the most complex service module in the series due to 4 distinct legacy type shapes, 5 exported functions, and the UCDP classification derivation heuristic.
Output: Service module at src/services/conflict/index.ts, updated consumers, 9 legacy files deleted.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2K-conflict-migration/2K-RESEARCH.md
@.planning/phases/2K-conflict-migration/2K-01-SUMMARY.md

# Reference service modules (patterns to follow)
@src/services/unrest/index.ts
@src/services/displacement/index.ts

# Generated client (what the service module wraps)
@src/generated/client/worldmonitor/conflict/v1/service_client.ts

# Legacy services to port API surface FROM (then delete)
@src/services/conflicts.ts
@src/services/ucdp.ts
@src/services/ucdp-events.ts
@src/services/hapi.ts
@src/services/conflict-impact.ts

# Consumers to rewire
@src/App.ts
@src/services/country-instability.ts

# Legacy types (DO NOT delete UcdpGeoEvent or UcdpEventType from src/types/index.ts)
@src/types/index.ts

# Legacy API endpoints to delete
@api/acled-conflict.js
@api/ucdp-events.js
@api/ucdp.js
@api/hapi.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create conflict service module with 4-shape proto-to-legacy type mapping</name>
  <files>src/services/conflict/index.ts</files>
  <action>
Create `src/services/conflict/index.ts` implementing the port/adapter pattern with type mapping from proto types to 4 distinct legacy shapes.

**Why this is the most complex adapter:** The conflict service module must produce 4 different legacy type shapes from 3 proto RPCs:
1. `ConflictEvent` (from `AcledConflictEvent` proto) -- consumed by `country-instability.ts`
2. `UcdpConflictStatus` (derived from `UcdpViolenceEvent` proto events) -- consumed by `country-instability.ts`
3. `HapiConflictSummary` (from `HumanitarianCountrySummary` proto) -- consumed by `country-instability.ts`
4. `UcdpGeoEvent` (from `UcdpViolenceEvent` proto) -- consumed by `App.ts` and map components

It also must export `deduplicateAgainstAcled` and `groupByCountry`/`groupByType` functions.

**Imports:**
```typescript
import {
  ConflictServiceClient,
  type AcledConflictEvent as ProtoAcledEvent,
  type UcdpViolenceEvent as ProtoUcdpEvent,
  type HumanitarianCountrySummary as ProtoHumanSummary,
  type ListAcledEventsResponse,
  type ListUcdpEventsResponse,
  type GetHumanitarianSummaryResponse,
} from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { createCircuitBreaker } from '@/utils';
```

**Client + Circuit Breakers (3 separate breakers for 3 RPCs):**
```typescript
const client = new ConflictServiceClient('');
const acledBreaker = createCircuitBreaker<ListAcledEventsResponse>({ name: 'ACLED Conflicts' });
const ucdpBreaker = createCircuitBreaker<ListUcdpEventsResponse>({ name: 'UCDP Events' });
const hapiBreaker = createCircuitBreaker<GetHumanitarianSummaryResponse>({ name: 'HDX HAPI' });
```

---

**Exported Types** (match legacy shapes exactly):

```typescript
export type ConflictEventType = 'battle' | 'explosion' | 'remote_violence' | 'violence_against_civilians';

export interface ConflictEvent {
  id: string;
  eventType: ConflictEventType;
  subEventType: string;
  country: string;
  region?: string;
  location: string;
  lat: number;
  lon: number;
  time: Date;
  fatalities: number;
  actors: string[];
  source: string;
}

export interface ConflictData {
  events: ConflictEvent[];
  byCountry: Map<string, ConflictEvent[]>;
  totalFatalities: number;
  count: number;
}

export type ConflictIntensity = 'none' | 'minor' | 'war';

export interface UcdpConflictStatus {
  location: string;
  intensity: ConflictIntensity;
  conflictId?: number;
  conflictName?: string;
  year: number;
  typeOfConflict?: number;
  sideA?: string;
  sideB?: string;
}

export interface HapiConflictSummary {
  iso3: string;
  locationName: string;
  month: string;
  eventsTotal: number;
  eventsPoliticalViolence: number;
  eventsCivilianTargeting: number;
  eventsDemonstrations: number;
  fatalitiesTotalPoliticalViolence: number;
  fatalitiesTotalCivilianTargeting: number;
}
```

---

**Adapter 1: Proto AcledConflictEvent -> legacy ConflictEvent**

```typescript
function mapProtoEventType(eventType: string): ConflictEventType {
  const lower = eventType.toLowerCase();
  if (lower.includes('battle')) return 'battle';
  if (lower.includes('explosion')) return 'explosion';
  if (lower.includes('remote violence')) return 'remote_violence';
  if (lower.includes('violence against')) return 'violence_against_civilians';
  return 'battle';
}

function toConflictEvent(proto: ProtoAcledEvent): ConflictEvent {
  return {
    id: proto.id,
    eventType: mapProtoEventType(proto.eventType),
    subEventType: '',
    country: proto.country,
    region: proto.admin1 || undefined,
    location: '',  // Not in proto, empty string
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    time: new Date(proto.occurredAt),
    fatalities: proto.fatalities,
    actors: proto.actors,
    source: proto.source,
  };
}
```

**Adapter 2: Proto UcdpViolenceEvent -> legacy UcdpGeoEvent**

Violence type mapping (proto enum -> legacy string union):
```typescript
const VIOLENCE_TYPE_REVERSE: Record<string, UcdpEventType> = {
  UCDP_VIOLENCE_TYPE_STATE_BASED: 'state-based',
  UCDP_VIOLENCE_TYPE_NON_STATE: 'non-state',
  UCDP_VIOLENCE_TYPE_ONE_SIDED: 'one-sided',
};
```

```typescript
function toUcdpGeoEvent(proto: ProtoUcdpEvent): UcdpGeoEvent {
  return {
    id: proto.id,
    date_start: proto.dateStart ? new Date(proto.dateStart).toISOString().split('T')[0] : '',
    date_end: proto.dateEnd ? new Date(proto.dateEnd).toISOString().split('T')[0] : '',
    latitude: proto.location?.latitude ?? 0,
    longitude: proto.location?.longitude ?? 0,
    country: proto.country,
    side_a: proto.sideA,
    side_b: proto.sideB,
    deaths_best: proto.deathsBest,
    deaths_low: proto.deathsLow,
    deaths_high: proto.deathsHigh,
    type_of_violence: VIOLENCE_TYPE_REVERSE[proto.violenceType] || 'state-based',
    source_original: proto.sourceOriginal,
  };
}
```

**Adapter 3: Proto HumanitarianCountrySummary -> legacy HapiConflictSummary**

ISO-3 to ISO-2 mapping (port from legacy `src/services/hapi.ts`):
```typescript
const ISO3_TO_ISO2: Record<string, string> = {
  USA: 'US', RUS: 'RU', CHN: 'CN', UKR: 'UA', IRN: 'IR',
  ISR: 'IL', TWN: 'TW', PRK: 'KP', SAU: 'SA', TUR: 'TR',
  POL: 'PL', DEU: 'DE', FRA: 'FR', GBR: 'GB', IND: 'IN',
  PAK: 'PK', SYR: 'SY', YEM: 'YE', MMR: 'MM', VEN: 'VE',
};
```

Note: The proto `HumanitarianCountrySummary` has `populationAffected: string` (int64 without NUMBER annotation), `peopleInNeed: string`, `internallyDisplaced: string`. Parse with `Number()`.

```typescript
function toHapiSummary(proto: ProtoHumanSummary): HapiConflictSummary {
  const eventsTotal = Number(proto.populationAffected) || 0;
  const politicalViolence = Number(proto.peopleInNeed) || 0;
  return {
    iso3: '',  // Not directly available; will be mapped by fetchHapiSummary
    locationName: proto.countryName,
    month: proto.updatedAt ? new Date(proto.updatedAt).toISOString().substring(0, 7) : '',
    eventsTotal,
    eventsPoliticalViolence: politicalViolence,
    eventsCivilianTargeting: 0,
    eventsDemonstrations: eventsTotal - politicalViolence,
    fatalitiesTotalPoliticalViolence: 0,
    fatalitiesTotalCivilianTargeting: 0,
  };
}
```

---

**Export: fetchConflictEvents()** -- Same name and return shape as legacy `conflicts.ts`:
- Call `acledBreaker.execute()` with `client.listAcledEvents({ country: '' })`.
- Empty fallback: `{ events: [], pagination: undefined }`.
- Map `resp.events` through `toConflictEvent`.
- Group by country into `Map<string, ConflictEvent[]>`.
- Sum totalFatalities.
- Return `ConflictData`.

**Export: fetchUcdpClassifications()** -- Same name and return shape as legacy `ucdp.ts`:
- Call `ucdpBreaker.execute()` with `client.listUcdpEvents({ country: '' })`.
- Empty fallback: `{ events: [], pagination: undefined }`.
- **Derive classifications heuristically from GED events** (per research recommendation Open Question 1):
  - Group events by country.
  - For each country: count events and sum deaths in trailing 2 years.
  - If deaths > 1000 or events > 100 -> 'war'. If events > 10 -> 'minor'. Otherwise 'none'.
  - Build `UcdpConflictStatus` with `location` = country name, `intensity`, `year` = most recent event year, `sideA`/`sideB` from highest-death event.
- Return `Map<string, UcdpConflictStatus>` keyed by country name (matching legacy pattern -- `country-instability.ts` resolves to ISO-2 using its own `UCDP_COUNTRY_MAP`).

**Export: fetchHapiSummary()** -- Same name and return shape as legacy `hapi.ts`:
- For each tier-1 country in `ISO3_TO_ISO2`, call `hapiBreaker.execute()` with `client.getHumanitarianSummary({ countryCode: iso2 })`.
- **Optimization:** Since `getHumanitarianSummary` takes a single country, but the legacy `fetchHapiSummary` returned ALL countries at once, call the RPC once with an empty `countryCode` to get all data, then map results.
- Actually, looking at the handler (which fetches from HAPI API and aggregates per country), calling with empty countryCode will return all countries. Call once, then iterate.
- Map each result `summary` through `toHapiSummary`.
- For each, match countryCode back to ISO-2 using the `ISO3_TO_ISO2` lookup on the country data.
- Return `Map<string, HapiConflictSummary>` keyed by ISO-2 code (matching legacy pattern).

**BUT WAIT** -- the handler's `getHumanitarianSummary` returns a SINGLE `HumanitarianCountrySummary` per call. The legacy `fetchHapiSummary` returns ALL countries at once. The handler aggregates all countries when `countryCode` is empty and picks the first one. This won't work for a multi-country response.

**Revised approach for fetchHapiSummary:**
- Since the legacy `api/hapi.js` returns all countries in one response, and the handler ports that logic for when `countryCode` is empty BUT the proto response is single `summary`, the service module should call the RPC with empty countryCode which returns the first country only. This is a design limitation.
- **Better approach:** Call the RPC for each tier-1 country individually using `Promise.allSettled`, then aggregate. The handler already supports per-country filtering. Use the tier-1 country codes from the ISO3_TO_ISO2 map (20 countries, 20 parallel calls).
- Wrap all calls in `Promise.allSettled` with timeout per call.
- For each fulfilled result with a non-undefined summary, map through `toHapiSummary` and add to the result Map keyed by ISO-2.
- Return `Map<string, HapiConflictSummary>`.

**Export: fetchUcdpEvents()** -- Same name and return shape as legacy `ucdp-events.ts`:
- Call `ucdpBreaker.execute()` with `client.listUcdpEvents({ country: '' })`.
- Empty fallback: `{ events: [], pagination: undefined }`.
- Map `resp.events` through `toUcdpGeoEvent`.
- Return `{ success: true, count: events.length, data: events, cached_at: '' }` matching the `UcdpEventsResponse` interface used by the legacy consumer.

**Export: deduplicateAgainstAcled()** -- Port EXACTLY from `src/services/ucdp-events.ts` lines 38-87:
- Same signature: `(ucdpEvents: UcdpGeoEvent[], acledEvents: AcledEvent[]) => UcdpGeoEvent[]`
- Port the `haversineKm` helper function exactly.
- Port the `AcledEvent` interface (with `latitude: string | number`, `longitude: string | number`, `event_date: string`, `fatalities: string | number`).
- Port the exact filtering logic: 7-day window, 50km haversine radius, fatality ratio 0.5-2.0 matching.

**Export: groupByCountry()** -- Port from `src/services/ucdp-events.ts` line 89-97.
**Export: groupByType()** -- Port from `src/services/ucdp-events.ts` line 99-105.
  </action>
  <verify>
1. `ls src/services/conflict/index.ts` -- exists
2. `npx tsc --noEmit` -- passes (service module types align with legacy shapes from @/types and direct consumers)
  </verify>
  <done>Conflict service module created with 4-shape proto-to-legacy type mapping. Exports fetchConflictEvents (ConflictData), fetchUcdpClassifications (Map of UcdpConflictStatus), fetchHapiSummary (Map of HapiConflictSummary), fetchUcdpEvents (UcdpEventsResponse), deduplicateAgainstAcled, groupByCountry, groupByType. All consumers continue working with identical type shapes.</done>
</task>

<task type="auto">
  <name>Task 2: Rewire consumer imports and delete legacy files</name>
  <files>
    src/App.ts
    src/services/country-instability.ts
    api/acled-conflict.js
    api/ucdp-events.js
    api/ucdp.js
    api/hapi.js
    src/services/conflicts.ts
    src/services/ucdp.ts
    src/services/ucdp-events.ts
    src/services/hapi.ts
    src/services/conflict-impact.ts
  </files>
  <action>
**1. Update App.ts imports** (lines 30-33):

Replace these 4 direct imports:
```typescript
import { fetchConflictEvents } from '@/services/conflicts';
import { fetchUcdpClassifications } from '@/services/ucdp';
import { fetchHapiSummary } from '@/services/hapi';
import { fetchUcdpEvents, deduplicateAgainstAcled } from '@/services/ucdp-events';
```

With single consolidated import:
```typescript
import { fetchConflictEvents, fetchUcdpClassifications, fetchHapiSummary, fetchUcdpEvents, deduplicateAgainstAcled } from '@/services/conflict';
```

**No other changes needed in App.ts** -- the function names and return types are identical.

**2. Update country-instability.ts imports** (lines 5-7):

Replace these 3 direct imports:
```typescript
import type { ConflictEvent } from './conflicts';
import type { UcdpConflictStatus } from './ucdp';
import type { HapiConflictSummary } from './hapi';
```

With single consolidated import:
```typescript
import type { ConflictEvent, UcdpConflictStatus, HapiConflictSummary } from './conflict';
```

**No other changes needed in country-instability.ts** -- the types and function signatures are identical.

**3. Verify no other direct imports** of the legacy service files:
- Grep for `from.*services/conflicts[^/]` (excluding conflict/ directory), `from.*services/ucdp[^-]`, `from.*services/ucdp-events`, `from.*services/hapi[^/]`, `from.*services/conflict-impact` across all `.ts` files (excluding `.planning/`).
- If any additional imports found, update them to import from `@/services/conflict`.

**4. Delete legacy API endpoints (4 files):**
- `rm api/acled-conflict.js`
- `rm api/ucdp-events.js`
- `rm api/ucdp.js`
- `rm api/hapi.js`

**5. Delete legacy service files (4 files):**
- `rm src/services/conflicts.ts`
- `rm src/services/ucdp.ts`
- `rm src/services/ucdp-events.ts`
- `rm src/services/hapi.ts`

**6. Delete dead code (1 file):**
- `rm src/services/conflict-impact.ts` -- confirmed dead code (not imported by any file per research)

**7. Scope guards -- DO NOT delete or modify:**
- `src/types/index.ts` -- `UcdpGeoEvent` and `UcdpEventType` types MUST remain (used by `DeckGLMap.ts`, `MapContainer.ts`, `UcdpEventsPanel.ts`)
- `src/services/index.ts` -- barrel does NOT need updating because conflict services were NEVER re-exported through the barrel (direct imports only)

**Verification:**
- Run `npx tsc --noEmit` to confirm no broken imports anywhere in the project
- Verify `UcdpGeoEvent` still exists in `src/types/index.ts` (scope guard)
- Verify none of the 9 deleted files exist
  </action>
  <verify>
1. `npx tsc --noEmit` -- passes (no broken imports from deletion or import rewiring)
2. `ls api/acled-conflict.js api/ucdp-events.js api/ucdp.js api/hapi.js src/services/conflicts.ts src/services/ucdp.ts src/services/ucdp-events.ts src/services/hapi.ts src/services/conflict-impact.ts 2>&1` -- all "No such file"
3. `grep -c "UcdpGeoEvent" src/types/index.ts` -- > 0 (type preserved)
4. `grep "from.*@/services/conflict" src/App.ts` -- shows new consolidated import
5. `grep "from.*services/conflict" src/services/country-instability.ts` -- shows new consolidated import
  </verify>
  <done>App.ts imports consolidated from 4 direct imports to single @/services/conflict import. country-instability.ts imports consolidated from 3 direct imports to single ./conflict import. 9 legacy files deleted (4 API endpoints + 4 service files + 1 dead code file). UcdpGeoEvent type preserved in src/types/index.ts for map component consumers. Full project TypeScript compilation passes.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` -- zero errors across entire project
2. Service module exports all 5 functions: fetchConflictEvents, fetchUcdpClassifications, fetchHapiSummary, fetchUcdpEvents, deduplicateAgainstAcled
3. Service module exports all legacy types: ConflictEvent, ConflictEventType, ConflictData, UcdpConflictStatus, ConflictIntensity, HapiConflictSummary
4. Proto-to-legacy type mapping covers all 4 shapes completely
5. App.ts imports from @/services/conflict (not from 4 separate legacy files)
6. country-instability.ts imports from ./conflict (not from 3 separate legacy files)
7. 9 legacy files deleted (4 API endpoints + 4 service files + 1 dead code file)
8. UcdpGeoEvent and UcdpEventType NOT removed from src/types/index.ts (scope guard)
9. Services barrel (src/services/index.ts) NOT modified (conflict was never in barrel)
10. No broken imports anywhere in the codebase
</verification>

<success_criteria>
- src/services/conflict/index.ts exports fetchConflictEvents, fetchUcdpClassifications, fetchHapiSummary, fetchUcdpEvents, deduplicateAgainstAcled, groupByCountry, groupByType
- Full adapter maps AcledConflictEvent -> ConflictEvent (lat/lon, Date, ConflictEventType)
- Full adapter maps UcdpViolenceEvent -> UcdpGeoEvent (date strings, flat lat/lon, violence type string)
- Full adapter maps HumanitarianCountrySummary -> HapiConflictSummary (int64 string->number, event counts)
- UCDP classifications derived heuristically from GED events (deaths/events thresholds -> war/minor/none)
- deduplicateAgainstAcled ported exactly with haversine distance + date proximity + fatality ratio matching
- App.ts consolidated from 4 imports to 1
- country-instability.ts consolidated from 3 imports to 1
- Legacy endpoints deleted: api/acled-conflict.js, api/ucdp-events.js, api/ucdp.js, api/hapi.js
- Legacy services deleted: src/services/conflicts.ts, src/services/ucdp.ts, src/services/ucdp-events.ts, src/services/hapi.ts
- Dead code deleted: src/services/conflict-impact.ts
- UcdpGeoEvent preserved in src/types/index.ts (map component scope guard)
- Full project TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2K-conflict-migration/2K-02-SUMMARY.md`
</output>
