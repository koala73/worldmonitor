import type {
  ServerContext,
  GetCountryCostShockRequest,
  GetCountryCostShockResponse,
  WarRiskTier,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { getCachedJson } from '../../../_shared/redis';
import { CHOKEPOINT_REGISTRY } from '../../../../src/config/chokepoint-registry';
import { computeEnergyShockScenario } from '../../intelligence/v1/compute-energy-shock';
import { threatLevelToInsurancePremiumBps } from './_insurance-tier';
import type { ThreatLevel } from './_insurance-tier';

function warRiskTierToThreatLevel(tier: string): ThreatLevel {
  switch (tier) {
    case 'WAR_RISK_TIER_WAR_ZONE':  return 'war_zone';
    case 'WAR_RISK_TIER_CRITICAL':  return 'critical';
    case 'WAR_RISK_TIER_HIGH':      return 'high';
    case 'WAR_RISK_TIER_ELEVATED':  return 'elevated';
    default:                        return 'normal';
  }
}

function threatLevelToWarRiskTier(tl: ThreatLevel): WarRiskTier {
  switch (tl) {
    case 'war_zone':  return 'WAR_RISK_TIER_WAR_ZONE';
    case 'critical':  return 'WAR_RISK_TIER_CRITICAL';
    case 'high':      return 'WAR_RISK_TIER_HIGH';
    case 'elevated':  return 'WAR_RISK_TIER_ELEVATED';
    default:          return 'WAR_RISK_TIER_NORMAL';
  }
}

export async function getCountryCostShock(
  ctx: ServerContext,
  req: GetCountryCostShockRequest,
): Promise<GetCountryCostShockResponse> {
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetCountryCostShockResponse = {
    iso2: req.iso2,
    chokepointId: req.chokepointId,
    hs2: req.hs2 || '27',
    costIncreasePct: 0,
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

  const registry = CHOKEPOINT_REGISTRY.find(c => c.id === chokepointId);

  type CpEntry = { id: string; warRiskTier?: string };
  const statusRaw = await getCachedJson('supply_chain:chokepoints:v4').catch(() => null) as { chokepoints?: CpEntry[] } | null;
  const cpStatus = statusRaw?.chokepoints?.find(c => c.id === chokepointId);
  const warRiskTierStr = cpStatus?.warRiskTier ?? 'WAR_RISK_TIER_NORMAL';
  const threatLevel = warRiskTierToThreatLevel(warRiskTierStr);
  const premiumBps = threatLevelToInsurancePremiumBps(threatLevel);
  const warRiskTier = threatLevelToWarRiskTier(threatLevel);

  const isEnergy = hs2 === '27';
  const hasEnergyModel = isEnergy && (registry?.shockModelSupported ?? false);

  let costIncreasePct = 0;
  let coverageDays = 0;
  let unavailableReason = '';

  if (!isEnergy) {
    unavailableReason = `Energy stockpile coverage (coverageDays) is available for HS 27 (mineral fuels) only. HS ${hs2} cost modelling deferred to v2.`;
  } else if (!hasEnergyModel) {
    unavailableReason = `Cost shock modelling for ${registry?.displayName ?? chokepointId} is not yet supported. Only Suez, Hormuz, Malacca, and Bab el-Mandeb have energy models in v1.`;
  } else {
    // Call computeEnergyShockScenario directly — it handles its own v2 cache internally.
    // Use 100% disruption (full closure scenario) and oil mode for HS 27.
    const shock = await computeEnergyShockScenario(ctx, {
      countryCode: iso2,
      chokepointId,
      disruptionPct: 100,
      fuelMode: 'oil',
    }).catch(() => null);
    coverageDays = shock?.effectiveCoverDays ?? 0;
    // No 'crude' product entry — compute average deficit across refined products (Gasoline, Diesel, Jet fuel, LPG).
    // This represents the fraction of refined product demand unmet under full Hormuz/Suez/Malacca/BEM closure.
    const productDeficits = shock?.products?.map((p: { product: string; deficitPct: number }) => p.deficitPct).filter((d: number) => d > 0) ?? [];
    costIncreasePct = productDeficits.length > 0
      ? productDeficits.reduce((a: number, b: number) => a + b, 0) / productDeficits.length
      : 0;
  }

  return {
    iso2,
    chokepointId,
    hs2,
    costIncreasePct: Math.round(costIncreasePct * 10) / 10,
    coverageDays,
    warRiskPremiumBps: premiumBps,
    warRiskTier,
    hasEnergyModel,
    unavailableReason,
    fetchedAt: new Date().toISOString(),
  };
}
