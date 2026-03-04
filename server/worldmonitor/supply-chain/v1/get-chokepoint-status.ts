import type {
  ServerContext,
  GetChokepointStatusRequest,
  GetChokepointStatusResponse,
  ChokepointInfo,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import type {
  ListNavigationalWarningsResponse,
  GetVesselSnapshotResponse,
  NavigationalWarning,
  AisDisruption,
} from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { listNavigationalWarnings } from '../../maritime/v1/list-navigational-warnings';
import { getVesselSnapshot } from '../../maritime/v1/get-vessel-snapshot';
// @ts-expect-error — .mjs module, no declaration file
import { computeDisruptionScore, scoreToStatus, SEVERITY_SCORE, THREAT_LEVEL } from './_scoring.mjs';

const REDIS_CACHE_KEY = 'supply_chain:chokepoints:v2';
const REDIS_CACHE_TTL = 300; // 5 min
const THREAT_CONFIG_MAX_AGE_DAYS = 120;
const NEARBY_CHOKEPOINT_RADIUS_KM = 300;
const THREAT_CONFIG_STALE_NOTE = `Threat baseline last reviewed > ${THREAT_CONFIG_MAX_AGE_DAYS} days ago — review recommended`;

type ThreatLevel = 'war_zone' | 'critical' | 'high' | 'elevated' | 'normal';
type GeoCoordinates = { latitude: number; longitude: number };

interface ChokepointConfig {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /**
   * Precise chokepoint aliases used for high-confidence text matching.
   * A single primary hit is enough to classify an event.
   */
  primaryKeywords: string[];
  /**
   * Broader contextual tokens used only as secondary signals.
   * To reduce false positives, non-primary matching requires >=2 context hits.
   */
  areaKeywords: string[];
  routes: string[];
  /**
   * Geopolitical threat classification — based on Lloyd's Joint War Committee
   * Listed Areas and real-world maritime security conditions.
   *
   *   war_zone — Active naval conflict, blockade, or strait closure
   *   critical — Active attacks on commercial shipping (e.g. Houthi drone/missile strikes)
   *   high     — Military seizure risk, armed escort zones
   *   elevated — Military tensions, disputed waters (e.g. cross-strait exercises)
   *   normal   — No significant military threat
   */
  threatLevel: ThreatLevel;
  /** Short explanation of the threat classification, shown in description. */
  threatDescription: string;
}

/**
 * Date the threat-level classifications and descriptions were last reviewed.
 * Review quarterly or whenever a major geopolitical shift occurs.
 * Source: Lloyd's Joint War Committee Listed Areas + OSINT.
 */
export const THREAT_CONFIG_LAST_REVIEWED = '2026-03-04';

export const CHOKEPOINTS: ChokepointConfig[] = [
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, primaryKeywords: ['suez canal', 'suez'], areaKeywords: ['suez canal', 'suez', 'gulf of suez', 'red sea'], routes: ['China-Europe (Suez)', 'Gulf-Europe Oil', 'Qatar LNG-Europe'], threatLevel: 'high', threatDescription: 'JWC Listed Area — adjacent to active Red Sea conflict and Iran-Israel war spillover' },
  { id: 'malacca', name: 'Strait of Malacca', lat: 1.43, lon: 103.5, primaryKeywords: ['strait of malacca', 'malacca'], areaKeywords: ['strait of malacca', 'malacca', 'singapore strait'], routes: ['China-Middle East Oil', 'China-Europe (via Suez)', 'Japan-Middle East Oil'], threatLevel: 'normal', threatDescription: '' },
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, primaryKeywords: ['strait of hormuz', 'hormuz'], areaKeywords: ['strait of hormuz', 'hormuz', 'persian gulf', 'arabian gulf', 'gulf of oman', 'iran naval', 'iran military'], routes: ['Gulf Oil Exports', 'Qatar LNG', 'Iran Exports'], threatLevel: 'war_zone', threatDescription: 'Active conflict — Iran-Israel war; Iranian naval blockade risk and mines reported in Persian Gulf' },
  { id: 'bab_el_mandeb', name: 'Bab el-Mandeb', lat: 12.58, lon: 43.33, primaryKeywords: ['bab el-mandeb', 'bab al-mandab'], areaKeywords: ['bab el-mandeb', 'bab al-mandab', 'mandeb', 'aden', 'houthi', 'yemen', 'gulf of aden', 'red sea'], routes: ['Suez-Indian Ocean', 'Gulf-Europe Oil', 'Red Sea Transit'], threatLevel: 'critical', threatDescription: 'JWC Listed Area — active Houthi attacks on commercial shipping' },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, primaryKeywords: ['panama canal'], areaKeywords: ['panama canal', 'panama'], routes: ['US East Coast-Asia', 'US East Coast-South America', 'Atlantic-Pacific Bulk'], threatLevel: 'normal', threatDescription: '' },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, primaryKeywords: ['taiwan strait', 'formosa'], areaKeywords: ['taiwan strait', 'formosa', 'taiwan', 'south china sea'], routes: ['China-Japan Trade', 'Korea-Southeast Asia', 'Pacific Semiconductor'], threatLevel: 'elevated', threatDescription: 'Cross-strait military tensions and PLA exercises' },
];

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(normalizedHaystack: string, keyword: string): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return false;
  return ` ${normalizedHaystack} `.includes(` ${normalizedKeyword} `);
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * (2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

function nearestChokepoint(location?: GeoCoordinates): { id: string; distanceKm: number } | null {
  if (!location) return null;

  let closest: { id: string; distanceKm: number } | null = null;
  for (const cp of CHOKEPOINTS) {
    const distanceKm = haversineKm(location.latitude, location.longitude, cp.lat, cp.lon);
    if (!closest || distanceKm < closest.distanceKm) {
      closest = { id: cp.id, distanceKm };
    }
  }
  return closest;
}

function keywordScore(cp: ChokepointConfig, normalizedText: string): number {
  if (!normalizedText) return 0;

  const primaryMatches = cp.primaryKeywords.filter((kw) => containsPhrase(normalizedText, kw));
  const primarySet = new Set(primaryMatches.map(normalizeText));
  const areaMatches = cp.areaKeywords.filter((kw) => {
    const normalizedKw = normalizeText(kw);
    return !primarySet.has(normalizedKw) && containsPhrase(normalizedText, kw);
  });

  // A single broad area token (e.g. "Red Sea") is too weak and often ambiguous.
  if (primaryMatches.length === 0 && areaMatches.length < 2) return 0;

  return primaryMatches.length * 3 + areaMatches.length;
}

export function resolveChokepointId(input: { text: string; location?: GeoCoordinates }): string | null {
  const normalizedText = normalizeText(input.text);
  let best: { id: string; score: number; distanceKm: number } | null = null;

  for (const cp of CHOKEPOINTS) {
    const score = keywordScore(cp, normalizedText);
    if (score <= 0) continue;

    const distanceKm = input.location
      ? haversineKm(input.location.latitude, input.location.longitude, cp.lat, cp.lon)
      : Number.POSITIVE_INFINITY;

    if (!best || score > best.score || (score === best.score && distanceKm < best.distanceKm)) {
      best = { id: cp.id, score, distanceKm };
    }
  }

  if (best) return best.id;

  const nearest = nearestChokepoint(input.location);
  if (nearest && nearest.distanceKm <= NEARBY_CHOKEPOINT_RADIUS_KM) {
    return nearest.id;
  }

  return null;
}

function groupWarningsByChokepoint(warnings: NavigationalWarning[]): Map<string, NavigationalWarning[]> {
  const grouped = new Map<string, NavigationalWarning[]>();
  for (const cp of CHOKEPOINTS) grouped.set(cp.id, []);

  for (const warning of warnings) {
    const id = resolveChokepointId({
      text: `${warning.title} ${warning.area} ${warning.text}`,
      location: warning.location,
    });
    if (!id) continue;
    grouped.get(id)!.push(warning);
  }

  return grouped;
}

function groupDisruptionsByChokepoint(disruptions: AisDisruption[]): Map<string, AisDisruption[]> {
  const grouped = new Map<string, AisDisruption[]>();
  for (const cp of CHOKEPOINTS) grouped.set(cp.id, []);

  for (const disruption of disruptions) {
    if (disruption.type !== 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION') continue;

    const id = resolveChokepointId({
      text: `${disruption.name} ${disruption.region} ${disruption.description}`,
      location: disruption.location,
    });
    if (!id) continue;
    grouped.get(id)!.push(disruption);
  }

  return grouped;
}

export function isThreatConfigFresh(asOfMs = Date.now()): boolean {
  const reviewedAtMs = Date.parse(THREAT_CONFIG_LAST_REVIEWED);
  if (!Number.isFinite(reviewedAtMs)) return false;
  const maxAgeMs = THREAT_CONFIG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return asOfMs - reviewedAtMs <= maxAgeMs;
}

function makeInternalCtx(): { request: Request; pathParams: Record<string, string>; headers: Record<string, string> } {
  return { request: new Request('http://internal'), pathParams: {}, headers: {} };
}

interface ChokepointFetchResult {
  chokepoints: ChokepointInfo[];
  upstreamUnavailable: boolean;
}

async function fetchChokepointData(): Promise<ChokepointFetchResult> {
  const ctx = makeInternalCtx();

  let navFailed = false;
  let vesselFailed = false;

  const [navResult, vesselResult] = await Promise.all([
    listNavigationalWarnings(ctx, { area: '', pageSize: 0, cursor: '' }).catch((): ListNavigationalWarningsResponse => { navFailed = true; return { warnings: [], pagination: undefined }; }),
    getVesselSnapshot(ctx, { neLat: 90, neLon: 180, swLat: -90, swLon: -180 }).catch((): GetVesselSnapshotResponse => { vesselFailed = true; return { snapshot: undefined }; }),
  ]);

  const warnings = navResult.warnings || [];
  const disruptions: AisDisruption[] = vesselResult.snapshot?.disruptions || [];
  const upstreamUnavailable = (navFailed && vesselFailed) || (navFailed && disruptions.length === 0) || (vesselFailed && warnings.length === 0);
  const warningsByChokepoint = groupWarningsByChokepoint(warnings);
  const disruptionsByChokepoint = groupDisruptionsByChokepoint(disruptions);
  const threatConfigFresh = isThreatConfigFresh();

  const chokepoints = CHOKEPOINTS.map((cp): ChokepointInfo => {
    const matchedWarnings = warningsByChokepoint.get(cp.id) ?? [];
    const matchedDisruptions = disruptionsByChokepoint.get(cp.id) ?? [];

    const maxSeverity = matchedDisruptions.reduce((max, d) => {
      const score = (SEVERITY_SCORE as Record<string, number>)[d.severity] ?? 0;
      return Math.max(max, score);
    }, 0);

    const threatScore = (THREAT_LEVEL as Record<string, number>)[cp.threatLevel] ?? 0;
    const disruptionScore = computeDisruptionScore(threatScore, matchedWarnings.length, maxSeverity);
    const status = scoreToStatus(disruptionScore);

    const congestionLevel = maxSeverity >= 3 ? 'high' : maxSeverity >= 2 ? 'elevated' : maxSeverity >= 1 ? 'low' : 'normal';

    const descriptions: string[] = [];
    if (cp.threatDescription) {
      descriptions.push(cp.threatDescription);
    }
    if (!threatConfigFresh) {
      descriptions.push(THREAT_CONFIG_STALE_NOTE);
    }
    if (matchedWarnings.length > 0 || matchedDisruptions.length > 0) {
      descriptions.push(`Navigational warnings: ${matchedWarnings.length}`);
      descriptions.push(`AIS vessel disruptions: ${matchedDisruptions.length}`);
    } else if (!cp.threatDescription) {
      descriptions.push('No active disruptions');
    }

    return {
      id: cp.id,
      name: cp.name,
      lat: cp.lat,
      lon: cp.lon,
      disruptionScore,
      status,
      activeWarnings: matchedWarnings.length,
      aisDisruptions: matchedDisruptions.length,
      congestionLevel,
      affectedRoutes: cp.routes,
      description: descriptions.join('; '),
    };
  });

  return { chokepoints, upstreamUnavailable };
}

export async function getChokepointStatus(
  _ctx: ServerContext,
  _req: GetChokepointStatusRequest,
): Promise<GetChokepointStatusResponse> {
  try {
    const result = await cachedFetchJson<GetChokepointStatusResponse>(
      REDIS_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => {
        const { chokepoints, upstreamUnavailable } = await fetchChokepointData();
        if (upstreamUnavailable) return null;
        return { chokepoints, fetchedAt: new Date().toISOString(), upstreamUnavailable };
      },
    );

    return result ?? { chokepoints: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return { chokepoints: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
