import type { PopulationExposure } from '@/types';
import {
  computeExposure,
  getRadiusForEventType,
} from '../../shared/analysis-population-exposure';

interface EventForExposure {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

export function enrichEventsWithExposure(
  events: EventForExposure[],
): PopulationExposure[] {
  return events
    .map((event) => {
      const radius = getRadiusForEventType(event.type);
      const exposure = computeExposure(event.lat, event.lon, radius);
      return {
        eventId: event.id,
        eventName: event.name,
        eventType: event.type,
        lat: event.lat,
        lon: event.lon,
        exposedPopulation: exposure.exposedPopulation,
        exposureRadiusKm: radius,
      } as PopulationExposure;
    })
    .sort((a, b) => b.exposedPopulation - a.exposedPopulation);
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
