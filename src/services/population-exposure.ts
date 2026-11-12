import { exposureLocationKey } from '../../scripts/shared/exposure-location-key.mjs';
import { ucdpExposureName } from '../../shared/ucdp-display';
import type { ExposureCoverage, PopulationExposure } from '@/types';
import {
  estimateExposure,
  getRadiusForEventType,
} from '../../shared/analysis-population-exposure';

interface EventForExposure {
  id: string;
  name: string;
  /** Present for UCDP inputs, including an empty place name. */
  locationName?: string;
  type: string;
  country: string;
  hasPreciseLocation?: boolean;
  lat: number;
  lon: number;
  eventCount?: number;
}

export function enrichEventsWithExposure(
  events: EventForExposure[],
  limit = events.length,
  allowUnknownPrecision = false,
): { exposures: PopulationExposure[]; coverage: ExposureCoverage } {
  const byLocation = new Map<string, PopulationExposure>();
  const coverage: ExposureCoverage = { totalEvents: 0, withoutPreciseLocation: 0, withoutEstimate: 0, atOtherPlaces: 0 };
  for (const event of events) {
    const eventCount = event.eventCount ?? 1;
    coverage.totalEvents += eventCount;
    const locationPending = allowUnknownPrecision && event.hasPreciseLocation === undefined;
    if (event.hasPreciseLocation !== true && !locationPending) {
      coverage.withoutPreciseLocation += eventCount;
      continue;
    }
    const exposure = estimateExposure(event.lat, event.lon, event.country, getRadiusForEventType(event.type));
    if (!exposure) {
      coverage.withoutEstimate += eventCount;
      continue;
    }

    const key = exposureLocationKey(event.lat, event.lon);
    const existing = byLocation.get(key);
    if (existing) {
      existing.eventCount += eventCount;
      if (locationPending) existing.locationPending = true;
      continue;
    }
    if (byLocation.size >= limit) {
      coverage.atOtherPlaces += eventCount;
      continue;
    }

    byLocation.set(key, {
      eventId: event.id,
      eventName: event.locationName !== undefined
        ? ucdpExposureName(event.locationName, event.country, exposure.country)
        : event.name,
      eventType: event.type,
      lat: event.lat,
      lon: event.lon,
      exposedPopulation: exposure.exposedPopulation,
      exposureRadiusKm: exposure.exposureRadiusKm,
      eventCount,
      ...(locationPending ? { locationPending: true } : {}),
    });
  }
  return { exposures: [...byLocation.values()], coverage };
}

export function addExposureCoverage(a: ExposureCoverage, b: ExposureCoverage): ExposureCoverage {
  return {
    totalEvents: a.totalEvents + b.totalEvents,
    withoutPreciseLocation: a.withoutPreciseLocation + b.withoutPreciseLocation,
    withoutEstimate: a.withoutEstimate + b.withoutEstimate,
    atOtherPlaces: a.atOtherPlaces + b.atOtherPlaces,
  };
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
