/**
 * Geographic convergence core — dependency-free so it can run in the browser
 * bundle, on Vercel Edge, and inside esbuild-bundled server handlers alike.
 *
 * Nothing here reaches for the DOM, bundler-injected module metadata, or the
 * `@/` alias. The client wrapper lives in `src/services/geo-convergence.ts`;
 * server callers construct their own `GeoConvergenceEngine` per request.
 */

import { haversineKm } from './geo-distance';

export { haversineKm } from './geo-distance';

export type GeoEventType = 'protest' | 'military_flight' | 'military_vessel' | 'earthquake';

/** Events older than this drop out of a cell. */
export const GEO_CONVERGENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Distinct domains that must co-occur in one cell before it alerts. */
export const GEO_CONVERGENCE_THRESHOLD = 3;
/** Proximity lookups report cells with at least this many domains. */
export const GEO_NEARBY_MIN_TYPES = 2;

/** Reverse-geocode search radii, most specific first. */
export const GEO_CONFLICT_ZONE_RADIUS_KM = 300;
export const GEO_WATERWAY_RADIUS_KM = 200;
export const GEO_HOTSPOT_RADIUS_KM = 150;

export const GEO_EVENT_TYPE_LABELS: Record<GeoEventType, string> = {
  protest: 'protests',
  military_flight: 'military flights',
  military_vessel: 'naval vessels',
  earthquake: 'seismic activity',
};

/** Minimal shape every domain feed collapses to before ingestion. */
export interface GeoEventInput {
  lat: number;
  lon: number;
  /** Epoch ms; falls back to the engine clock when omitted. */
  time?: number;
}

export interface GeoConvergenceAlert {
  cellId: string;
  lat: number;
  lon: number;
  types: GeoEventType[];
  totalEvents: number;
  score: number;
}

export interface GeoCellEventSnapshot {
  type: GeoEventType;
  count: number;
  /** Epoch ms. */
  lastSeen: number;
}

export interface GeoCellSnapshot {
  id: string;
  lat: number;
  lon: number;
  /** Epoch ms of the first event that created the cell. */
  firstSeen: number;
  events: GeoCellEventSnapshot[];
}

export interface GeoNearbyConvergence {
  score: number;
  types: number;
}

/** Structural view of a named point (intel hotspot, strategic waterway). */
export interface GeoNamedPlace {
  name: string;
  lat: number;
  lon: number;
}

/** Structural view of a conflict zone. `center` is GeoJSON order: [lon, lat]. */
export interface GeoConflictZoneCenter {
  name: string;
  center: readonly [number, number];
}

/** Named-place datasets injected by the caller; the core ships no geography. */
export interface GeoPlaceDatasets {
  conflictZones?: readonly GeoConflictZoneCenter[];
  waterways?: readonly GeoNamedPlace[];
  hotspots?: readonly GeoNamedPlace[];
}

export function getCellId(lat: number, lon: number): string {
  return `${Math.floor(lat)},${Math.floor(lon)}`;
}

/** 25 points per co-occurring domain, plus a volume boost capped at 25. */
export function scoreGeoCell(typeCount: number, totalEvents: number): number {
  const typeScore = typeCount * 25;
  const countBoost = Math.min(25, totalEvents * 2);
  return Math.min(100, typeScore + countBoost);
}

/** Reverse-geocode a coordinate against caller-supplied named places. */
export function getLocationName(lat: number, lon: number, places: GeoPlaceDatasets = {}): string {
  // Check conflict zones first (most relevant for convergence)
  for (const zone of places.conflictZones ?? []) {
    const [zoneLon, zoneLat] = zone.center;
    const dist = haversineKm(lat, lon, zoneLat, zoneLon);
    if (dist < GEO_CONFLICT_ZONE_RADIUS_KM) {
      return zone.name.replace(' Conflict', '').replace(' Civil War', '');
    }
  }

  // Check strategic waterways
  for (const waterway of places.waterways ?? []) {
    const dist = haversineKm(lat, lon, waterway.lat, waterway.lon);
    if (dist < GEO_WATERWAY_RADIUS_KM) {
      return waterway.name;
    }
  }

  // Check intel hotspots (major cities)
  let nearestHotspot: { name: string; dist: number } | null = null;
  for (const hotspot of places.hotspots ?? []) {
    const dist = haversineKm(lat, lon, hotspot.lat, hotspot.lon);
    if (dist < GEO_HOTSPOT_RADIUS_KM && (!nearestHotspot || dist < nearestHotspot.dist)) {
      nearestHotspot = { name: hotspot.name, dist };
    }
  }
  if (nearestHotspot) {
    // Return just the name - caller adds "in" prefix
    return nearestHotspot.name;
  }

  // Regional fallback based on lat/lon ranges
  if (lat >= 25 && lat <= 40 && lon >= 25 && lon <= 75) return 'Middle East';
  if (lat >= 30 && lat <= 45 && lon >= 100 && lon <= 145) return 'East Asia';
  if (lat >= -10 && lat <= 25 && lon >= 90 && lon <= 130) return 'Southeast Asia';
  if (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) return 'Europe';
  if (lat >= 44 && lat <= 75 && lon >= 20 && lon <= 180) return 'Russia';
  if (lat >= -35 && lat <= 35 && lon >= -20 && lon <= 55) return 'Africa';
  if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) return 'North America';
  if (lat >= -60 && lat <= 15 && lon >= -80 && lon <= -30) return 'South America';

  return `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
}

/**
 * Structurally identical to the client's `CorrelationSignalCore`, restated here
 * so the core does not depend on src/ types.
 */
export interface GeoConvergenceSignal {
  id: string;
  type: 'geo_convergence';
  title: string;
  description: string;
  confidence: number;
  timestamp: Date;
  data: {
    newsVelocity: number;
    relatedTopics: GeoEventType[];
  };
}

export interface GeoSignalOptions {
  places?: GeoPlaceDatasets;
  /** Defaults to `sig-<uuid>`; the client injects its shared id generator. */
  generateId?: () => string;
  now?: () => Date;
}

export function geoConvergenceToSignal(
  alert: GeoConvergenceAlert,
  options: GeoSignalOptions = {},
): GeoConvergenceSignal {
  const typeDescriptions = alert.types.map((t) => GEO_EVENT_TYPE_LABELS[t]).join(', ');
  const locationName = getLocationName(alert.lat, alert.lon, options.places ?? {});

  return {
    id: options.generateId ? options.generateId() : `sig-${crypto.randomUUID()}`,
    type: 'geo_convergence',
    title: `Geographic Convergence (${alert.types.length} types)`,
    description: `${typeDescriptions} in ${locationName} - ${alert.totalEvents} events/24h`,
    confidence: alert.score / 100,
    timestamp: options.now ? options.now() : new Date(),
    data: {
      newsVelocity: alert.totalEvents,
      relatedTopics: alert.types,
    },
  };
}

export interface GeoConvergenceEngineOptions {
  windowMs?: number;
  convergenceThreshold?: number;
  nearbyMinTypes?: number;
  /** Epoch-ms clock; injectable so pruning is deterministic under test. */
  now?: () => number;
}

interface GeoCell {
  id: string;
  lat: number;
  lon: number;
  events: Map<GeoEventType, { count: number; lastSeen: number }>;
  firstSeen: number;
}

/**
 * Rolling one-degree grid of multi-domain activity. Each instance owns its own
 * cells, so a server request can build a throwaway engine without touching the
 * long-lived client one.
 */
export class GeoConvergenceEngine {
  private readonly cells = new Map<string, GeoCell>();
  private readonly windowMs: number;
  private readonly convergenceThreshold: number;
  private readonly nearbyMinTypes: number;
  private readonly now: () => number;

  constructor(options: GeoConvergenceEngineOptions = {}) {
    this.windowMs = options.windowMs ?? GEO_CONVERGENCE_WINDOW_MS;
    this.convergenceThreshold = options.convergenceThreshold ?? GEO_CONVERGENCE_THRESHOLD;
    this.nearbyMinTypes = options.nearbyMinTypes ?? GEO_NEARBY_MIN_TYPES;
    this.now = options.now ?? (() => Date.now());
  }

  ingest(lat: number, lon: number, type: GeoEventType, timestamp: number = this.now()): void {
    const cellId = getCellId(lat, lon);

    let cell = this.cells.get(cellId);
    if (!cell) {
      cell = {
        id: cellId,
        lat: Math.floor(lat) + 0.5,
        lon: Math.floor(lon) + 0.5,
        events: new Map(),
        firstSeen: timestamp,
      };
      this.cells.set(cellId, cell);
    }

    const existing = cell.events.get(type);
    cell.events.set(type, {
      count: (existing?.count ?? 0) + 1,
      lastSeen: timestamp,
    });
  }

  ingestEvents(events: readonly GeoEventInput[], type: GeoEventType): void {
    for (const e of events) {
      this.ingest(e.lat, e.lon, type, e.time ?? this.now());
    }
  }

  /**
   * Emit one alert per cell that has reached the domain threshold, skipping any
   * cell id already in `seenAlerts`. Newly alerted ids are added to that set.
   */
  detect(seenAlerts: Set<string>): GeoConvergenceAlert[] {
    this.prune();

    const alerts: GeoConvergenceAlert[] = [];

    for (const [cellId, cell] of this.cells) {
      if (cell.events.size >= this.convergenceThreshold) {
        if (seenAlerts.has(cellId)) continue;

        const types = Array.from(cell.events.keys());
        const totalEvents = Array.from(cell.events.values()).reduce((sum, d) => sum + d.count, 0);

        alerts.push({
          cellId,
          lat: cell.lat,
          lon: cell.lon,
          types,
          totalEvents,
          score: scoreGeoCell(cell.events.size, totalEvents),
        });
        seenAlerts.add(cellId);
      }
    }

    return alerts.sort((a, b) => b.score - a.score);
  }

  /** Strongest multi-domain cell within `radiusKm`, or null if there is none. */
  alertsNear(lat: number, lon: number, radiusKm: number): GeoNearbyConvergence | null {
    this.prune();

    let maxScore = 0;
    let maxTypes = 0;

    for (const cell of this.cells.values()) {
      const dist = haversineKm(lat, lon, cell.lat, cell.lon);
      if (dist <= radiusKm && cell.events.size >= this.nearbyMinTypes) {
        const types = cell.events.size;
        const totalEvents = Array.from(cell.events.values()).reduce((sum, d) => sum + d.count, 0);
        const score = scoreGeoCell(types, totalEvents);

        if (score > maxScore) {
          maxScore = score;
          maxTypes = types;
        }
      }
    }

    return maxScore > 0 ? { score: maxScore, types: maxTypes } : null;
  }

  clear(): void {
    this.cells.clear();
  }

  /** Live cell count — deliberately does not prune. */
  cellCount(): number {
    return this.cells.size;
  }

  /** Detached copy of the grid for debugging; deliberately does not prune. */
  snapshot(): GeoCellSnapshot[] {
    return Array.from(this.cells.values(), (cell) => ({
      id: cell.id,
      lat: cell.lat,
      lon: cell.lon,
      firstSeen: cell.firstSeen,
      events: Array.from(cell.events, ([type, data]) => ({
        type,
        count: data.count,
        lastSeen: data.lastSeen,
      })),
    }));
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;

    for (const [cellId, cell] of this.cells) {
      for (const [type, data] of cell.events) {
        if (data.lastSeen < cutoff) {
          cell.events.delete(type);
        }
      }
      if (cell.events.size === 0) {
        this.cells.delete(cellId);
      }
    }
  }
}
