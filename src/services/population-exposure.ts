import type { PopulationExposure } from '@/types';
import {
  estimateExposure,
  getRadiusForEventType,
} from '../../shared/analysis-population-exposure';

interface EventForExposure {
  id: string;
  name: string;
  type: string;
  country: string;
  hasPreciseLocation?: boolean;
  lat: number;
  lon: number;
  eventCount?: number;
}

// UCDP reports separate events at one geocoded point. Rounding to about 100 m
// folds them; scripts/_ucdp-dashboard.mjs groups its exposure rows the same way.
function locationKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

export function enrichEventsWithExposure(
  events: EventForExposure[],
  limit = events.length,
): PopulationExposure[] {
  const byLocation = new Map<string, PopulationExposure>();
  for (const event of events) {
    if (event.hasPreciseLocation !== true) continue;
    const exposure = estimateExposure(event.lat, event.lon, event.country, getRadiusForEventType(event.type));
    if (!exposure) continue;

    const eventCount = event.eventCount ?? 1;
    const key = locationKey(event.lat, event.lon);
    const existing = byLocation.get(key);
    if (existing) {
      existing.eventCount += eventCount;
      continue;
    }
    if (byLocation.size >= limit) continue;

    byLocation.set(key, {
      eventId: event.id,
      eventName: event.name,
      eventType: event.type,
      lat: event.lat,
      lon: event.lon,
      exposedPopulation: exposure.exposedPopulation,
      exposureRadiusKm: exposure.exposureRadiusKm,
      eventCount,
    });
  }
  return [...byLocation.values()];
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
