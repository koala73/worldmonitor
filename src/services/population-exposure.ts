import type { PopulationExposure } from '@/types';
import {
  getRadiusForEventType,
  PRIORITY_COUNTRIES,
} from '../../shared/analysis-population-exposure';
import { resolveCountryCode } from '../../shared/country-code-resolve';

const densityByCountry = new Map(Object.entries(PRIORITY_COUNTRIES).map(([iso3, { pop, area }]) =>
  [resolveCountryCode(iso3), pop / area] as const,
));

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
    if (event.hasPreciseLocation !== true || !Number.isFinite(event.lat) || !Number.isFinite(event.lon)
      || Math.abs(event.lat) > 90 || Math.abs(event.lon) > 180 || (event.lat === 0 && event.lon === 0)) continue;
    const country = resolveCountryCode(event.country);
    const density = country ? densityByCountry.get(country) : undefined;
    if (density === undefined) continue;

    const eventCount = event.eventCount ?? 1;
    const key = locationKey(event.lat, event.lon);
    const existing = byLocation.get(key);
    if (existing) {
      existing.eventCount += eventCount;
      continue;
    }
    if (byLocation.size >= limit) continue;

    const radius = getRadiusForEventType(event.type);
    byLocation.set(key, {
      eventId: event.id,
      eventName: event.name,
      eventType: event.type,
      lat: event.lat,
      lon: event.lon,
      exposedPopulation: Math.round(density * Math.PI * radius ** 2),
      exposureRadiusKm: radius,
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
