/**
 * Seed-payload -> shared-analysis-core adapters.
 *
 * The shared cores under `shared/analysis-*.ts` take clean structural inputs.
 * The Redis seed payloads they are fed from server-side (MCP tools, Edge
 * handlers) are the seeders' own shapes, which differ per domain: some nest
 * coordinates under `location.latitude`, some carry them flat, some only have
 * region-level coordinates. Every one of those translations lives here as a
 * pure function so it can be unit-tested against realistic fixtures without
 * standing up Redis — `_execute` bodies keep the IO and nothing else.
 *
 * Dependency-free by the same rule as the cores: no `src/`, no `@/`, no DOM,
 * so this module survives the `api/mcp.ts` esbuild edge bundle.
 */

import {
  type EntityIndex,
  findEntitiesInText,
} from './entity-extraction-core.js';
import {
  GEO_CONVERGENCE_WINDOW_MS,
  type GeoEventInput,
  type GeoPlaceDatasets,
} from './analysis-geo-convergence';
import type {
  CountrySignalCluster,
  FocalClusterInput,
  GeoSignal,
  SignalSummary,
  SignalType,
} from './analysis-focal-points';
import type { CableInput, WaterwayInput } from './analysis-infrastructure-cascade';
import type {
  MilitaryFlightInput,
  TheaterActivity,
  TheaterPostureSummary,
} from './analysis-military-surge';
import { CONFLICT_ZONES, INTEL_HOTSPOTS, STRATEGIC_WATERWAYS } from './geo-data';
import {
  asArray,
  asRecord,
  finiteNumber,
  nestedLocation,
  nonEmptyString,
  usableCoord,
} from './analysis-adapter-guards';
import {
  hasRedistributableProviderAttribution,
} from './provider-redistribution';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------



/** Array field off a payload object, tolerating null / wrong-typed payloads. */
function arrayField(payload: unknown, field: string): unknown[] {
  const record = asRecord(payload);
  return record ? asArray(record[field]) : [];
}



/**
 * A coordinate pair is usable when both components are finite, in range, and
 * not exactly (0, 0). Null island is the "location unknown" sentinel of
 * several upstreams (USNI region lookup misses, geocoder failures); left in,
 * every domain's junk stacks into the same 1-degree cell and manufactures a
 * four-domain "convergence" out of nothing.
 */

export interface GeoAdapterOptions {
  /** Epoch-ms clock. Injected so window trimming is deterministic under test. */
  now?: number;
  /** Events older than this drop out; defaults to the core's 24h window. */
  windowMs?: number;
}

function flightProviderAttribution(record: Record<string, unknown>): unknown {
  const sourceMeta = asRecord(record.sourceMeta);
  return nonEmptyString(sourceMeta?.source) || nonEmptyString(record.source);
}

// ---------------------------------------------------------------------------
// get_signal_convergence — four domain feeds -> GeoEventInput
// ---------------------------------------------------------------------------

/**
 * Collapse one seeded feed into the core's `GeoEventInput` shape.
 *
 * Window trimming happens HERE rather than being left to the engine's own
 * `prune()`: the engine records `lastSeen` as the timestamp of the most
 * recently *ingested* event for a (cell, type) pair, not the maximum, so an
 * out-of-order stale record can retroactively age a live cell out of the grid.
 * Filtering first makes the result independent of feed ordering.
 */
function toGeoEvents(
  records: unknown[],
  readCoord: (record: Record<string, unknown>) => { lat: number | null; lon: number | null },
  readTime: (record: Record<string, unknown>) => number | null,
  fallbackTime: number | null,
  options: GeoAdapterOptions,
): GeoEventInput[] {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? GEO_CONVERGENCE_WINDOW_MS;
  const cutoff = now - windowMs;
  const events: GeoEventInput[] = [];

  for (const raw of records) {
    const record = asRecord(raw);
    if (!record) continue;
    const { lat, lon } = readCoord(record);
    if (!usableCoord(lat, lon) || lon === null) continue;
    // No per-record timestamp -> the payload's own fetch time -> the clock.
    // Every one of these caches is a live snapshot, so "now" is the honest
    // approximation of last-observed when the record carries nothing.
    const time = readTime(record) ?? fallbackTime ?? now;
    if (time < cutoff) continue;
    events.push({ lat, lon, time });
  }

  return events;
}


/** `unrest:events:v1` -> protest events. */
export function unrestEventsToGeoEvents(payload: unknown, options: GeoAdapterOptions = {}): GeoEventInput[] {
  return toGeoEvents(
    arrayField(payload, 'events'),
    nestedLocation,
    (record) => finiteNumber(record.occurredAt),
    finiteNumber(asRecord(payload)?.fetchedAt),
    options,
  );
}

/** `military:flights:v1` -> military-flight events. */
export function militaryFlightsToGeoEvents(payload: unknown, options: GeoAdapterOptions = {}): GeoEventInput[] {
  return toGeoEvents(
    arrayField(payload, 'flights').filter((flight) => {
      const record = asRecord(flight);
      return record !== null && hasRedistributableProviderAttribution(flightProviderAttribution(record));
    }),
    (record) => ({ lat: finiteNumber(record.lat), lon: finiteNumber(record.lon) }),
    (record) => finiteNumber(record.lastSeenMs),
    finiteNumber(asRecord(payload)?.fetchedAt),
    options,
  );
}

/** `seismology:earthquakes:v1` -> earthquake events. */
export function earthquakesToGeoEvents(payload: unknown, options: GeoAdapterOptions = {}): GeoEventInput[] {
  return toGeoEvents(
    arrayField(payload, 'earthquakes'),
    nestedLocation,
    (record) => finiteNumber(record.occurredAt),
    finiteNumber(asRecord(payload)?.fetchedAt),
    options,
  );
}

/**
 * `usni-fleet:sebuf:v1` -> naval-vessel events.
 *
 * The USNI fleet tracker is a prose article: vessels are placed at their
 * REGION centroid (`regionLat`/`regionLon`), not a real position, and an
 * unrecognised region name yields (0, 0) — dropped by `usableCoord`. The
 * article has no per-vessel timestamp, so every vessel inherits the payload's
 * parse time.
 */
export function usniVesselsToGeoEvents(payload: unknown, options: GeoAdapterOptions = {}): GeoEventInput[] {
  return toGeoEvents(
    arrayField(payload, 'vessels'),
    (record) => ({ lat: finiteNumber(record.regionLat), lon: finiteNumber(record.regionLon) }),
    () => null,
    finiteNumber(asRecord(payload)?.timestamp),
    options,
  );
}

/**
 * Named-place datasets for the core's reverse geocoder. `getLocationName`
 * reads conflict-zone centres in GeoJSON order ([lon, lat]) but waterways and
 * hotspots as flat {lat, lon}, which is exactly how the curated datasets are
 * already stored — so this is a projection, not a conversion.
 */
export const MCP_GEO_PLACES: GeoPlaceDatasets = {
  conflictZones: CONFLICT_ZONES.map((zone) => ({ name: zone.name, center: zone.center })),
  waterways: STRATEGIC_WATERWAYS.map((waterway) => ({
    name: waterway.name,
    lat: waterway.lat,
    lon: waterway.lon,
  })),
  hotspots: INTEL_HOTSPOTS.map((hotspot) => ({
    name: hotspot.name,
    lat: hotspot.lat,
    lon: hotspot.lon,
  })),
};

// ---------------------------------------------------------------------------
// get_focal_points — news clusters + cross-source signals
// ---------------------------------------------------------------------------

/**
 * `news:insights:v1` -> `FocalClusterInput`.
 *
 * The insights payload has no cluster id (`topStories` is a flat ranked list),
 * so the position in that ranking IS the identity. Ids must only be stable and
 * unique within one analysis pass — the core uses them to join entity contexts
 * back to their cluster.
 */
export function insightsToFocalClusters(payload: unknown): FocalClusterInput[] {
  const clusters: FocalClusterInput[] = [];

  for (const [index, raw] of arrayField(payload, 'topStories').entries()) {
    const record = asRecord(raw);
    if (!record) continue;
    const primaryTitle = nonEmptyString(record.primaryTitle);
    // No title means no entity signal at all; an empty cluster would only make
    // the core iterate over nothing.
    if (!primaryTitle) continue;

    const memberTitles = asArray(record.memberTitles)
      .map((title) => nonEmptyString(title))
      .filter(Boolean)
      .map((title) => ({ title }));

    clusters.push({
      id: `insights-${index}`,
      primaryTitle,
      primaryLink: nonEmptyString(record.primaryLink),
      allItems: memberTitles.length > 0 ? memberTitles : [{ title: primaryTitle }],
    });
  }

  return clusters;
}

/**
 * Cross-source signal family -> the focal core's `SignalType`.
 *
 * Deliberately partial. The focal core scores a fixed set of map-signal
 * families; a cross-source family with no counterpart (VIX spikes, commodity
 * shocks, weather) is counted as unmapped rather than being forced onto the
 * nearest-looking type, which would corrupt the signal-type-count component of
 * the focal score.
 */
export const CROSS_SOURCE_TO_FOCAL_SIGNAL: Record<string, SignalType> = {
  CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE: 'military_flight',
  CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE: 'protest',
  CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE: 'internet_outage',
  CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION: 'ais_disruption',
  CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE: 'satellite_fire',
  CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY: 'radiation_anomaly',
  CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE: 'sanctions_pressure',
  CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER: 'active_strike',
};

const CROSS_SOURCE_SEVERITY: Record<string, GeoSignal['severity']> = {
  CROSS_SOURCE_SIGNAL_SEVERITY_LOW: 'low',
  CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM: 'medium',
  CROSS_SOURCE_SIGNAL_SEVERITY_HIGH: 'high',
  // The focal core's severity ladder tops out at 'high'.
  CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL: 'high',
};

export interface CrossSourceSignalMapping {
  summary: SignalSummary;
  /** Signals present in the payload. */
  signalsTotal: number;
  /** Signals that resolved to BOTH a focal signal type and >=1 country. */
  signalsMapped: number;
  /** Signals dropped because the family or the geography could not be resolved. */
  signalsUnmapped: number;
}

/**
 * `intelligence:cross-source-signals:v1` -> the focal core's `SignalSummary`.
 *
 * The signals are keyed by THEATER ("Middle East", "East Asia"), a coarse
 * region label with no country field, while the focal core keys map signals by
 * country entity id. Rather than hand-rolling a theater->country table (which
 * would attribute a Middle East signal to every country in the region), each
 * signal's own prose is run through the same entity index the news half uses
 * and only country-typed matches are kept. Signals that name no country stay
 * unmapped and are reported as such — the caller surfaces the count so a thin
 * result is legible instead of looking like an outage.
 */
export function crossSourceSignalsToSignalSummary(
  payload: unknown,
  index: EntityIndex,
): CrossSourceSignalMapping {
  const raw = arrayField(payload, 'signals');
  const byCountry = new Map<string, CountrySignalCluster>();
  let signalsMapped = 0;

  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;

    const focalType = CROSS_SOURCE_TO_FOCAL_SIGNAL[nonEmptyString(record.type)];
    if (!focalType) continue;

    const severity = CROSS_SOURCE_SEVERITY[nonEmptyString(record.severity)] ?? 'low';
    const text = `${nonEmptyString(record.summary)} ${nonEmptyString(record.theater)}`.trim();
    const countries = [
      ...new Set(
        findEntitiesInText(text, index)
          .filter((match) => index.byId.get(match.entityId)?.type === 'country')
          .map((match) => match.entityId),
      ),
    ];
    if (countries.length === 0) continue;

    signalsMapped += 1;
    for (const country of countries) {
      let cluster = byCountry.get(country);
      if (!cluster) {
        cluster = {
          country,
          signals: [],
          signalTypes: new Set<SignalType>(),
          totalCount: 0,
          highSeverityCount: 0,
        };
        byCountry.set(country, cluster);
      }
      cluster.signals.push({ type: focalType, severity });
      cluster.signalTypes.add(focalType);
      cluster.totalCount += 1;
      if (severity === 'high') cluster.highSeverityCount += 1;
    }
  }

  const topCountries = [...byCountry.values()].sort(
    (a, b) => b.highSeverityCount - a.highSeverityCount || b.totalCount - a.totalCount,
  );

  return {
    summary: { topCountries },
    signalsTotal: raw.length,
    signalsMapped,
    signalsUnmapped: raw.length - signalsMapped,
  };
}

/**
 * `risk:scores:sebuf:v8` -> the `MilitarySurgeCiiLookup` contract, also used as
 * per-focal-point CII context. `region` on a CII row is the ISO-2 country code.
 */
export function riskScoresToCiiLookup(payload: unknown): (countryCode: string) => number | null {
  const scores = new Map<string, number>();

  for (const raw of arrayField(payload, 'ciiScores')) {
    const record = asRecord(raw);
    if (!record) continue;
    const code = nonEmptyString(record.region).toUpperCase();
    const score = finiteNumber(record.combinedScore);
    if (code && score !== null) scores.set(code, score);
  }

  return (countryCode: string) => scores.get(String(countryCode ?? '').toUpperCase()) ?? null;
}

/**
 * Narrow focal points to one country: the country itself plus any entity the
 * registry relates to it (TSMC for TW, oil futures for SA), which is the same
 * relation the core walks when it attaches map signals to a company.
 *
 * The check runs in BOTH directions because `related` in the entity registry
 * is not symmetric — TW lists TSM, but TSM lists only its chip-sector peers.
 */
export function filterFocalPointsByCountry<T extends { entityId: string }>(
  points: T[],
  countryCode: string,
  index: EntityIndex,
): T[] {
  const code = nonEmptyString(countryCode).toUpperCase();
  if (!code) return points;

  const relatedToCountry = new Set(
    (index.byId.get(code)?.related ?? []).map((related) => related.toUpperCase()),
  );

  return points.filter((point) => {
    const entityId = point.entityId.toUpperCase();
    if (entityId === code) return true;
    if (relatedToCountry.has(entityId)) return true;
    const entity = index.byId.get(point.entityId);
    return Boolean(entity?.related?.some((related) => related.toUpperCase() === code));
  });
}

// ---------------------------------------------------------------------------
// simulate_infrastructure_cascade — cables + curated chokepoints
// ---------------------------------------------------------------------------

/**
 * `infrastructure:submarine-cables:v1` -> `CableInput`.
 *
 * The seeded shape already matches the core's structurally, so this is a
 * validating projection: it keeps only cables the graph can key on (id + name)
 * and normalises `countriesServed` rows, because a non-numeric capacity share
 * would propagate straight into the cascade's per-country impact arithmetic.
 */
export function submarineCablesToCableInputs(payload: unknown): CableInput[] {
  const cables: CableInput[] = [];

  for (const raw of arrayField(payload, 'cables')) {
    const record = asRecord(raw);
    if (!record) continue;
    const id = nonEmptyString(record.id);
    const name = nonEmptyString(record.name);
    if (!id || !name) continue;

    const countriesServed: NonNullable<CableInput['countriesServed']> = [];
    for (const entry of asArray(record.countriesServed)) {
      const served = asRecord(entry);
      const country = nonEmptyString(served?.country);
      if (!country) continue;
      countriesServed.push({
        country,
        capacityShare: finiteNumber(served?.capacityShare) ?? 0,
        isRedundant: served?.isRedundant === true,
      });
    }

    const landingPoints: NonNullable<CableInput['landingPoints']> = [];
    for (const entry of asArray(record.landingPoints)) {
      const point = asRecord(entry);
      const country = nonEmptyString(point?.country);
      if (!country) continue;
      landingPoints.push({
        country,
        countryName: nonEmptyString(point?.countryName) || undefined,
        city: nonEmptyString(point?.city) || undefined,
        lat: finiteNumber(point?.lat) ?? undefined,
        lon: finiteNumber(point?.lon) ?? undefined,
      });
    }

    const cable: CableInput = { id, name, countriesServed, landingPoints };
    const rfsYear = finiteNumber(record.rfsYear);
    if (rfsYear !== null) cable.rfsYear = rfsYear;
    const owners = asArray(record.owners).map((owner) => nonEmptyString(owner)).filter(Boolean);
    if (owners.length > 0) cable.owners = owners;

    cables.push(cable);
  }

  return cables;
}

/** Curated maritime chokepoints in the graph builder's `WaterwayInput` shape. */
export const MCP_CASCADE_WATERWAYS: WaterwayInput[] = STRATEGIC_WATERWAYS.map((waterway) => ({
  id: waterway.id,
  name: waterway.name,
  lat: waterway.lat,
  lon: waterway.lon,
  description: waterway.description,
}));

// ---------------------------------------------------------------------------
// get_military_surge — flights, vessel counts, activity history
// ---------------------------------------------------------------------------

/** `military:flights:v1` -> `MilitaryFlightInput`. */
export function militaryFlightsToSurgeInputs(payload: unknown): MilitaryFlightInput[] {
  const flights: MilitaryFlightInput[] = [];

  for (const raw of arrayField(payload, 'flights')) {
    const record = asRecord(raw);
    if (!record) continue;
    if (!hasRedistributableProviderAttribution(flightProviderAttribution(record))) continue;
    const lat = finiteNumber(record.lat);
    const lon = finiteNumber(record.lon);
    if (!usableCoord(lat, lon) || lon === null) continue;

    const flight: MilitaryFlightInput = {
      id: nonEmptyString(record.id) || nonEmptyString(record.hexCode) || `flight-${flights.length}`,
      callsign: nonEmptyString(record.callsign),
      // The core switches on aircraftType and treats an unknown value as
      // "other" — never as a fighter or a transport — so an untyped flight is
      // safe to keep for the theater totals.
      aircraftType: nonEmptyString(record.aircraftType) || 'unknown',
      operator: nonEmptyString(record.operator) || 'unknown',
      lat,
      lon,
    };
    const aircraftModel = nonEmptyString(record.aircraftModel);
    if (aircraftModel) flight.aircraftModel = aircraftModel;

    flights.push(flight);
  }

  return flights;
}

/**
 * `theater-posture:sebuf:v1` -> per-theater tracked-vessel counts.
 *
 * Two producers write this key: the flights seeder (which always publishes
 * `trackedVessels: 0`, it has no AIS) and the AIS relay (which publishes real
 * counts). Whichever wrote last wins, so a 0 here means "no vessels seen by
 * the last writer", not "no vessels".
 */
export function theaterPostureVesselCounts(payload: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (!hasRedistributableProviderAttribution(asRecord(payload)?.provider)) return counts;

  for (const raw of arrayField(payload, 'theaters')) {
    const record = asRecord(raw);
    if (!record) continue;
    const theaterId = nonEmptyString(record.theater) || nonEmptyString(record.theaterId);
    const vessels = finiteNumber(record.trackedVessels);
    if (!theaterId || vessels === null) continue;
    counts.set(theaterId, vessels);
  }

  return counts;
}

/** Write tracked-vessel counts onto posture summaries in place. */
export function applyVesselCountsToPostures(
  postures: TheaterPostureSummary[],
  counts: ReadonlyMap<string, number>,
): void {
  for (const posture of postures) {
    const vessels = counts.get(posture.theaterId);
    if (vessels === undefined) continue;
    // Only the total is recoverable: the posture cache carries no per-class
    // breakdown, and `recalcPostureWithVessels` scores on the total anyway.
    posture.totalVessels = vessels;
  }
}

/**
 * `military:surges:history:v1` -> the activity history the core's trend
 * calculation reads. Without it every theater reports `trend: 'stable'` and
 * `changePercent: 0` regardless of what is happening, because a per-request
 * engine starts with an empty history.
 */
export function surgeHistoryToActivityHistory(payload: unknown): Map<string, TheaterActivity[]> {
  const history = new Map<string, TheaterActivity[]>();

  const runs = arrayField(payload, 'history')
    .map((raw) => asRecord(raw))
    .filter((run): run is Record<string, unknown> => run !== null)
    .filter((run) => hasRedistributableProviderAttribution(run.sourceVersion))
    .map((run) => ({ run, timestamp: finiteNumber(run.assessedAt) }))
    .filter((entry): entry is { run: Record<string, unknown>; timestamp: number } => entry.timestamp !== null)
    // The core slices the tail (`-6`, `-12..-6`) to compare recent vs older,
    // so the series has to be oldest-first.
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const { run, timestamp } of runs) {
    for (const raw of asArray(run.theaters)) {
      const record = asRecord(raw);
      if (!record) continue;
      const theaterId = nonEmptyString(record.theaterId);
      if (!theaterId) continue;

      const entries = history.get(theaterId) ?? [];
      entries.push({
        theaterId,
        timestamp,
        transportCount: finiteNumber(record.transport) ?? 0,
        fighterCount: finiteNumber(record.fighters) ?? 0,
        reconCount: finiteNumber(record.reconnaissance) ?? 0,
        totalMilitary: finiteNumber(record.totalFlights) ?? 0,
        // The history rows keep counts, not ids. The core only reads flightIds
        // for live surge alerting, which the seeder already owns.
        flightIds: [],
      });
      history.set(theaterId, entries);
    }
  }

  return history;
}
