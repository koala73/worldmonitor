import type { SocialUnrestEvent, MilitaryFlight, MilitaryVessel } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import { generateSignalId } from '@/utils/analysis-constants';
import type { CorrelationSignalCore } from './analysis-core';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, STRATEGIC_WATERWAYS } from '@/config/geo';
import {
  GeoConvergenceEngine,
  geoConvergenceToSignal as toSignal,
  getLocationName as reverseGeocode,
  type GeoConvergenceAlert,
  type GeoEventType,
  type GeoPlaceDatasets,
} from '../../shared/analysis-geo-convergence';

export { getCellId } from '../../shared/analysis-geo-convergence';
export type { GeoEventType, GeoConvergenceAlert } from '../../shared/analysis-geo-convergence';

// Pinned by tests/docs-signal-alignment.test.mts, which cross-checks this literal
// against docs/geographic-convergence.mdx; tests/analysis-geo-convergence.test.mjs
// asserts it still matches the shared core's default.
const CONVERGENCE_THRESHOLD = 3;

const PLACES: GeoPlaceDatasets = {
  conflictZones: CONFLICT_ZONES,
  waterways: STRATEGIC_WATERWAYS,
  hotspots: INTEL_HOTSPOTS,
};

// Browser-lifetime grid. Server callers build their own engine instead.
const engine = new GeoConvergenceEngine({ convergenceThreshold: CONVERGENCE_THRESHOLD });

function toEpochMs(value: Date | undefined): number | undefined {
  return value ? value.getTime() : undefined;
}

export function ingestGeoEvent(
  lat: number,
  lon: number,
  type: GeoEventType,
  timestamp: Date = new Date()
): void {
  engine.ingest(lat, lon, type, timestamp.getTime());
}

export function ingestProtests(events: SocialUnrestEvent[]): void {
  for (const e of events) {
    engine.ingest(e.lat, e.lon, 'protest', toEpochMs(e.time));
  }
}

export function ingestFlights(flights: MilitaryFlight[]): void {
  for (const f of flights) {
    engine.ingest(f.lat, f.lon, 'military_flight', toEpochMs(f.lastSeen));
  }
}

export function ingestVessels(vessels: MilitaryVessel[]): void {
  for (const v of vessels) {
    engine.ingest(v.lat, v.lon, 'military_vessel', toEpochMs(v.lastAisUpdate));
  }
}

export function ingestEarthquakes(quakes: Earthquake[]): void {
  for (const q of quakes) {
    engine.ingest(
      q.location?.latitude ?? 0,
      q.location?.longitude ?? 0,
      'earthquake',
      new Date(q.occurredAt).getTime()
    );
  }
}

export function detectGeoConvergence(seenAlerts: Set<string>): GeoConvergenceAlert[] {
  return engine.detect(seenAlerts);
}

// Reverse geocode coordinates to human-readable location
export function getLocationName(lat: number, lon: number): string {
  return reverseGeocode(lat, lon, PLACES);
}

export function geoConvergenceToSignal(alert: GeoConvergenceAlert): CorrelationSignalCore {
  return toSignal(alert, { places: PLACES, generateId: generateSignalId });
}

export function detectConvergence(): GeoConvergenceAlert[] {
  return detectGeoConvergence(new Set());
}

export function clearCells(): void {
  engine.clear();
}

export function getCellCount(): number {
  return engine.cellCount();
}

export function debugGetCells(): Map<string, unknown> {
  return new Map(
    engine.snapshot().map(cell => [
      cell.id,
      {
        id: cell.id,
        lat: cell.lat,
        lon: cell.lon,
        events: new Map(cell.events.map(e => [e.type, { count: e.count, lastSeen: new Date(e.lastSeen) }])),
        firstSeen: new Date(cell.firstSeen),
      },
    ])
  );
}

export function getAlertsNearLocation(lat: number, lon: number, radiusKm: number): { score: number; types: number } | null {
  return engine.alertsNear(lat, lon, radiusKm);
}
