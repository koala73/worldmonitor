export const config = { runtime: 'edge' };

import { isCallerPremium } from '../../../server/_shared/premium-check';
import { CHOKEPOINT_REGISTRY } from '../../../server/_shared/chokepoint-registry';
import { CHOKEPOINT_STATUS_KEY } from '../../../server/_shared/cache-keys';
import {
  aggregateAnnualImportsByHs2,
  clampClosureDays,
  computeMultiSectorShocks,
  MULTI_SECTOR_HS2_LABELS,
  SEEDED_HS2_CODES,
  type MultiSectorCostShock,
  type SeededProduct,
} from '../../../server/worldmonitor/supply-chain/v1/_multi-sector-shock';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from '../../_upstash-json.js';

interface ChokepointStatusCache {
  chokepoints?: Array<{ id: string; warRiskTier?: string }>;
}

interface CountryProductsCache {
  iso2: string;
  products?: SeededProduct[];
  fetchedAt?: string;
}

export interface MultiSectorCostShockResponse {
  iso2: string;
  chokepointId: string;
  closureDays: number;
  warRiskTier: string;
  sectors: MultiSectorCostShock[];
  totalAddedCost: number;
  fetchedAt: string;
  unavailableReason: string;
}

function emptyResponse(
  iso2: string,
  chokepointId: string,
  closureDays: number,
  reason = '',
): MultiSectorCostShockResponse {
  return {
    iso2,
    chokepointId,
    closureDays,
    warRiskTier: 'WAR_RISK_TIER_UNSPECIFIED',
    sectors: [],
    totalAddedCost: 0,
    fetchedAt: new Date().toISOString(),
    unavailableReason: reason,
  };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('', { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const iso2 = (searchParams.get('iso2') ?? '').toUpperCase();
  const chokepointId = (searchParams.get('chokepointId') ?? '').trim().toLowerCase();
  const rawDays = Number(searchParams.get('closureDays') ?? '30');
  const closureDays = clampClosureDays(rawDays);

  if (!/^[A-Z]{2}$/.test(iso2)) {
    return new Response(
      JSON.stringify({ error: 'Invalid or missing iso2 parameter' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!chokepointId) {
    return new Response(
      JSON.stringify({ error: 'Invalid or missing chokepointId parameter' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!CHOKEPOINT_REGISTRY.some(c => c.id === chokepointId)) {
    return new Response(
      JSON.stringify({ error: `Unknown chokepointId: ${chokepointId}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const isPro = await isCallerPremium(req);
  if (!isPro) {
    return new Response(
      JSON.stringify({ error: 'PRO subscription required' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Parallel Redis reads: country products + chokepoint status (for war risk tier).
  const productsKey = `comtrade:bilateral-hs4:${iso2}:v1`;
  const [productsCache, statusCache] = await Promise.all([
    readJsonFromUpstash(productsKey, 5_000).catch(() => null) as Promise<CountryProductsCache | null>,
    readJsonFromUpstash(CHOKEPOINT_STATUS_KEY, 5_000).catch(() => null) as Promise<ChokepointStatusCache | null>,
  ]);

  const products = Array.isArray(productsCache?.products) ? productsCache.products : [];
  const importsByHs2 = aggregateAnnualImportsByHs2(products);
  const hasAnyImports = Object.values(importsByHs2).some(v => v > 0);
  const warRiskTier = statusCache?.chokepoints?.find(c => c.id === chokepointId)?.warRiskTier
    ?? 'WAR_RISK_TIER_NORMAL';

  if (!hasAnyImports) {
    return new Response(
      JSON.stringify({
        ...emptyResponse(iso2, chokepointId, closureDays, 'No seeded import data available for this country'),
        // Still emit the empty sector skeleton so the UI can render rows at 0.
        sectors: SEEDED_HS2_CODES.map(hs2 => ({
          hs2,
          hs2Label: MULTI_SECTOR_HS2_LABELS[hs2] ?? `HS ${hs2}`,
          importValueAnnual: 0,
          freightAddedPctPerTon: 0,
          warRiskPremiumBps: 0,
          addedTransitDays: 0,
          totalCostShockPerDay: 0,
          totalCostShock30Days: 0,
          totalCostShock90Days: 0,
          totalCostShock: 0,
          closureDays,
        })),
        warRiskTier,
      } satisfies MultiSectorCostShockResponse),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  const sectors = computeMultiSectorShocks(importsByHs2, chokepointId, warRiskTier, closureDays);
  const totalAddedCost = sectors.reduce((sum, s) => sum + s.totalCostShock, 0);

  const response: MultiSectorCostShockResponse = {
    iso2,
    chokepointId,
    closureDays,
    warRiskTier,
    sectors,
    totalAddedCost,
    fetchedAt: new Date().toISOString(),
    unavailableReason: '',
  };

  return new Response(
    JSON.stringify(response),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Closure duration is user-controlled, so cache is private + short.
        'Cache-Control': 'private, max-age=60',
        'Vary': 'Authorization, Cookie, X-WorldMonitor-Key',
      },
    },
  );
}
