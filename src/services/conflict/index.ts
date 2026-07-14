import { getRpcBaseUrl, getRpcErrorStatusCode } from '@/services/rpc-client';
import type { AcledConflictEvent as ProtoAcledEvent, UcdpViolenceEvent as ProtoUcdpEvent, HumanitarianCountrySummary as ProtoHumanSummary, ListAcledEventsResponse, ListUcdpEventsResponse, GetHumanitarianSummaryResponse, GetHumanitarianSummaryBatchResponse, IranEvent, ListIranEventsResponse } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';
import { ConflictServiceClient } from '@/services/generated-rpc-clients';
import { isDuplicatedByAcled } from './ucdp-dedupe';
import type { AcledDedupEvent, UcdpDedupeIndexEntry, UcdpTabAggregate } from './ucdp-dedupe';
export { deduplicateUcdpProjectionAggregates } from './ucdp-dedupe';
export type { UcdpDedupeIndexEntry, UcdpTabAggregate } from './ucdp-dedupe';

// ---- Client + Circuit Breakers (per-RPC; HAPI uses per-country map) ----

const client = new ConflictServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const acledBreaker = createCircuitBreaker<ListAcledEventsResponse>({ name: 'ACLED Conflicts', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const ucdpBreaker = createCircuitBreaker<ListUcdpEventsResponse>({ name: 'UCDP Events', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const hapiBreakers = new Map<string, ReturnType<typeof createCircuitBreaker<GetHumanitarianSummaryResponse>>>();
function getHapiBreaker(iso2: string) {
  if (!hapiBreakers.has(iso2)) {
    hapiBreakers.set(iso2, createCircuitBreaker<GetHumanitarianSummaryResponse>({
      name: `HDX HAPI:${iso2}`,
      cacheTtlMs: 10 * 60 * 1000,
      persistCache: true,
    }));
  }
  return hapiBreakers.get(iso2)!;
}
const iranBreaker = createCircuitBreaker<ListIranEventsResponse>({ name: 'Iran Events', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

const emptyIranFallback: ListIranEventsResponse = { events: [], scrapedAt: '0' };

export type { IranEvent };

// ---- Exported Types (match legacy shapes exactly) ----

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



export interface HapiConflictSummary {
  iso2: string;
  locationName: string;
  month: string;
  eventsTotal: number;
  eventsPoliticalViolence: number;
  eventsCivilianTargeting: number;
  eventsDemonstrations: number;
  fatalitiesTotalPoliticalViolence: number;
  fatalitiesTotalCivilianTargeting: number;
}

// ---- Adapter 1: Proto AcledConflictEvent -> legacy ConflictEvent ----

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
    location: '',
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    time: new Date(proto.occurredAt),
    fatalities: proto.fatalities,
    actors: proto.actors,
    source: proto.source,
  };
}

// ---- Adapter 2: Proto UcdpViolenceEvent -> legacy UcdpGeoEvent ----

const VIOLENCE_TYPE_REVERSE: Record<string, UcdpEventType> = {
  UCDP_VIOLENCE_TYPE_STATE_BASED: 'state-based',
  UCDP_VIOLENCE_TYPE_NON_STATE: 'non-state',
  UCDP_VIOLENCE_TYPE_ONE_SIDED: 'one-sided',
};

function toUcdpGeoEvent(proto: ProtoUcdpEvent): UcdpGeoEvent {
  return {
    id: proto.id,
    date_start: proto.dateStart ? new Date(proto.dateStart).toISOString().substring(0, 10) : '',
    date_end: proto.dateEnd ? new Date(proto.dateEnd).toISOString().substring(0, 10) : '',
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

// ---- Adapter 3: Proto HumanitarianCountrySummary -> legacy HapiConflictSummary ----

const HAPI_COUNTRY_CODES = [
  'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR',
  'PL', 'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE',
];

function toHapiSummary(proto: ProtoHumanSummary): HapiConflictSummary {
  // Proto fields now accurately represent HAPI conflict event data (MEDIUM-1 fix)
  return {
    iso2: proto.countryCode || '',
    locationName: proto.countryName,
    month: proto.referencePeriod || '',
    eventsTotal: proto.conflictEventsTotal || 0,
    eventsPoliticalViolence: proto.conflictPoliticalViolenceEvents || 0,
    eventsCivilianTargeting: 0, // Included in conflictPoliticalViolenceEvents
    eventsDemonstrations: proto.conflictDemonstrations || 0,
    fatalitiesTotalPoliticalViolence: proto.conflictFatalities || 0,
    fatalitiesTotalCivilianTargeting: 0, // Included in conflictFatalities
  };
}

/**
 * The bootstrap-hydrated UCDP payload. It is a dashboard PROJECTION of
 * conflict:ucdp-events:v1 (#5300): `events` is capped to the rows the panel
 * renders, and the numbers the UI derives from the full 2,000-event set —
 * per-country classifications and per-tab aggregates — arrive precomputed.
 * The RPC still returns the full, unprojected response.
 */
export type HydratedUcdpPayload = ListUcdpEventsResponse & {
  classifications?: Record<string, UcdpConflictStatus>;
  aggregates?: Record<string, UcdpTabAggregate>;
  dedupeIndex?: UcdpDedupeIndexEntry[];
  totalEvents?: number;
};

// UCDP classification derivation lives in ./ucdp-classify (leaf module, no
// runtime imports) so the seeder's parity test can load it without Vite.
import { deriveUcdpClassifications } from './ucdp-classify';
import type { UcdpConflictStatus } from './ucdp-classify';
export { deriveUcdpClassifications } from './ucdp-classify';
export type { ConflictIntensity, UcdpConflictStatus } from './ucdp-classify';

// ---- AcledEvent interface for deduplication (ported from legacy) ----

type AcledEvent = AcledDedupEvent;

// ---- Empty fallbacks ----

const emptyAcledFallback: ListAcledEventsResponse = { events: [], pagination: undefined };
const emptyUcdpFallback: ListUcdpEventsResponse = { events: [], pagination: undefined };
const emptyHapiFallback: GetHumanitarianSummaryResponse = { summary: undefined };
const emptyHapiBatchFallback: GetHumanitarianSummaryBatchResponse = { results: {}, fetched: 0, requested: 0 };
const hapiBatchBreaker = createCircuitBreaker<GetHumanitarianSummaryBatchResponse>({ name: 'HDX HAPI Batch', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

// ---- Exported Functions ----

export async function fetchConflictEvents(): Promise<ConflictData> {
  const resp = await acledBreaker.execute(async () => {
    return client.listAcledEvents({ country: '', start: 0, end: 0, pageSize: 0, cursor: '' });
  }, emptyAcledFallback, { shouldCache: (r) => r.events.length > 0 });

  const events = resp.events.map(toConflictEvent);

  const byCountry = new Map<string, ConflictEvent[]>();
  let totalFatalities = 0;

  for (const event of events) {
    totalFatalities += event.fatalities;
    const existing = byCountry.get(event.country) || [];
    existing.push(event);
    byCountry.set(event.country, existing);
  }

  return {
    events,
    byCountry,
    totalFatalities,
    count: events.length,
  };
}

export async function fetchUcdpClassifications(hydrated?: HydratedUcdpPayload): Promise<Map<string, UcdpConflictStatus>> {
  // The bootstrap payload is a dashboard projection (#5300): it carries only the
  // 150 rows the panel renders, so deriving classifications from its `events`
  // would score CII against a truncated set. The seeder precomputes them over all
  // 2,000 events instead — use those when present.
  if (hydrated?.classifications) {
    return new Map(Object.entries(hydrated.classifications));
  }
  if (hydrated?.events?.length) return deriveUcdpClassifications(hydrated.events);

  const resp = await ucdpBreaker.execute(async () => {
    return client.listUcdpEvents({ country: '', start: 0, end: 0, pageSize: 0, cursor: '' });
  }, emptyUcdpFallback, { shouldCache: (r) => r.events.length > 0 });

  return deriveUcdpClassifications(resp.events);
}

export async function fetchHapiSummary(): Promise<Map<string, HapiConflictSummary>> {
  const byCode = new Map<string, HapiConflictSummary>();

  const resp = await hapiBatchBreaker.execute(async () => {
    try {
      return await client.getHumanitarianSummaryBatch(
        { countryCodes: [...HAPI_COUNTRY_CODES] },
        { signal: AbortSignal.timeout(60_000) },
      );
    } catch (err: unknown) {
      // 404 deploy-skew fallback: batch endpoint not yet deployed, use per-item calls
      if (getRpcErrorStatusCode(err) === 404) {
        const HAPI_CONCURRENT = 5;
        const allFallback: Array<{ iso2: string; r: GetHumanitarianSummaryResponse }> = [];
        for (let i = 0; i < HAPI_COUNTRY_CODES.length; i += HAPI_CONCURRENT) {
          const batch = HAPI_COUNTRY_CODES.slice(i, i + HAPI_CONCURRENT);
          const results = await Promise.allSettled(
            batch.map(async (iso2) => {
              const r = await getHapiBreaker(iso2).execute(async () => {
                return client.getHumanitarianSummary({ countryCode: iso2 });
              }, emptyHapiFallback);
              return { iso2, r };
            }),
          );
          for (const result of results) {
            if (result.status === 'fulfilled') allFallback.push(result.value);
          }
        }
        const fallbackResults: Record<string, ProtoHumanSummary> = {};
        for (const { iso2, r } of allFallback) {
          if (r.summary) fallbackResults[iso2] = r.summary;
        }
        return { results: fallbackResults, fetched: Object.keys(fallbackResults).length, requested: HAPI_COUNTRY_CODES.length };
      }
      throw err;
    }
  }, emptyHapiBatchFallback, { shouldCache: (r) => r.fetched > 0 });

  for (const [cc, summary] of Object.entries(resp.results)) {
    byCode.set(cc, toHapiSummary(summary));
  }

  return byCode;
}

interface UcdpEventsResponse {
  success: boolean;
  count: number;
  data: UcdpGeoEvent[];
  cached_at: string;
}

export async function fetchUcdpEvents(hydrated?: HydratedUcdpPayload): Promise<UcdpEventsResponse> {
  if (hydrated?.events?.length) {
    const events = hydrated.events.map(toUcdpGeoEvent);
    return { success: true, count: events.length, data: events, cached_at: '' };
  }

  const resp = await ucdpBreaker.execute(async () => {
    return client.listUcdpEvents({ country: '', start: 0, end: 0, pageSize: 0, cursor: '' });
  }, emptyUcdpFallback, { shouldCache: (r) => r.events.length > 0 });

  const events = resp.events.map(toUcdpGeoEvent);

  return {
    success: events.length > 0,
    count: events.length,
    data: events,
    cached_at: '',
  };
}

export function deduplicateAgainstAcled(ucdpEvents: UcdpGeoEvent[], acledEvents: AcledEvent[]): UcdpGeoEvent[] {
  if (!acledEvents.length) return ucdpEvents;
  return ucdpEvents.filter((ucdp) => !isDuplicatedByAcled({
    latitude: ucdp.latitude,
    longitude: ucdp.longitude,
    dateMs: new Date(ucdp.date_start).getTime(),
    deathsBest: ucdp.deaths_best,
  }, acledEvents));
}

const CONFLICT_HISTORY_RADIUS_DEG = 3;

/**
 * Derive the figures shown in a conflict zone's "Historical Profile" popup.
 *
 * `conflictSince` is taken from the zone's static `startDate` — the UCDP feed is
 * only a ~1-year trailing window (scripts/seed-ucdp-events.mjs), so its earliest
 * event is NOT the conflict's inception and must not be used for "CONFLICT SINCE".
 * `recordedFatalities` sums `deaths_best` for events within ~3° of the zone
 * centre, applying a cos(latitude) correction so the radius is roughly isotropic
 * in real distance (a raw degree radius is ~24% too narrow E–W at 40°N).
 */
export function deriveConflictHistory(
  zone: { center: [number, number]; startDate?: string },
  events: UcdpGeoEvent[],
): { conflictSince: string | null; recordedFatalities: number } {
  const [cLon, cLat] = zone.center;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const recordedFatalities = events.reduce((sum, e) => {
    const dLat = e.latitude - cLat;
    const dLon = (e.longitude - cLon) * cosLat;
    if (Math.sqrt(dLat * dLat + dLon * dLon) >= CONFLICT_HISTORY_RADIUS_DEG) return sum;
    return sum + (e.deaths_best ?? 0);
  }, 0);
  const conflictSince = zone.startDate?.match(/\b(\d{4})\b/)?.[1] ?? null;
  return { conflictSince, recordedFatalities };
}

export function groupByCountry(events: UcdpGeoEvent[]): Map<string, UcdpGeoEvent[]> {
  const map = new Map<string, UcdpGeoEvent[]>();
  for (const e of events) {
    const country = e.country || 'Unknown';
    if (!map.has(country)) map.set(country, []);
    map.get(country)!.push(e);
  }
  return map;
}

export function groupByType(events: UcdpGeoEvent[]): Record<string, UcdpGeoEvent[]> {
  return {
    'state-based': events.filter(e => e.type_of_violence === 'state-based'),
    'non-state': events.filter(e => e.type_of_violence === 'non-state'),
    'one-sided': events.filter(e => e.type_of_violence === 'one-sided'),
  };
}

const IRAN_RED_CATEGORIES = new Set(['military', 'airstrike', 'defense']);
const IRAN_ORANGE_CATEGORIES = new Set(['political', 'international']);

type IranColorTier = 'red' | 'orange' | 'yellow';

function iranColorTier(ev: Pick<IranEvent, 'severity' | 'category'>): IranColorTier {
  if (ev.severity === 'critical' || IRAN_RED_CATEGORIES.has(ev.category)) return 'red';
  if (IRAN_ORANGE_CATEGORIES.has(ev.category)) return 'orange';
  return 'yellow';
}

const IRAN_RGBA: Record<IranColorTier, [number, number, number, number]> = {
  red: [255, 50, 50, 220], orange: [255, 165, 0, 200], yellow: [255, 255, 0, 180],
};
const IRAN_CSS: Record<IranColorTier, string> = {
  red: 'rgba(255,50,50,0.85)', orange: 'rgba(255,165,0,0.8)', yellow: 'rgba(255,255,0,0.7)',
};

export function getIranEventColor(ev: Pick<IranEvent, 'severity' | 'category'>): [number, number, number, number] {
  return IRAN_RGBA[iranColorTier(ev)];
}

export function getIranEventCssColor(ev: Pick<IranEvent, 'severity' | 'category'>): string {
  return IRAN_CSS[iranColorTier(ev)];
}

export function getIranEventHexColor(ev: Pick<IranEvent, 'severity'>): string {
  if (ev.severity === 'high' || ev.severity === 'critical') return '#ff3030';
  if (ev.severity === 'elevated') return '#ff8800';
  return '#ffcc00';
}

export function getIranEventRadius(severity: string): number {
  if (severity === 'high' || severity === 'critical') return 20000;
  if (severity === 'elevated') return 15000;
  return 10000;
}

export function getIranEventSize(severity: string): number {
  if (severity === 'high' || severity === 'critical') return 14;
  if (severity === 'elevated') return 11;
  return 8;
}

export async function fetchIranEvents(): Promise<IranEvent[]> {
  const hydrated = getHydratedData('iranEvents') as ListIranEventsResponse | undefined;
  if (hydrated?.events?.length) return hydrated.events;

  const resp = await iranBreaker.execute(async () => {
    const cacheBust = Math.floor(Date.now() / 120_000);
    const r = await globalThis.fetch(toApiUrl(`/api/conflict/v1/list-iran-events?_v=${cacheBust}`));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<ListIranEventsResponse>;
  }, emptyIranFallback);
  return resp.events;
}
