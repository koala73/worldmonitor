import type {
  ServerContext,
  GetChokepointStatusRequest,
  GetChokepointStatusResponse,
  ChokepointInfo,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import type {
  ListNavigationalWarningsResponse,
  GetVesselSnapshotResponse,
  AisDisruption,
} from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { listNavigationalWarnings } from '../../maritime/v1/list-navigational-warnings';
import { getVesselSnapshot } from '../../maritime/v1/get-vessel-snapshot';
// @ts-expect-error — .mjs module, no declaration file
import { computeDisruptionScore, scoreToStatus, SEVERITY_SCORE } from './_scoring.mjs';

const REDIS_CACHE_KEY = 'supply_chain:chokepoints:v1';
const REDIS_CACHE_TTL = 300;

interface ChokepointConfig {
  id: string;
  name: string;
  lat: number;
  lon: number;
  areaKeywords: string[];
  routes: string[];
}

const CHOKEPOINTS: ChokepointConfig[] = [
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, areaKeywords: ['suez', 'red sea'], routes: ['China-Europe (Suez)', 'Gulf-Europe Oil', 'Qatar LNG-Europe'] },
  { id: 'malacca', name: 'Malacca Strait', lat: 1.43, lon: 103.5, areaKeywords: ['malacca', 'singapore strait'], routes: ['China-Middle East Oil', 'China-Europe (via Suez)', 'Japan-Middle East Oil'] },
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, areaKeywords: ['hormuz', 'persian gulf', 'arabian gulf'], routes: ['Gulf Oil Exports', 'Qatar LNG', 'Iran Exports'] },
  { id: 'bab_el_mandeb', name: 'Bab el-Mandeb', lat: 12.58, lon: 43.33, areaKeywords: ['bab el-mandeb', 'bab al-mandab', 'mandeb', 'aden'], routes: ['Suez-Indian Ocean', 'Gulf-Europe Oil', 'Red Sea Transit'] },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, areaKeywords: ['panama'], routes: ['US East Coast-Asia', 'US East Coast-South America', 'Atlantic-Pacific Bulk'] },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, areaKeywords: ['taiwan strait', 'formosa'], routes: ['China-Japan Trade', 'Korea-Southeast Asia', 'Pacific Semiconductor'] },
];

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
    listNavigationalWarnings(ctx, { area: '' }).catch((): ListNavigationalWarningsResponse => { navFailed = true; return { warnings: [], pagination: undefined }; }),
    getVesselSnapshot(ctx, {}).catch((): GetVesselSnapshotResponse => { vesselFailed = true; return { snapshot: undefined }; }),
  ]);

  const warnings = navResult.warnings || [];
  const disruptions: AisDisruption[] = vesselResult.snapshot?.disruptions || [];
  const bothSourcesEmpty = warnings.length === 0 && disruptions.length === 0;
  const upstreamUnavailable = navFailed || vesselFailed || bothSourcesEmpty;

  const chokepoints = CHOKEPOINTS.map((cp): ChokepointInfo => {
    const matchedWarnings = warnings.filter(w =>
      cp.areaKeywords.some(kw => w.text.toLowerCase().includes(kw) || w.area.toLowerCase().includes(kw))
    );

    const matchedDisruptions = disruptions.filter(d =>
      d.type === 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION' &&
      cp.areaKeywords.some(kw => d.region.toLowerCase().includes(kw) || d.name.toLowerCase().includes(kw))
    );

    const maxSeverity = matchedDisruptions.reduce((max, d) => {
      const score = (SEVERITY_SCORE as Record<string, number>)[d.severity] ?? 0;
      return Math.max(max, score);
    }, 0);

    const disruptionScore = computeDisruptionScore(matchedWarnings.length, maxSeverity);
    const status = scoreToStatus(disruptionScore);

    const congestionLevel = maxSeverity >= 3 ? 'high' : maxSeverity >= 2 ? 'elevated' : maxSeverity >= 1 ? 'low' : 'normal';

    const descriptions: string[] = [];
    if (matchedWarnings.length > 0) descriptions.push(`${matchedWarnings.length} active navigational warning(s)`);
    if (matchedDisruptions.length > 0) descriptions.push(`AIS congestion detected`);
    if (descriptions.length === 0) descriptions.push('No active disruptions');

    return {
      id: cp.id,
      name: cp.name,
      lat: cp.lat,
      lon: cp.lon,
      disruptionScore,
      status,
      activeWarnings: matchedWarnings.length,
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
        return { chokepoints, fetchedAt: new Date().toISOString(), upstreamUnavailable };
      },
    );

    return result ?? { chokepoints: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return { chokepoints: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
