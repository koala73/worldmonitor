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

// ---- Client + Circuit Breakers (3 separate breakers for 3 RPCs) ----

const client = new ConflictServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const acledBreaker = createCircuitBreaker<ListAcledEventsResponse>({ name: 'ACLED Conflicts' });
const ucdpBreaker = createCircuitBreaker<ListUcdpEventsResponse>({ name: 'UCDP Events' });
const hapiBreaker = createCircuitBreaker<GetHumanitarianSummaryResponse>({ name: 'HDX HAPI' });

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

const ISO3_TO_ISO2: Record<string, string> = {
  USA: 'US', RUS: 'RU', CHN: 'CN', UKR: 'UA', IRN: 'IR',
  ISR: 'IL', TWN: 'TW', PRK: 'KP', SAU: 'SA', TUR: 'TR',
  POL: 'PL', DEU: 'DE', FRA: 'FR', GBR: 'GB', IND: 'IN',
  PAK: 'PK', SYR: 'SY', YEM: 'YE', MMR: 'MM', VEN: 'VE',
};

const ISO2_TO_ISO2_KEYS = Object.values(ISO3_TO_ISO2);

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

// ---- UCDP classification derivation heuristic ----

function deriveUcdpClassifications(events: ProtoUcdpEvent[]): Map<string, UcdpConflictStatus> {
  const byCountry = new Map<string, ProtoUcdpEvent[]>();
  for (const e of events) {
    const country = e.country;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(e);
  }

  const now = Date.now();
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
  const result = new Map<string, UcdpConflictStatus>();

  for (const [country, countryEvents] of byCountry) {
    // Filter to trailing 2-year window
    const recentEvents = countryEvents.filter(e => (now - e.dateStart) < twoYearsMs);
    const totalDeaths = recentEvents.reduce((sum, e) => sum + e.deathsBest, 0);
    const eventCount = recentEvents.length;

    let intensity: ConflictIntensity;
    if (totalDeaths > 1000 || eventCount > 100) {
      intensity = 'war';
    } else if (eventCount > 10) {
      intensity = 'minor';
    } else {
      intensity = 'none';
    }

    // Find the highest-death event for sideA/sideB
    let maxDeathEvent: ProtoUcdpEvent | undefined;
    for (const e of recentEvents) {
      if (!maxDeathEvent || e.deathsBest > maxDeathEvent.deathsBest) {
        maxDeathEvent = e;
      }
    }

    // Most recent event year
    const mostRecentEvent = recentEvents.reduce<ProtoUcdpEvent | undefined>(
      (latest, e) => (!latest || e.dateStart > latest.dateStart) ? e : latest,
      undefined,
    );
    const year = mostRecentEvent ? new Date(mostRecentEvent.dateStart).getFullYear() : new Date().getFullYear();

    result.set(country, {
      location: country,
      intensity,
      year,
      sideA: maxDeathEvent?.sideA,
      sideB: maxDeathEvent?.sideB,
    });
  }

  return result;
}

// ---- Haversine helper (ported exactly from legacy ucdp-events.ts) ----

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- AcledEvent interface for deduplication (ported from legacy) ----

interface AcledEvent {
  latitude: string | number;
  longitude: string | number;
  event_date: string;
  fatalities: string | number;
}

// ---- Empty fallbacks ----

const emptyAcledFallback: ListAcledEventsResponse = { events: [], pagination: undefined };
const emptyUcdpFallback: ListUcdpEventsResponse = { events: [], pagination: undefined };
const emptyHapiFallback: GetHumanitarianSummaryResponse = { summary: undefined };

// ---- Exported Functions ----

export async function fetchConflictEvents(): Promise<ConflictData> {
  const resp = await acledBreaker.execute(async () => {
    return client.listAcledEvents({ country: '' });
  }, emptyAcledFallback);

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

export async function fetchUcdpClassifications(): Promise<Map<string, UcdpConflictStatus>> {
  const resp = await ucdpBreaker.execute(async () => {
    return client.listUcdpEvents({ country: '' });
  }, emptyUcdpFallback);

  // Don't let the breaker cache empty responses — clear so next call retries
  if (resp.events.length === 0) ucdpBreaker.clearCache();

  return deriveUcdpClassifications(resp.events);
}

export async function fetchHapiSummary(): Promise<Map<string, HapiConflictSummary>> {
  const results = await Promise.allSettled(
    ISO2_TO_ISO2_KEYS.map(async (iso2) => {
      const resp = await hapiBreaker.execute(async () => {
        return client.getHumanitarianSummary({ countryCode: iso2 });
      }, emptyHapiFallback);
      return { iso2, resp };
    }),
  );

  const byCode = new Map<string, HapiConflictSummary>();

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.resp.summary) {
      const { iso2, resp } = result.value;
      const summary = toHapiSummary(resp.summary!);
      byCode.set(iso2, summary);
    }
  }

  return byCode;
}

interface UcdpEventsResponse {
  success: boolean;
  count: number;
  data: UcdpGeoEvent[];
  cached_at: string;
}

export async function fetchUcdpEvents(): Promise<UcdpEventsResponse> {
  const resp = await ucdpBreaker.execute(async () => {
    return client.listUcdpEvents({ country: '' });
  }, emptyUcdpFallback);

  // Don't let the breaker cache empty responses — clear so next call retries
  if (resp.events.length === 0) ucdpBreaker.clearCache();

  const events = resp.events.map(toUcdpGeoEvent);

  return {
    success: events.length > 0,
    count: events.length,
    data: events,
    cached_at: '',
  };
}

export function deduplicateAgainstAcled(
  ucdpEvents: UcdpGeoEvent[],
  acledEvents: AcledEvent[],
): UcdpGeoEvent[] {
  if (!acledEvents.length) return ucdpEvents;

  return ucdpEvents.filter(ucdp => {
    const uLat = ucdp.latitude;
    const uLon = ucdp.longitude;
    const uDate = new Date(ucdp.date_start).getTime();
    const uDeaths = ucdp.deaths_best;

    for (const acled of acledEvents) {
      const aLat = Number(acled.latitude);
      const aLon = Number(acled.longitude);
      const aDate = new Date(acled.event_date).getTime();
      const aDeaths = Number(acled.fatalities) || 0;

      const dayDiff = Math.abs(uDate - aDate) / (1000 * 60 * 60 * 24);
      if (dayDiff > 7) continue;

      const dist = haversineKm(uLat, uLon, aLat, aLon);
      if (dist > 50) continue;

      if (uDeaths === 0 && aDeaths === 0) return false;
      if (uDeaths > 0 && aDeaths > 0) {
        const ratio = uDeaths / aDeaths;
        if (ratio >= 0.5 && ratio <= 2.0) return false;
      }
    }
    return true;
  });
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
