/**
 * GET /api/v2/shipping/route-intelligence
 *
 * Vendor-facing route intelligence API. Returns the primary trade route, chokepoint
 * exposures, bypass options, war risk tier, and disruption score for a given
 * country pair + cargo type.
 *
 * Authentication: X-WorldMonitor-Key required (forceKey: true). Browser origins
 * are NOT exempt — this endpoint is designed for server-to-server integration.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../../_cors.js';
import { isCallerPremium } from '../../../server/_shared/premium-check';
import { getCachedJson } from '../../../server/_shared/redis';
import { CHOKEPOINT_STATUS_KEY } from '../../../server/_shared/cache-keys';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT } from '../../../server/_shared/bypass-corridors';
import { CHOKEPOINT_REGISTRY } from '../../../server/_shared/chokepoint-registry';
import COUNTRY_PORT_CLUSTERS from '../../../scripts/shared/country-port-clusters.json';

interface PortClusterEntry {
  nearestRouteIds: string[];
  coastSide: string;
}

interface ChokepointStatus {
  id: string;
  name?: string;
  disruptionScore?: number;
  warRiskTier?: string;
}

interface ChokepointStatusResponse {
  chokepoints?: ChokepointStatus[];
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  let apiKeyResult = validateApiKey(req, { forceKey: true });
  // Fallback: wm_ user keys are validated async via Convex, not in the static key list
  const wmKey =
    req.headers.get('X-WorldMonitor-Key') ??
    req.headers.get('X-Api-Key') ??
    '';
  if (apiKeyResult.required && !apiKeyResult.valid && wmKey.startsWith('wm_')) {
    const { validateUserApiKey } = await import('../../../server/_shared/user-api-key');
    const userKeyResult = await validateUserApiKey(wmKey);
    if (userKeyResult) {
      apiKeyResult = { valid: true, required: true };
    }
  }
  if (apiKeyResult.required && !apiKeyResult.valid) {
    return new Response(JSON.stringify({ error: apiKeyResult.error ?? 'API key required' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const isPro = await isCallerPremium(req);
  if (!isPro) {
    return new Response(JSON.stringify({ error: 'PRO subscription required' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const { searchParams } = new URL(req.url);
  const fromIso2 = searchParams.get('fromIso2')?.trim().toUpperCase() ?? '';
  const toIso2 = searchParams.get('toIso2')?.trim().toUpperCase() ?? '';
  const cargoType = (searchParams.get('cargoType')?.trim().toLowerCase() ?? 'container') as 'container' | 'tanker' | 'bulk' | 'roro';
  const hs2 = searchParams.get('hs2')?.trim().replace(/\D/g, '') || '27';

  if (!/^[A-Z]{2}$/.test(fromIso2) || !/^[A-Z]{2}$/.test(toIso2)) {
    return new Response(JSON.stringify({ error: 'fromIso2 and toIso2 must be valid 2-letter ISO country codes' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
  const fromCluster = clusters[fromIso2];
  const toCluster = clusters[toIso2];

  const fromRoutes = new Set(fromCluster?.nearestRouteIds ?? []);
  const toRoutes = new Set(toCluster?.nearestRouteIds ?? []);
  const sharedRoutes = [...fromRoutes].filter(r => toRoutes.has(r));
  const primaryRouteId = sharedRoutes[0] ?? fromCluster?.nearestRouteIds[0] ?? '';

  // Load live chokepoint data
  const statusRaw = await getCachedJson(CHOKEPOINT_STATUS_KEY).catch(() => null) as ChokepointStatusResponse | null;
  const statusMap = new Map<string, ChokepointStatus>(
    (statusRaw?.chokepoints ?? []).map(cp => [cp.id, cp])
  );

  // Find chokepoints on the primary route and shared routes
  const relevantRouteSet = new Set(sharedRoutes.length ? sharedRoutes : (fromCluster?.nearestRouteIds ?? []));
  const chokepointExposures = CHOKEPOINT_REGISTRY
    .filter(cp => cp.routeIds.some(r => relevantRouteSet.has(r)))
    .map(cp => {
      const overlap = cp.routeIds.filter(r => relevantRouteSet.has(r)).length;
      const exposurePct = Math.round((overlap / Math.max(cp.routeIds.length, 1)) * 100);
      return { chokepointId: cp.id, chokepointName: cp.displayName, exposurePct };
    })
    .filter(e => e.exposurePct > 0)
    .sort((a, b) => b.exposurePct - a.exposurePct);

  const primaryChokepoint = chokepointExposures[0];
  const primaryCpStatus = primaryChokepoint ? statusMap.get(primaryChokepoint.chokepointId) : null;

  const disruptionScore = primaryCpStatus?.disruptionScore ?? 0;
  const warRiskTier = primaryCpStatus?.warRiskTier ?? 'WAR_RISK_TIER_NORMAL';

  // Bypass options for the primary chokepoint
  const corridors = primaryChokepoint
    ? (BYPASS_CORRIDORS_BY_CHOKEPOINT[primaryChokepoint.chokepointId] ?? [])
      .filter(c => c.suitableCargoTypes.length === 0 || c.suitableCargoTypes.includes(cargoType))
      .slice(0, 5)
      .map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        addedTransitDays: c.addedTransitDays,
        addedCostMultiplier: c.addedCostMultiplier,
        activationThreshold: c.activationThreshold,
      }))
    : [];

  const body = {
    fromIso2,
    toIso2,
    cargoType,
    hs2,
    primaryRouteId,
    chokepointExposures,
    bypassOptions: corridors,
    warRiskTier,
    disruptionScore,
    fetchedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120' },
  });
}
