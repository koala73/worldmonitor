import { CII_RISK_SCORE_CACHE_KEYS } from '../../_cii-risk-cache-keys.js';
import { hasRedistributableProviderAttribution } from '../../../shared/provider-redistribution';
import { buildAlertDigest, buildWeeklyTrends } from '../../../shared/analysis-alert-digest';
import {
  anomaliesToDigestInput,
  buildDigestInputs,
  earthquakesToExposureEvents,
  type ExposureEvent,
  firesToExposureEvents,
  ucdpEventsToExposureEvents,
} from '../../../shared/analysis-composite-adapters';
import { getEntityIndex as getSharedEntityIndex } from '../../../shared/entity-extraction-core.js';
import { FocalPointCore, generateAgentSafeAIContext } from '../../../shared/analysis-focal-points';
import { getHotspotCountryScore } from '../../../shared/hotspot-country-map';
import {
  computeEscalationScore,
  countMilitaryNearHotspot,
} from '../../../shared/analysis-hotspot-escalation';
import { GeoConvergenceEngine, getLocationName } from '../../../shared/analysis-geo-convergence';
import {
  buildDependencyGraph,
  calculateCascade,
  getGraphStats,
} from '../../../shared/analysis-infrastructure-cascade';
import {
  applyVesselCountsToPostures,
  crossSourceSignalsToSignalSummary,
  earthquakesToGeoEvents,
  filterFocalPointsByCountry,
  insightsToFocalClusters,
  MCP_CASCADE_WATERWAYS,
  MCP_GEO_PLACES,
  militaryFlightsToGeoEvents,
  militaryFlightsToSurgeInputs,
  riskScoresToCiiLookup,
  submarineCablesToCableInputs,
  surgeHistoryToActivityHistory,
  theaterPostureVesselCounts,
  unrestEventsToGeoEvents,
  usniVesselsToGeoEvents,
} from '../../../shared/analysis-mcp-adapters';
import {
  getTheaterPostureSummaries,
  MilitarySurgeEngine,
  POSTURE_THEATERS,
  recalcPostureWithVessels,
} from '../../../shared/analysis-military-surge';
import {
  computeBoundedExposure,
  computeExposure,
  getRadiusForEventType,
  listCountryPopulations,
} from '../../../shared/analysis-population-exposure';
import { INTEL_HOTSPOTS } from '../../../shared/geo-data';
import { readJsonBatchFromUpstashWithStatus } from '../../_upstash-json.js';
import { evaluateFreshness } from '../freshness';
import { McpSourceUnavailableError } from '../source-unavailable';
import type { FreshnessCheck, ToolDef } from '../types';

type PayloadValidator = (value: unknown) => boolean;

function hasArrayField(value: unknown, field: string): boolean {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, field)
    && Array.isArray((value as Record<string, unknown>)[field]);
}

function hasObjectField(value: unknown, field: string): boolean {
  const fieldValue = value
    && typeof value === 'object'
    && !Array.isArray(value)
    ? (value as Record<string, unknown>)[field]
    : null;
  return !!fieldValue && typeof fieldValue === 'object' && !Array.isArray(fieldValue);
}

const ANALYSIS_PAYLOAD_VALIDATORS: Readonly<Record<string, PayloadValidator>> = {
  'unrest:events:v1': (value) => hasArrayField(value, 'events'),
  'military:flights:v1': (value) => hasArrayField(value, 'flights'),
  'seismology:earthquakes:v1': (value) => hasArrayField(value, 'earthquakes'),
  'usni-fleet:sebuf:v1': (value) => hasArrayField(value, 'vessels'),
  'news:insights:v1': (value) => hasArrayField(value, 'topStories'),
  'intelligence:cross-source-signals:v1': (value) => hasArrayField(value, 'signals'),
  [CII_RISK_SCORE_CACHE_KEYS.live]: (value) => hasArrayField(value, 'ciiScores'),
  'infrastructure:submarine-cables:v1': (value) => hasArrayField(value, 'cables'),
  'theater-posture:sebuf:v1': (value) => hasArrayField(value, 'theaters'),
  'military:surges:v1': (value) => Array.isArray(value) || hasArrayField(value, 'surges'),
  'military:surges:history:v1': (value) => hasArrayField(value, 'history'),
  'wildfire:fires:v1': (value) => hasArrayField(value, 'fireDetections'),
  'conflict:ucdp-events:v1': (value) => hasArrayField(value, 'events'),
  'cable-health-v1': (value) => hasObjectField(value, 'cables'),
  'infra:outages:v1': (value) => hasArrayField(value, 'outages'),
  'temporal:anomalies:v1': (value) => hasArrayField(value, 'anomalies'),
  'thermal:escalation:v1': (value) => hasArrayField(value, 'clusters'),
  'supply_chain:shipping_stress:v1': (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(record, 'stressScore')
      && Object.prototype.hasOwnProperty.call(record, 'stressLevel');
  },
};

/**
 * Read data caches and freshness metadata in one parallel round while keeping
 * payload and metadata positions structurally separate.
 */
async function readCachesWithFreshness(
  keys: readonly string[],
  checks: FreshnessCheck[],
): Promise<{
  payloads: unknown[];
  freshness: {
    cached_at: string | null;
    stale: boolean;
    unavailable_inputs: string[];
    failed_inputs: string[];
  };
}> {
  const results = await readJsonBatchFromUpstashWithStatus([
    ...keys,
    ...checks.map((check) => check.key),
  ]);
  const payloadReads = results.slice(0, keys.length).map((result, index) => {
    const validator = ANALYSIS_PAYLOAD_VALIDATORS[keys[index] ?? ''];
    if (result.status === 'hit' && validator && !validator(result.value)) {
      return { status: 'error' as const, value: null };
    }
    return result;
  });
  const metaReads = results.slice(keys.length);
  const payloads = payloadReads.map((result) => result.value);
  const unavailablePayloads = keys.filter(
    (_key, index) => payloadReads[index]?.status !== 'hit' || payloadReads[index]?.value === null,
  );
  const unavailableMetadata = checks
    .filter((_check, index) => metaReads[index]?.status !== 'hit' || metaReads[index]?.value === null)
    .map((check) => check.key);
  const failedPayloads = keys.filter((_key, index) => payloadReads[index]?.status === 'error');
  const failedMetadata = checks
    .filter((_check, index) => metaReads[index]?.status === 'error')
    .map((check) => check.key);
  const unavailableInputs = [...unavailablePayloads, ...unavailableMetadata];
  const failedInputs = [...failedPayloads, ...failedMetadata];
  const evaluated = evaluateFreshness(checks, metaReads.map((result) => result.value));
  return {
    payloads,
    freshness: {
      ...evaluated,
      stale: evaluated.stale || unavailableInputs.length > 0,
      unavailable_inputs: unavailableInputs,
      failed_inputs: failedInputs,
    },
  };
}

const ANALYSIS_CACHE_STATUS_PROPERTIES = {
  unavailable_inputs: {
    type: 'array',
    items: { type: 'string' },
    description: 'Required cache keys that were missing or unreadable; their contribution is not treated as quiet.',
  },
  failed_inputs: {
    type: 'array',
    items: { type: 'string' },
    description: 'Subset of unavailable_inputs whose Redis read failed rather than returning a genuine miss.',
  },
} as const;

type AnalysisFreshness = Awaited<ReturnType<typeof readCachesWithFreshness>>['freshness'];

function requireAnyInput(
  payloads: unknown[],
  freshness: AnalysisFreshness,
  message: string,
): void {
  if (payloads.every((value) => value === null)) {
    throw new McpSourceUnavailableError(
      message,
      freshness.unavailable_inputs,
      freshness.failed_inputs,
    );
  }
}

function resolveLimit(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return Number.POSITIVE_INFINITY;
  return parsed;
}

// Keep the analysis schemas aligned with cacheEnvelope(). Content age is not a
// universal rule: evaluateFreshness() applies it only to checks that explicitly
// declare honorContentAge.
const ANALYSIS_STALE_DESCRIPTION = 'True when any contributing cache key fails its freshness contract: fetched longer ago than its per-key maxStaleMin budget, below a declared minRecordCount, or — for keys that declare a content-age contract — carrying upstream observations older than maxContentAgeMin even though the fetch itself is recent. A recent cached_at with stale:true means the fetch is current but the underlying data has stopped advancing, so refetching will not help.';

export const ANALYSIS_TOOLS: ToolDef[] = [
  {
    name: 'get_signal_convergence',
    _outputBudgetBytes: 65536,
    description:
      'Geographic signal convergence: grid cells where protests, military activity, naval movements, and earthquakes co-occur. ' +
      'The same multi-domain convergence engine the dashboard map runs, executed server-side over the seeded feeds: unrest events, ' +
      'tracked military flights, USNI fleet positions (region centroids), and USGS earthquakes are bucketed into one-degree cells ' +
      'over a 24-hour window, and any cell where enough distinct domains overlap becomes an alert scored by breadth and volume. ' +
      'Each alert carries coordinates, the contributing domains, a reverse-geocoded location name from the curated hotspot/' +
      'chokepoint/conflict-zone gazetteer, and the total event count. Pass lat/lon/radius_km together to narrow to one area, or ' +
      'min_domains to tighten the co-occurrence bar. An empty alert list with fresh inputs means nothing is converging — signal in itself.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude of the area of interest; requires lon and radius_km as well.' },
        lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude of the area of interest; requires lat and radius_km as well.' },
        radius_km: { type: 'number', exclusiveMinimum: 0, maximum: 20000, description: 'Positive radius in km around lat/lon to keep alerts for; requires lat and lon (maximum 20,000).' },
        min_domains: {
          type: 'number',
          minimum: 2,
          maximum: 5,
          description:
            'Distinct signal domains required per cell, 2-5 (default 3); 5 is a compatibility safety threshold that yields no alerts while four domains are ingested.',
        },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: ANALYSIS_STALE_DESCRIPTION },
        ...ANALYSIS_CACHE_STATUS_PROPERTIES,
        data: {
          type: 'object',
          properties: {
            alerts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  cellId: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' },
                  location: { type: 'string' },
                  types: { type: 'array', items: { type: 'string' } },
                  totalEvents: { type: 'number' }, score: { type: 'number' },
                },
              },
            },
            cell_count: { type: 'number' },
            min_domains: { type: 'number' },
            feeds: { type: 'object', description: 'Per-feed ingested event counts (0 = feed empty or unavailable).' },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const lat = typeof params.lat === 'number' ? params.lat : null;
      const lon = typeof params.lon === 'number' ? params.lon : null;
      const radiusKm = typeof params.radius_km === 'number' ? params.radius_km : null;
      const provided = [lat, lon, radiusKm].filter((v) => v !== null).length;
      if (provided > 0 && provided < 3) {
        // Envelope always present: the declared outputSchema marks cached_at/
        // stale/data required, so a bare {error} would violate the published
        // contract a strict MCP client validates against.
        return {
          cached_at: null,
          stale: false,
          data: { alerts: [], cell_count: 0, min_domains: 0, feeds: {} },
          error: 'lat, lon, and radius_km must be provided together (all three or none).',
        };
      }
      if (
        provided === 3
        && (
          !Number.isFinite(lat)
          || !Number.isFinite(lon)
          || !Number.isFinite(radiusKm)
          || lat! < -90
          || lat! > 90
          || lon! < -180
          || lon! > 180
          || radiusKm! <= 0
          || radiusKm! > 20_000
        )
      ) {
        return {
          cached_at: null,
          stale: false,
          data: { alerts: [], cell_count: 0, min_domains: 0, feeds: {} },
          error: 'lat must be within [-90, 90], lon within [-180, 180], and radius_km within (0, 20000].',
        };
      }
      const minDomains = Math.min(5, Math.max(2, Math.round(Number(params.min_domains ?? 3)) || 3));

      const keys = ['unrest:events:v1', 'military:flights:v1', 'seismology:earthquakes:v1', 'usni-fleet:sebuf:v1'];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:unrest:events', maxStaleMin: 120 },
        { key: 'seed-meta:military:flights', maxStaleMin: 30 },
        { key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 },
        { key: 'seed-meta:military:usni-fleet', maxStaleMin: 720 },
      ];
      const { payloads: [unrest, flights, quakes, fleet], freshness } = await readCachesWithFreshness(keys, checks);
      requireAnyInput(
        [unrest, flights, quakes, fleet],
        freshness,
        'No convergence input feeds are available',
      );

      const now = Date.now();
      const engine = new GeoConvergenceEngine({ convergenceThreshold: minDomains, now: () => now });
      const feeds = {
        protests: unrestEventsToGeoEvents(unrest, { now }),
        military_flights: militaryFlightsToGeoEvents(flights, { now }),
        earthquakes: earthquakesToGeoEvents(quakes, { now }),
        naval_vessels: usniVesselsToGeoEvents(fleet, { now }),
      };
      engine.ingestEvents(feeds.protests, 'protest');
      engine.ingestEvents(feeds.military_flights, 'military_flight');
      engine.ingestEvents(feeds.earthquakes, 'earthquake');
      engine.ingestEvents(feeds.naval_vessels, 'military_vessel');

      let alerts = engine.detect(new Set());
      if (lat !== null && lon !== null && radiusKm !== null) {
        const toRad = (d: number) => (d * Math.PI) / 180;
        alerts = alerts.filter((alert) => {
          const dLat = toRad(alert.lat - lat);
          const dLon = toRad(alert.lon - lon);
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(alert.lat)) * Math.sin(dLon / 2) ** 2;
          return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= radiusKm;
        });
      }
      return {
        ...freshness,
        data: {
          alerts: alerts.map((alert) => ({
            ...alert,
            location: getLocationName(alert.lat, alert.lon, MCP_GEO_PLACES),
          })),
          cell_count: engine.cellCount(),
          min_domains: minDomains,
          feeds: Object.fromEntries(Object.entries(feeds).map(([name, events]) => [name, events.length])),
        },
      };
    },
    _coverageKeys: ['unrest:events:v1', 'military:flights:v1', 'seismology:earthquakes:v1', 'usni-fleet:sebuf:v1'],
    _apiPaths: [],
  },
  {
    name: 'get_focal_points',
    _outputBudgetBytes: 65536,
    description:
      'Focal-point detection: entities where news coverage and live map signals converge, ranked by multi-signal score. ' +
      'Runs the dashboard focal-point engine server-side: seeded news story clusters are entity-matched against the curated ' +
      'registry of countries, companies, and organizations, then cross-referenced with cross-source escalation signals mapped ' +
      'to countries through the same entity index. Each focal point reports its urgency band, news and signal scores, a ' +
      'correlation bonus when headlines and map signals name the same entity, supporting headlines, and a generated narrative. ' +
      'The response also carries an application-authored ai_context block suitable for grounding follow-up analysis; source ' +
      'headlines remain separate in the focal-point evidence, plus mapping-coverage counters ' +
      'so a thin result is distinguishable from an outage. Filter to one country with country_code; cap the list with limit.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'Filter focal points to one country (ISO-2) and entities the registry relates to it.' },
        limit: { type: 'number', description: 'Cap the focal point list (default 10, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: ANALYSIS_STALE_DESCRIPTION },
        ...ANALYSIS_CACHE_STATUS_PROPERTIES,
        data: {
          type: 'object',
          properties: {
            focal_points: { type: 'array', items: { type: 'object' } },
            ai_context: { type: 'string' },
            coverage: {
              type: 'object',
              properties: {
                clusters: { type: 'number' },
                signals_total: { type: 'number' },
                signals_mapped: { type: 'number' },
                signals_unmapped: { type: 'number' },
              },
            },
          },
          required: [],
        },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const limit = resolveLimit(params.limit, 10);
      const keys = ['news:insights:v1', 'intelligence:cross-source-signals:v1', CII_RISK_SCORE_CACHE_KEYS.live];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:news:insights', maxStaleMin: 30 },
        { key: 'seed-meta:intelligence:cross-source-signals', maxStaleMin: 30 },
        { key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30, minRecordCount: 3 },
      ];
      const { payloads: [insights, crossSource, riskScores], freshness } = await readCachesWithFreshness(keys, checks);
      requireAnyInput(
        [insights, crossSource, riskScores],
        freshness,
        'No focal-point input feeds are available',
      );

      const index = getSharedEntityIndex();
      const clusters = insightsToFocalClusters(insights);
      const mapping = crossSourceSignalsToSignalSummary(crossSource, index);
      const summary = new FocalPointCore(index).analyze(clusters, mapping.summary);
      const ciiLookup = riskScoresToCiiLookup(riskScores);

      let points = summary.focalPoints;
      const countryCode = typeof params.country_code === 'string' ? params.country_code : '';
      if (countryCode) points = filterFocalPointsByCountry(points, countryCode, index);
      const selectedPoints = points.slice(0, limit);
      return {
        ...freshness,
        data: {
          focal_points: selectedPoints.map((point) => ({
            ...point,
            ciiScore: point.entityType === 'country' ? ciiLookup(point.entityId) : null,
          })),
          ai_context: generateAgentSafeAIContext(selectedPoints),
          coverage: {
            clusters: clusters.length,
            signals_total: mapping.signalsTotal,
            signals_mapped: mapping.signalsMapped,
            signals_unmapped: mapping.signalsUnmapped,
          },
        },
      };
    },
    _coverageKeys: ['news:insights:v1', 'intelligence:cross-source-signals:v1', CII_RISK_SCORE_CACHE_KEYS.live],
    _apiPaths: [],
  },
  {
    name: 'simulate_infrastructure_cascade',
    _outputBudgetBytes: 131072,
    description:
      'Infrastructure cascade simulation: what fails downstream when a cable, chokepoint, pipeline, or port is disrupted. ' +
      'Builds the dashboard dependency graph server-side from the seeded TeleGeography submarine-cable table plus the curated ' +
      'pipeline, port, and maritime-chokepoint registries, then runs breadth-first failure propagation from the chosen source ' +
      'node. Results include every affected node with its degraded capacity share, per-country impact categories, redundancy ' +
      'candidates, and graph statistics. Call with no source_id to receive the catalog of simulatable node ids grouped by ' +
      'type; disruption_level scales the initial failure from partial (0.1) to total (1, the default). Chained capacity math ' +
      'multiplies along paths, so distant impacts shrink realistically instead of cascading at full strength.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'Node id to disrupt (see the no-argument catalog for valid ids).' },
        disruption_level: { type: 'number', description: 'Initial failure severity between 0.1 and 1 (default 1).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Fetch time of the seeded cable table.' },
        stale: { type: 'boolean', description: ANALYSIS_STALE_DESCRIPTION },
        ...ANALYSIS_CACHE_STATUS_PROPERTIES,
        data: {
          type: 'object',
          properties: {
            catalog: { type: ['object', 'null'], description: 'Node ids by type; present only when source_id is omitted.' },
            cascade: { type: ['object', 'null'], description: 'Cascade result; present only when source_id is given.' },
            stats: { type: 'object' },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
        known_id_sample: { type: 'array', items: { type: 'string' }, description: 'Sample of valid node ids; present only alongside an unknown-source_id error.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:infrastructure:submarine-cables', maxStaleMin: 25200 },
      ];
      const { payloads: [cablesPayload], freshness } = await readCachesWithFreshness(
        ['infrastructure:submarine-cables:v1'],
        checks,
      );
      const cables = submarineCablesToCableInputs(cablesPayload);
      const graph = buildDependencyGraph({ cables, waterways: MCP_CASCADE_WATERWAYS });
      const stats = getGraphStats(graph);

      const sourceId = typeof params.source_id === 'string' ? params.source_id.trim() : '';
      if (!sourceId) {
        const catalog: Record<string, Array<{ id: string; name: string }>> = {};
        for (const node of graph.nodes.values()) {
          if (node.type === 'country') continue;
          (catalog[node.type] ??= []).push({ id: node.id, name: node.name });
        }
        return { ...freshness, data: { catalog, cascade: null, stats } };
      }

      if (!graph.nodes.has(sourceId)) {
        if (cablesPayload === null && sourceId.startsWith('cable:')) {
          throw new McpSourceUnavailableError(
            'The submarine-cable catalog is unavailable',
            freshness.unavailable_inputs,
            freshness.failed_inputs,
          );
        }
        const sample = [...graph.nodes.keys()].filter((id) => !id.startsWith('country-')).slice(0, 12);
        return {
          ...freshness,
          data: { catalog: null, cascade: null, stats },
          error: `unknown source_id "${sourceId}" — call without source_id for the full catalog`,
          known_id_sample: sample,
        };
      }

      const rawLevel = Number(params.disruption_level ?? 1);
      const disruptionLevel = Math.min(1, Math.max(0.1, Number.isFinite(rawLevel) ? rawLevel : 1));
      const cascade = calculateCascade(graph, sourceId, disruptionLevel);
      return { ...freshness, data: { catalog: null, cascade, stats } };
    },
    _coverageKeys: ['infrastructure:submarine-cables:v1'],
    _apiPaths: [],
  },
  {
    name: 'get_military_surge',
    _outputBudgetBytes: 65536,
    description:
      'Military surge watch: theater aircraft postures, foreign-presence detections, and seeder-computed surge alerts. ' +
      'Runs the dashboard military-surge engine server-side over the seeded flight snapshot: per-theater posture summaries ' +
      'count fighters, tankers, AWACS, reconnaissance, transports, bombers, and drones inside each theater boundary, with ' +
      'trend context recovered from the persisted surge history and tracked-vessel counts merged from the theater-posture ' +
      'cache. Foreign-presence detection flags operators flying far from their home region above per-operator thresholds. ' +
      'The seeded_surges block carries the surge alerts the flights seeder computed against its own persisted baselines — ' +
      'reported separately because that variant uses different thresholds than the snapshot engine. Filter with theater.',
    inputSchema: {
      type: 'object',
      properties: {
        theater: { type: 'string', description: 'Filter to one theater by id or name substring (case-insensitive).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: ANALYSIS_STALE_DESCRIPTION },
        ...ANALYSIS_CACHE_STATUS_PROPERTIES,
        data: {
          type: 'object',
          properties: {
            postures: { type: 'array', items: { type: 'object' } },
            foreign_presence: { type: 'array', items: { type: 'object' } },
            seeded_surges: { type: 'array', items: { type: 'object' } },
            seeded_surges_available: { type: 'boolean' },
            history_available: { type: 'boolean' },
            cii_available: { type: 'boolean' },
            flight_count: { type: 'number' },
          },
          required: [],
        },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const keys = [
        'military:flights:v1',
        'theater-posture:sebuf:v1',
        'military:surges:v1',
        'military:surges:history:v1',
        CII_RISK_SCORE_CACHE_KEYS.live,
      ];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:military:flights', maxStaleMin: 30 },
        { key: 'seed-meta:theater-posture', maxStaleMin: 60 },
        { key: 'seed-meta:military-surges', maxStaleMin: 30 },
        { key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30, minRecordCount: 3 },
      ];
      const {
        payloads: [flightsPayload, posturePayload, surgesPayload, historyPayload, riskScores],
        freshness,
      } = await readCachesWithFreshness(keys, checks);
      requireAnyInput(
        [flightsPayload, posturePayload, surgesPayload],
        freshness,
        'No primary military feeds are available',
      );

      const flights = militaryFlightsToSurgeInputs(flightsPayload);
      const history = surgeHistoryToActivityHistory(historyPayload);
      const postures = flightsPayload !== null || posturePayload !== null
        ? getTheaterPostureSummaries(flights, history)
        : [];
      if (postures.length > 0) {
        applyVesselCountsToPostures(postures, theaterPostureVesselCounts(posturePayload));
        recalcPostureWithVessels(postures, riskScoresToCiiLookup(riskScores));
      }

      const engine = new MilitarySurgeEngine();
      const foreignPresence = engine.detectForeignMilitaryPresence(flights).map((alert) => ({
        id: alert.id,
        operator: alert.operator,
        operatorCountry: alert.operatorCountry,
        region: alert.region.name,
        region_id: alert.region.id,
        aircraftCount: alert.aircraftCount,
      }));

      const redistributableSurgesPayload = hasRedistributableProviderAttribution(
        (surgesPayload as { sourceVersion?: unknown } | null)?.sourceVersion,
      ) ? surgesPayload : null;
      const seededSurges = Array.isArray((redistributableSurgesPayload as { surges?: unknown[] } | null)?.surges)
        ? ((redistributableSurgesPayload as { surges: unknown[] }).surges as Array<Record<string, unknown>>)
        : [];

      const theaterFilter = typeof params.theater === 'string' ? params.theater.trim().toLowerCase() : '';
      const matchesTheater = (id: unknown, name?: unknown, shortName?: unknown) =>
        !theaterFilter ||
        [id, name, shortName].some(
          (value) => typeof value === 'string' && value.toLowerCase().includes(theaterFilter),
        );
      const matchedRegionIds = new Set(
        POSTURE_THEATERS
          .filter((theater) => matchesTheater(theater.id, theater.name, theater.shortName))
          .flatMap((theater) => theater.regions),
      );
      return {
        ...freshness,
        data: {
          postures: postures.filter((p) => matchesTheater(p.theaterId, p.theaterName, p.shortName)),
          foreign_presence: theaterFilter
            ? foreignPresence.filter((alert) =>
              matchedRegionIds.has(alert.region_id) ||
              alert.region_id.toLowerCase().includes(theaterFilter) ||
              alert.region.toLowerCase().includes(theaterFilter))
            : foreignPresence,
          seeded_surges: seededSurges.filter((surge) => matchesTheater(surge.theaterId, surge.theater)),
          seeded_surges_available: redistributableSurgesPayload !== null,
          history_available: historyPayload !== null,
          cii_available: riskScores !== null,
          flight_count: flights.length,
        },
      };
    },
    _coverageKeys: [
      'military:flights:v1',
      'theater-posture:sebuf:v1',
      'military:surges:v1',
      'military:surges:history:v1',
      CII_RISK_SCORE_CACHE_KEYS.live,
    ],
    _apiPaths: [],
  },
  {
    name: 'get_population_exposure',
    _outputBudgetBytes: 65536,
    description:
      'Population exposure: estimated people within the impact radius of active earthquakes, wildfires, and conflict events. ' +
      'Uses the same country-density approximation the dashboard ships — the nearest priority-country centroid supplies a ' +
      'population density that is multiplied over the event-type radius disc (50 km for conflict, 100 km for earthquakes and ' +
      'floods, 30 km for fires). Three modes: events (the default) enriches the current seeded event feeds and ranks them by ' +
      'exposed population; point estimates exposure around an arbitrary lat/lon; countries returns the priority-country ' +
      'population table itself. Estimates are deliberately coarse screening numbers — there is no city-level population ' +
      'dataset behind them — so treat them as ranking signals, not casualty projections.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['events', 'point', 'countries'], description: 'events enriches live feeds (default); point takes lat/lon; countries lists the population table.' },
        event_source: { type: 'string', enum: ['earthquakes', 'wildfires', 'conflicts', 'all'], description: 'Which event feeds to enrich in events mode (default all).' },
        lat: { type: 'number', description: 'Latitude for point mode.' },
        lon: { type: 'number', description: 'Longitude for point mode.' },
        radius_km: { type: 'number', description: 'Radius in km for point mode (default 50, clamped to 1000).' },
        limit: { type: 'number', description: 'Cap the enriched event list in events mode (default 20, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the feeds read; null in point and countries modes.' },
        stale: { type: 'boolean', description: ANALYSIS_STALE_DESCRIPTION },
        ...ANALYSIS_CACHE_STATUS_PROPERTIES,
        data: {
          type: 'object',
          properties: {
            events: { type: ['array', 'null'], items: { type: 'object' } },
            exposure: { type: ['object', 'null'] },
            countries: { type: ['array', 'null'], items: { type: 'object' } },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const mode = typeof params.mode === 'string' ? params.mode : 'events';

      if (mode === 'countries') {
        return { cached_at: null, stale: false, data: { events: null, exposure: null, countries: listCountryPopulations() } };
      }

      if (mode === 'point') {
        const lat = typeof params.lat === 'number' ? params.lat : null;
        const lon = typeof params.lon === 'number' ? params.lon : null;
        if (lat === null || lon === null) {
          return {
            cached_at: null,
            stale: false,
            data: { events: null, exposure: null, countries: null },
            error: 'point mode requires numeric lat and lon.',
          };
        }
        // Out-of-range coordinates would still resolve to a nearest centroid
        // by Euclidean distance and return a real-looking estimate for a place
        // that does not exist (lat 999 attributes to Mali).
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          return {
            cached_at: null,
            stale: false,
            data: { events: null, exposure: null, countries: null },
            error: `lat must be within [-90, 90] and lon within [-180, 180] (received lat=${lat}, lon=${lon}).`,
          };
        }
        const radiusKm = Math.max(1, Number(params.radius_km ?? 50) || 50);
        return {
          cached_at: null,
          stale: false,
          data: { events: null, exposure: computeBoundedExposure(lat, lon, radiusKm), countries: null },
        };
      }

      const source = typeof params.event_source === 'string' ? params.event_source : 'all';
      const limit = resolveLimit(params.limit, 20);
      const wants = (name: string) => source === 'all' || source === name;
      const reads: Array<{
        key: string;
        check: FreshnessCheck;
        adapt: (payload: unknown, limit: number) => ExposureEvent[];
      }> = [];
      if (wants('earthquakes')) {
        reads.push({
          key: 'seismology:earthquakes:v1',
          check: { key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 },
          adapt: (payload, cap) => earthquakesToExposureEvents(payload, cap),
        });
      }
      if (wants('wildfires')) {
        reads.push({
          key: 'wildfire:fires:v1',
          check: { key: 'seed-meta:wildfire:fires', maxStaleMin: 360 },
          adapt: (payload, cap) => firesToExposureEvents(payload, cap),
        });
      }
      if (wants('conflicts')) {
        reads.push({
          key: 'conflict:ucdp-events:v1',
          check: { key: 'seed-meta:conflict:ucdp-events', maxStaleMin: 420 },
          adapt: (payload, cap) => ucdpEventsToExposureEvents(payload, cap),
        });
      }

      const { payloads, freshness } = await readCachesWithFreshness(
        reads.map((read) => read.key),
        reads.map((read) => read.check),
      );
      requireAnyInput(
        payloads,
        freshness,
        'No event feeds are available for exposure enrichment',
      );

      const enriched = reads
        .flatMap((read, i) => read.adapt(payloads[i], Number.POSITIVE_INFINITY))
        .map((event) => {
          const radius = getRadiusForEventType(event.type);
          const exposure = computeExposure(event.lat, event.lon, radius);
          return { ...event, ...exposure };
        })
        .sort((a, b) => b.exposedPopulation - a.exposedPopulation)
        .slice(0, limit);

      return { ...freshness, data: { events: enriched, exposure: null, countries: null } };
    },
    _coverageKeys: ['seismology:earthquakes:v1', 'wildfire:fires:v1', 'conflict:ucdp-events:v1'],
    _apiPaths: ['GET /api/displacement/v1/get-population-exposure'],
  },
  {
    name: 'get_alert_digest',
    _outputBudgetBytes: 131072,
    description:
      'Cross-domain alert digest: everything that tripped a threshold today, in one rollup. ' +
      'Sweeps seven seeded domains — country instability bands, military surge alerts, submarine-cable health, ongoing ' +
      'internet outages, temporal anomalies, thermal escalation zones, and shipping stress — and reports each trip with the ' +
      'severity vocabulary its own producer already uses; no thresholds are invented by this tool. Domains with data but no ' +
      'trips are listed as quiet, and domains whose caches are unavailable are listed separately so silence is never mistaken ' +
      'for calm. The weekly view adds direction, volatility, and anomaly flags derived from the persisted military-activity ' +
      'history plus the current temporal-anomaly snapshot. This is the fastest single call for what changed today.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['today', 'weekly'], description: 'today lists current threshold trips (default); weekly adds trend context.' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: ANALYSIS_STALE_DESCRIPTION },
        ...ANALYSIS_CACHE_STATUS_PROPERTIES,
        data: {
          type: 'object',
          properties: {
            tripped: { type: 'array', items: { type: 'object' } },
            quiet: { type: 'array', items: { type: 'string' } },
            unavailable: { type: 'array', items: { type: 'string' } },
            weekly: {
              type: ['object', 'null'],
              properties: {
                trends: { type: 'array', items: { type: 'object' } },
                current_anomalies: { type: 'array', items: { type: 'object' } },
                history_available: { type: 'boolean' },
                note: { type: 'string' },
              },
            },
          },
          required: [],
        },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const view = typeof params.view === 'string' ? params.view : 'today';
      const keys: string[] = [
        CII_RISK_SCORE_CACHE_KEYS.live,
        'military:surges:v1',
        'cable-health-v1',
        'infra:outages:v1',
        'temporal:anomalies:v1',
        'thermal:escalation:v1',
        'supply_chain:shipping_stress:v1',
      ];
      if (view === 'weekly') keys.push('military:surges:history:v1');
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30, minRecordCount: 3 },
        { key: 'seed-meta:military-surges', maxStaleMin: 30 },
        { key: 'seed-meta:cable-health', maxStaleMin: 90 },
        { key: 'seed-meta:infra:outages', maxStaleMin: 30 },
        // liveness 45min; content-age (newestItemAt vs maxContentAgeMin) is stamped
        // on the same key and evaluated by evaluateFreshness via honorContentAge.
        { key: 'seed-meta:temporal:anomalies', maxStaleMin: 45, honorContentAge: true },
        { key: 'seed-meta:thermal:escalation', maxStaleMin: 360 },
        { key: 'seed-meta:supply_chain:shipping_stress', maxStaleMin: 45 },
      ];
      const {
        payloads: [riskScores, surges, cableHealth, outages, temporal, thermal, stress, historyPayload],
        freshness,
      } = await readCachesWithFreshness(keys, checks);
      requireAnyInput(
        [riskScores, surges, cableHealth, outages, temporal, thermal, stress],
        freshness,
        'No digest input feeds are available',
      );

      const now = Date.now();
      const digest = buildAlertDigest(
        buildDigestInputs({ riskScores, surges, cableHealth, outages, temporal, thermal, stress }),
        now,
      );

      let weekly: Record<string, unknown> | null = null;
      const unavailable = [...digest.unavailable];
      if (view === 'weekly') {
        const historyAvailable = historyPayload !== null;
        if (!historyAvailable) unavailable.push('military_history');
        const activity = surgeHistoryToActivityHistory(historyPayload);
        const series = [...activity.entries()].map(([theaterId, points]) => ({
          domain: `military:${theaterId}`,
          points: points.map((point) => ({ t: point.timestamp, value: point.totalMilitary })),
        }));
        weekly = {
          trends: buildWeeklyTrends(series, now),
          current_anomalies: anomaliesToDigestInput(temporal),
          history_available: historyAvailable,
          note: 'weekly trends derive from the persisted military-activity history; other domains publish no whole-feed history caches yet',
        };
      }
      return {
        ...freshness,
        data: { tripped: digest.tripped, quiet: digest.quiet, unavailable, weekly },
      };
    },
    _coverageKeys: [
      CII_RISK_SCORE_CACHE_KEYS.live,
      'military:surges:v1',
      'cable-health-v1',
      'infra:outages:v1',
      'temporal:anomalies:v1',
      'thermal:escalation:v1',
      'supply_chain:shipping_stress:v1',
    ],
    _apiPaths: [],
  },
  {
    name: 'get_hotspot_escalation',
    _outputBudgetBytes: 65536,
    description:
      'Hotspot escalation scores: the 29 curated intelligence hotspots ranked by dynamic escalation on a 1-5 scale. ' +
      'Runs a reduced server snapshot of the dashboard escalation engine: for each curated hotspot, news pressure (keyword matches over the ' +
      'seeded story clusters), country instability, geographic signal convergence (protests, military flights, earthquakes ' +
      'gridded around the hotspot), and nearby military activity are normalized to 0-100 components, weighted 35/25/25/15, ' +
      'and blended 30/70 with the curated static baseline into a 1-5 composite. Server runs do not have the browser session ' +
      'inputs for breaking-news flags, news velocity, score history, or vessel positions; input_availability names those ' +
      'omissions explicitly, while unavailable_inputs reports missing server-side feeds.',
    inputSchema: {
      type: 'object',
      properties: {
        hotspot_id: { type: 'string', description: 'Return only this curated hotspot id (see any full response for the id list).' },
        limit: { type: 'number', description: 'Cap the ranked hotspot list (default 29, the full curated set; pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: ANALYSIS_STALE_DESCRIPTION },
        ...ANALYSIS_CACHE_STATUS_PROPERTIES,
        data: {
          type: 'object',
          properties: {
            hotspots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  hotspotId: { type: 'string' }, name: { type: 'string' },
                  lat: { type: 'number' }, lon: { type: 'number' },
                  staticBaseline: { type: 'number' }, dynamicScore: { type: 'number' },
                  combinedScore: { type: 'number', description: 'Composite escalation on the documented 1-5 scale.' },
                  components: { type: 'object' }, trend: { type: 'string' },
                },
              },
            },
            input_availability: {
              type: 'object',
              properties: {
                news_pressure: { type: 'boolean' },
                country_instability: { type: 'boolean' },
                geo_convergence: { type: 'boolean' },
                military_flights: { type: 'boolean' },
                breaking_news: { type: 'boolean' },
                news_velocity: { type: 'boolean' },
                military_vessels: { type: 'boolean' },
                score_history: { type: 'boolean' },
              },
            },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
        known_ids: { type: 'array', items: { type: 'string' }, description: 'All curated hotspot ids; present only alongside an unknown-hotspot_id error.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      // Validated against the static curated list BEFORE any cache read: an
      // unknown id is knowable without spending five Redis round-trips.
      const hotspotIdFilter = typeof params.hotspot_id === 'string' ? params.hotspot_id.trim() : '';
      const targets = hotspotIdFilter
        ? INTEL_HOTSPOTS.filter((hotspot) => hotspot.id === hotspotIdFilter)
        : INTEL_HOTSPOTS;
      if (hotspotIdFilter && targets.length === 0) {
        return {
          cached_at: null,
          stale: false,
          data: { hotspots: [] },
          error: `unknown hotspot_id "${hotspotIdFilter}"`,
          known_ids: INTEL_HOTSPOTS.map((hotspot) => hotspot.id),
        };
      }

      const keys = ['news:insights:v1', CII_RISK_SCORE_CACHE_KEYS.live, 'military:flights:v1', 'unrest:events:v1', 'seismology:earthquakes:v1'];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:news:insights', maxStaleMin: 30 },
        { key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30, minRecordCount: 3 },
        { key: 'seed-meta:military:flights', maxStaleMin: 30 },
        { key: 'seed-meta:unrest:events', maxStaleMin: 120 },
        { key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 },
      ];
      const { payloads: [insights, riskScores, flightsPayload, unrest, quakes], freshness } = await readCachesWithFreshness(keys, checks);
      requireAnyInput(
        [insights, riskScores, flightsPayload, unrest, quakes],
        freshness,
        'No hotspot-escalation input feeds are available',
      );

      const now = Date.now();
      const clusters = insightsToFocalClusters(insights);
      const ciiLookup = riskScoresToCiiLookup(riskScores);
      const flights = militaryFlightsToSurgeInputs(flightsPayload);

      const geoEngine = new GeoConvergenceEngine({ now: () => now });
      geoEngine.ingestEvents(unrestEventsToGeoEvents(unrest, { now }), 'protest');
      geoEngine.ingestEvents(militaryFlightsToGeoEvents(flightsPayload, { now }), 'military_flight');
      geoEngine.ingestEvents(earthquakesToGeoEvents(quakes, { now }), 'earthquake');

      const scored = targets.map((hotspot) => {
        const keywords = (hotspot.keywords ?? []).map((keyword) => keyword.toLowerCase());
        const matchesKeyword = (title: string) => {
          const lower = title.toLowerCase();
          return keywords.some((keyword) => lower.includes(keyword));
        };
        const newsMatches = clusters.filter(
          (cluster) => matchesKeyword(cluster.primaryTitle) || (cluster.allItems ?? []).some((item) => matchesKeyword(item.title)),
        ).length;
        const nearby = geoEngine.alertsNear(hotspot.lat, hotspot.lon, 300);
        const ciiScore = getHotspotCountryScore(hotspot.id, ciiLookup);
        const score = computeEscalationScore(
          hotspot,
          {
            newsMatches,
            hasBreaking: false,
            newsVelocity: 0,
            ciiScore,
            geoAlertScore: nearby?.score ?? 0,
            geoAlertTypes: nearby?.types ?? 0,
            flightsNearby: countMilitaryNearHotspot(hotspot, flights, []).flights,
            vesselsNearby: 0,
          },
          { now, previousHistory: [] },
        );
        return {
          hotspotId: score.hotspotId,
          name: hotspot.name,
          lat: hotspot.lat,
          lon: hotspot.lon,
          staticBaseline: score.staticBaseline,
          dynamicScore: score.dynamicScore,
          combinedScore: score.combinedScore,
          components: score.components,
          trend: score.trend,
        };
      });

      const limit = resolveLimit(params.limit, INTEL_HOTSPOTS.length);
      scored.sort((a, b) => b.combinedScore - a.combinedScore || b.dynamicScore - a.dynamicScore);
      return {
        ...freshness,
        data: {
          hotspots: scored.slice(0, limit),
          input_availability: {
            news_pressure: insights !== null,
            country_instability: riskScores !== null,
            geo_convergence: [unrest, flightsPayload, quakes].every((value) => value !== null),
            military_flights: flightsPayload !== null,
            breaking_news: false,
            news_velocity: false,
            military_vessels: false,
            score_history: false,
          },
        },
      };
    },
    _coverageKeys: ['news:insights:v1', CII_RISK_SCORE_CACHE_KEYS.live, 'military:flights:v1', 'unrest:events:v1', 'seismology:earthquakes:v1'],
    _apiPaths: [],
  },
];
