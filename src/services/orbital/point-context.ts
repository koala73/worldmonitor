import { haversineKm } from '../../../shared/geo-distance';
import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { PassWindow } from './pass-query';

const DAY_MS = 86_400_000;
export const EVENT_RADIUS_KM = 50;
export const LIVE_RADIUS_KM = 100;

export type EventSourceId = 'conflict' | 'fires' | 'unrest' | 'outages';
export type LiveSourceId = 'vessels' | 'military-flights' | 'gps-jamming';
export const EVENT_SOURCES: readonly EventSourceId[] = ['conflict', 'fires', 'unrest', 'outages'];
export const LIVE_SOURCES: readonly LiveSourceId[] = ['vessels', 'military-flights', 'gps-jamming'];

export interface PointEvent {
  id: string;
  timeMs: number;
  label: string;
  /** Null for country-wide events such as a national internet outage. */
  distanceKm: number | null;
}

/** The part of the timeline a source keeps history for; outside it the lane says "not retained". */
export interface RetainedSpan {
  startMs: number;
  endMs: number;
}

export type EventLane =
  | { status: 'ok'; events: PointEvent[]; retained: RetainedSpan | null }
  | { status: 'unavailable' };

export interface LiveItem {
  id: string;
  label: string;
  distanceKm: number;
}

export type LiveStrip = { status: 'ok'; items: LiveItem[] } | { status: 'unavailable' };

export interface PointContext {
  events: Record<EventSourceId, EventLane>;
  live: Record<LiveSourceId, LiveStrip>;
}

/** A dated record from a global feed, before the browser filters it to the point. */
export interface FeedRecord {
  id: string;
  lat: number;
  lon: number;
  timeMs: number;
  label: string;
  /** ISO 3166-1 alpha-2 for records that describe a whole country. */
  countryCode?: string;
}

export interface LiveRecord {
  id: string;
  lat: number;
  lon: number;
  label: string;
}

export interface PointContextSources {
  events: Record<EventSourceId, () => Promise<FeedRecord[]>>;
  live: Record<LiveSourceId, () => Promise<LiveRecord[]>>;
  countryAt: (point: GeoPoint) => Promise<string | null>;
}

const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

function span(records: FeedRecord[], endMs: (newest: number) => number): RetainedSpan | null {
  if (records.length === 0) return null;
  let oldest = Infinity;
  let newest = -Infinity;
  for (const record of records) {
    oldest = Math.min(oldest, record.timeMs);
    newest = Math.max(newest, record.timeMs);
  }
  return { startMs: oldest, endMs: endMs(newest) };
}

/** How far back, and up to when, each feed keeps history, judged from the whole feed before filtering. */
const RETENTION: Record<EventSourceId, (records: FeedRecord[], nowMs: number) => RetainedSpan | null> = {
  // The fire feed keeps today and yesterday only.
  fires: (_records, nowMs) => ({ startMs: startOfUtcDay(nowMs) - DAY_MS, endMs: nowMs }),
  // Curated conflict data trails by weeks, so history ends at its newest event.
  conflict: (records) => span(records, (newest) => newest),
  unrest: (records, nowMs) => span(records, () => nowMs),
  outages: (records, nowMs) => span(records, () => nowMs),
};

function nearbyEvents(records: FeedRecord[], point: GeoPoint, countryCode: string | null, window: PassWindow): PointEvent[] {
  const events: PointEvent[] = [];
  for (const record of records) {
    if (record.timeMs < window.startMs || record.timeMs > window.endMs) continue;
    if (record.countryCode) {
      if (record.countryCode.toUpperCase() !== countryCode) continue;
      events.push({ id: record.id, timeMs: record.timeMs, label: record.label, distanceKm: null });
      continue;
    }
    const distanceKm = haversineKm(point.lat, point.lon, record.lat, record.lon);
    if (distanceKm <= EVENT_RADIUS_KM) events.push({ id: record.id, timeMs: record.timeMs, label: record.label, distanceKm });
  }
  return events.sort((a, b) => a.timeMs - b.timeMs);
}

function nearbyLive(records: LiveRecord[], point: GeoPoint): LiveItem[] {
  return records
    .map((record) => ({ id: record.id, label: record.label, distanceKm: haversineKm(point.lat, point.lon, record.lat, record.lon) }))
    .filter((item) => item.distanceKm <= LIVE_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Loads what happened around a point from the same global feeds the dashboard reads and filters them here,
 * so no request carries the point. One failed feed marks only its own lane unavailable.
 */
export async function loadPointContext(
  point: GeoPoint,
  window: PassWindow,
  nowMs: number,
  sources: PointContextSources = defaultSources,
): Promise<PointContext> {
  const countryCode = (await sources.countryAt(point).catch(() => null))?.toUpperCase() ?? null;
  const [events, live] = await Promise.all([
    Promise.all(EVENT_SOURCES.map(async (id): Promise<[EventSourceId, EventLane]> => {
      try {
        const records = await sources.events[id]();
        return [id, { status: 'ok', events: nearbyEvents(records, point, countryCode, window), retained: RETENTION[id](records, nowMs) }];
      } catch {
        return [id, { status: 'unavailable' }];
      }
    })),
    Promise.all(LIVE_SOURCES.map(async (id): Promise<[LiveSourceId, LiveStrip]> => {
      try {
        return [id, { status: 'ok', items: nearbyLive(await sources.live[id](), point) }];
      } catch {
        return [id, { status: 'unavailable' }];
      }
    })),
  ]);
  return {
    events: Object.fromEntries(events) as Record<EventSourceId, EventLane>,
    live: Object.fromEntries(live) as Record<LiveSourceId, LiveStrip>,
  };
}

const defaultSources: PointContextSources = {
  events: {
    conflict: async () => {
      const { fetchUcdpEvents } = await import('@/services/conflict');
      const response = await fetchUcdpEvents();
      if (!response.success) throw new Error('conflict feed unavailable');
      return response.data.map((event) => ({
        id: event.id,
        lat: event.latitude,
        lon: event.longitude,
        timeMs: Date.parse(event.date_start),
        label: `${event.side_a} – ${event.side_b}`,
      }));
    },
    fires: async () => {
      const { fetchAllFires } = await import('@/services/wildfires');
      const result = await fetchAllFires();
      if (result.skipped) throw new Error(`fire feed ${result.reason ?? 'unavailable'}`);
      return Object.values(result.regions).flat().flatMap((fire) => fire.location ? [{
        id: fire.id,
        lat: fire.location.latitude,
        lon: fire.location.longitude,
        timeMs: fire.detectedAt,
        label: `${Math.round(fire.frp)} MW`,
      }] : []);
    },
    unrest: async () => {
      const { fetchProtestEvents } = await import('@/services/unrest');
      const data = await fetchProtestEvents();
      return data.events.map((event) => ({ id: event.id, lat: event.lat, lon: event.lon, timeMs: event.time.getTime(), label: event.title }));
    },
    outages: async () => {
      const { fetchInternetOutages } = await import('@/services/infrastructure');
      const outages = await fetchInternetOutages();
      return outages.map((outage) => ({
        id: outage.id,
        lat: outage.lat,
        lon: outage.lon,
        timeMs: outage.pubDate.getTime(),
        label: outage.title,
        countryCode: outage.country,
      }));
    },
  },
  live: {
    vessels: async () => {
      const { fetchAisSignals, getAisStatus } = await import('@/services/maritime');
      // Reading the vessel feed starts its costly relay polling, so only join a feed the map already runs.
      if (!getAisStatus().connected) throw new Error('vessel feed not running');
      const { disruptions, density } = await fetchAisSignals();
      return [
        ...disruptions.map((event) => ({ id: event.id, lat: event.lat, lon: event.lon, label: event.name })),
        ...density.map((zone) => ({ id: zone.id, lat: zone.lat, lon: zone.lon, label: zone.name })),
      ];
    },
    'military-flights': async () => {
      const { fetchMilitaryFlights } = await import('@/services/military-flights');
      const { flights, dataState } = await fetchMilitaryFlights();
      if (dataState.mode === 'unavailable') throw new Error('military flights unavailable');
      return flights.map((flight) => ({ id: flight.id, lat: flight.lat, lon: flight.lon, label: flight.callsign || flight.hexCode }));
    },
    'gps-jamming': async () => {
      const { fetchGpsInterference } = await import('@/services/gps-interference');
      const data = await fetchGpsInterference();
      if (!data) throw new Error('GPS interference unavailable');
      return data.hexes.map((hex) => ({ id: hex.h3, lat: hex.lat, lon: hex.lon, label: `${Math.round(hex.pct)}%` }));
    },
  },
  countryAt: async (point) => {
    const { getCountryAtCoordinates } = await import('@/services/country-geometry');
    return getCountryAtCoordinates(point.lat, point.lon)?.code ?? null;
  },
};
