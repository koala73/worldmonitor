import type {
  ServerContext,
  GetMultiSectorCostShockRequest,
  GetMultiSectorCostShockResponse,
  ChokepointInfo,
  MultiSectorCostShock,
  WarRiskTier,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { getCachedJson } from '../../../_shared/redis';
import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import { CHOKEPOINT_STATUS_KEY } from '../../../_shared/cache-keys';
import {
  aggregateAnnualImportsByHs2,
  clampClosureDays,
  computeMultiSectorShocks,
  MULTI_SECTOR_HS2_LABELS,
  SEEDED_HS2_CODES,
  type SeededProduct,
} from './_multi-sector-shock';

interface CountryProductsCache {
  iso2: string;
  products?: SeededProduct[];
  fetchedAt?: string;
}

function emptySectorSkeleton(closureDays: number): MultiSectorCostShock[] {
  return SEEDED_HS2_CODES.map(hs2 => ({
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
  }));
}

function emptyResponse(
  iso2: string,
  chokepointId: string,
  closureDays: number,
  warRiskTier: WarRiskTier = 'WAR_RISK_TIER_UNSPECIFIED',
  unavailableReason = '',
  sectors: MultiSectorCostShock[] = [],
): GetMultiSectorCostShockResponse {
  return {
    iso2,
    chokepointId,
    closureDays,
    warRiskTier,
    sectors,
    totalAddedCost: 0,
    fetchedAt: new Date().toISOString(),
    unavailableReason,
  };
}

export async function getMultiSectorCostShock(
  ctx: ServerContext,
  req: GetMultiSectorCostShockRequest,
): Promise<GetMultiSectorCostShockResponse> {
  const iso2 = (req.iso2 ?? '').trim().toUpperCase();
  const chokepointId = (req.chokepointId ?? '').trim().toLowerCase();
  const closureDays = clampClosureDays(req.closureDays ?? 30);

  // Input-shape errors return 400 — restoring the legacy /api/supply-chain/v1/
  // multi-sector-cost-shock contract. Empty-payload-200 is reserved for the
  // PRO-gate deny path (intentional contract shift), not for caller bugs
  // (malformed or missing fields). Distinguishing the two matters for external
  // API consumers, tests, and silent-failure detection in logs.
  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase ISO country code' }]);
  }
  if (!chokepointId) {
    throw new ValidationError([{ field: 'chokepointId', description: 'chokepointId is required' }]);
  }
  if (!CHOKEPOINT_REGISTRY.some(c => c.id === chokepointId)) {
    throw new ValidationError([{ field: 'chokepointId', description: `Unknown chokepointId: ${chokepointId}` }]);
  }

  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) return emptyResponse(iso2, chokepointId, closureDays);

  // Seeder writes the products payload via raw key (no env-prefix) — read raw.
  const productsKey = `comtrade:bilateral-hs4:${iso2}:v1`;
  const [productsCache, statusCache] = await Promise.all([
    getCachedJson(productsKey, true).catch(() => null) as Promise<CountryProductsCache | null>,
    getCachedJson(CHOKEPOINT_STATUS_KEY).catch(() => null) as Promise<{ chokepoints?: ChokepointInfo[] } | null>,
  ]);

  const products = Array.isArray(productsCache?.products) ? productsCache.products : [];
  const importsByHs2 = aggregateAnnualImportsByHs2(products);
  const hasAnyImports = Object.values(importsByHs2).some(v => v > 0);
  const warRiskTier = (statusCache?.chokepoints?.find(c => c.id === chokepointId)?.warRiskTier
    ?? 'WAR_RISK_TIER_NORMAL') as WarRiskTier;

  if (!hasAnyImports) {
    return emptyResponse(
      iso2,
      chokepointId,
      closureDays,
      warRiskTier,
      'No seeded import data available for this country',
      emptySectorSkeleton(closureDays),
    );
  }

  const sectors = computeMultiSectorShocks(importsByHs2, chokepointId, warRiskTier, closureDays);
  const totalAddedCost = sectors.reduce((sum, s) => sum + s.totalCostShock, 0);

  return {
    iso2,
    chokepointId,
    closureDays,
    warRiskTier,
    sectors,
    totalAddedCost,
    fetchedAt: new Date().toISOString(),
    unavailableReason: '',
  };
}
