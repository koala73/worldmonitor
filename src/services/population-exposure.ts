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
}

export function enrichEventsWithExposure(
  events: EventForExposure[],
): PopulationExposure[] {
  return events
    .flatMap((event): PopulationExposure[] => {
      if (event.hasPreciseLocation !== true || !Number.isFinite(event.lat) || !Number.isFinite(event.lon)
        || Math.abs(event.lat) > 90 || Math.abs(event.lon) > 180 || (event.lat === 0 && event.lon === 0)) return [];
      const country = resolveCountryCode(event.country);
      const density = country ? densityByCountry.get(country) : undefined;
      if (density === undefined) return [];

      const radius = getRadiusForEventType(event.type);
      return [{
        eventId: event.id,
        eventName: event.name,
        eventType: event.type,
        lat: event.lat,
        lon: event.lon,
        exposedPopulation: Math.round(density * Math.PI * radius ** 2),
        exposureRadiusKm: radius,
      }];
    })
    .sort((a, b) => b.exposedPopulation - a.exposedPopulation);
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
