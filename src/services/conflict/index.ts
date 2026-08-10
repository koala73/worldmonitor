import { getRpcBaseUrl } from '@/services/rpc-client';
import type { AcledConflictEvent as ProtoAcledEvent, UcdpViolenceEvent as ProtoUcdpEvent, ListAcledEventsResponse, ListUcdpEventsResponse, IranEvent, ListIranEventsResponse } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';
import { ConflictServiceClient } from '@/services/generated-rpc-clients';
import { isDuplicatedByAcled } from './ucdp-dedupe';
import type { AcledDedupEvent, UcdpDedupeIndexEntry, UcdpTabAggregate } from './ucdp-dedupe';
export { deduplicateUcdpProjectionAggregates } from './ucdp-dedupe';
export type { UcdpDedupeIndexEntry, UcdpTabAggregate } from './ucdp-dedupe';

// ---- Client + Circuit Breakers ----

const client = new ConflictServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const acledBreaker = createCircuitBreaker<ListAcledEventsResponse>({ name: 'ACLED Conflicts', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const ucdpBreaker = createCircuitBreaker<ListUcdpEventsResponse>({ name: 'UCDP Events', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
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

import type { UcdpConflictStatus } from './ucdp-classify';
export { deriveConflictHistory, deriveUcdpClassifications } from './ucdp-classify';
export type { ConflictIntensity, UcdpConflictStatus } from './ucdp-classify';

// ---- AcledEvent interface for deduplication (ported from legacy) ----

type AcledEvent = AcledDedupEvent;

// ---- Empty fallbacks ----

const emptyAcledFallback: ListAcledEventsResponse = { events: [], pagination: undefined };
const emptyUcdpFallback: ListUcdpEventsResponse = { events: [], pagination: undefined };

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
