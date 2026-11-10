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
}

export function enrichEventsWithExposure(
  events: EventForExposure[],
  limit = events.length,
): PopulationExposure[] {
  const exposures: PopulationExposure[] = [];
  for (const event of events) {
    if (exposures.length >= limit) break;
    if (event.hasPreciseLocation !== true) continue;
    const exposure = estimateExposure(event.lat, event.lon, event.country, getRadiusForEventType(event.type));
    if (!exposure) continue;

    exposures.push({
      eventId: event.id,
      eventName: event.name,
      eventType: event.type,
      lat: event.lat,
      lon: event.lon,
      exposedPopulation: exposure.exposedPopulation,
      exposureRadiusKm: exposure.exposureRadiusKm,
    });
  }
  return exposures;
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
