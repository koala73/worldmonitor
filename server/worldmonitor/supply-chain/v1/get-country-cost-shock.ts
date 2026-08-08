import type {
  ServerContext,
  GetCountryCostShockRequest,
  GetCountryCostShockResponse,
  ChokepointInfo,
  WarRiskTier,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { CHOKEPOINT_REGISTRY } from '../../../../src/config/chokepoint-registry';
import { computeEnergyShockScenario } from '../../intelligence/v1/compute-energy-shock';
import { warRiskTierToInsurancePremiumBps } from './_insurance-tier';
import { COST_SHOCK_KEY, CHOKEPOINT_STATUS_KEY } from '../../../_shared/cache-keys';

export async function getCountryCostShock(
  ctx: ServerContext,
  req: GetCountryCostShockRequest,
): Promise<GetCountryCostShockResponse> {
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetCountryCostShockResponse = {
    iso2: req.iso2,
    chokepointId: req.chokepointId,
    hs2: req.hs2 || '27',
    supplyDeficitPct: 0,
    coverageDays: 0,
    warRiskPremiumBps: 0,
    warRiskTier: 'WAR_RISK_TIER_UNSPECIFIED',
    hasEnergyModel: false,
    unavailableReason: '',
    fetchedAt: new Date().toISOString(),
  };
  if (!isPro) return empty;

  const iso2 = req.iso2?.trim().toUpperCase();
  const chokepointId = req.chokepointId?.trim().toLowerCase();
  const hs2 = req.hs2?.trim() || '27';

  if (!/^[A-Z]{2}$/.test(iso2 ?? '') || !chokepointId) {
    return { ...empty, iso2: iso2 ?? '', chokepointId: chokepointId ?? '' };
  }

  if (!/^\d{1,2}$/.test(hs2)) {
    return { ...empty, iso2: iso2 ?? '', chokepointId: chokepointId ?? '' };
  }

  const registry = CHOKEPOINT_REGISTRY.find(c => c.id === chokepointId);

  const statusRaw = await getCachedJson(CHOKEPOINT_STATUS_KEY).catch(() => null) as { chokepoints?: ChokepointInfo[] } | null;
  const cpStatus = statusRaw?.chokepoints?.find(c => c.id === chokepointId);
  const warRiskTier = (cpStatus?.warRiskTier ?? 'WAR_RISK_TIER_NORMAL') as WarRiskTier;
  const premiumBps = warRiskTierToInsurancePremiumBps(warRiskTier);

  const isEnergy = hs2 === '27';
  const hasEnergyModel = isEnergy && (registry?.shockModelSupported ?? false);

  let supplyDeficitPct = 0;
  let coverageDays = 0;
  let unavailableReason = '';

  if (!isEnergy) {
    unavailableReason = `Energy stockpile coverage (coverageDays) is available for HS 27 (mineral fuels) only. HS ${hs2} cost modelling deferred to v2.`;
  } else if (!hasEnergyModel) {
    unavailableReason = `Cost shock modelling for ${registry?.displayName ?? chokepointId} is not yet supported. Only Suez, Hormuz, Malacca, and Bab el-Mandeb have energy models in v1.`;
  } else {
    // Outer cache collapses 3 serial Redis reads → 1 on warm path; cachedFetchJson coalesces concurrent cold misses.
    const outerKey = COST_SHOCK_KEY(iso2, chokepointId);
    const shock = await cachedFetchJson(outerKey, 300, () =>
      computeEnergyShockScenario(ctx, {
        countryCode: iso2,
        chokepointId,
        disruptionPct: 100,
        fuelMode: 'oil',
      }).catch(() => null)
    ).catch(() => null);

    coverageDays = Math.max(0, shock?.effectiveCoverDays ?? 0);
    // Average deficit across all modelled products (Gasoline, Diesel, Jet fuel, LPG) with demand > 0.
    // computeEnergyShockScenario already filters to products with demand; zero-deficit products
    // are valid data points (demand exists but disruption causes no shortage) and must stay in the denominator.
    const productDeficits = shock?.products?.map((p: { product: string; deficitPct: number }) => p.deficitPct) ?? [];
    supplyDeficitPct = productDeficits.length > 0
      ? productDeficits.reduce((a: number, b: number) => a + b, 0) / productDeficits.length
      : 0;
  }

  return {
    iso2,
    chokepointId,
    hs2,
    supplyDeficitPct: Math.round(supplyDeficitPct * 10) / 10,
    coverageDays,
    warRiskPremiumBps: premiumBps,
    warRiskTier,
    hasEnergyModel,
    unavailableReason,
    fetchedAt: new Date().toISOString(),
  };
}
