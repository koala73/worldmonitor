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

function snapshotInputs<T extends { lat: number; lon: number }>(
  rows: readonly T[],
  time: (row: T) => number | undefined,
): Array<{ lat: number; lon: number; time?: number }> {
  return rows.map((row) => {
    const stamp = time(row);
    return stamp == null ? { lat: row.lat, lon: row.lon } : { lat: row.lat, lon: row.lon, time: stamp };
  });
}

export function ingestProtests(events: SocialUnrestEvent[]): void {
  engine.replaceEvents(snapshotInputs(events, (event) => toEpochMs(event.time)), 'protest');
}

export function ingestFlights(flights: MilitaryFlight[]): void {
  engine.replaceEvents(snapshotInputs(flights, (flight) => toEpochMs(flight.lastSeen)), 'military_flight');
}

export function ingestVessels(vessels: MilitaryVessel[]): void {
  engine.replaceEvents(snapshotInputs(vessels, (vessel) => toEpochMs(vessel.lastAisUpdate)), 'military_vessel');
}

export function ingestEarthquakes(quakes: Earthquake[]): void {
  engine.replaceEvents(
    quakes.map((quake) => ({
      lat: quake.location?.latitude ?? 0,
      lon: quake.location?.longitude ?? 0,
      time: new Date(quake.occurredAt).getTime(),
    })),
    'earthquake',
  );
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
