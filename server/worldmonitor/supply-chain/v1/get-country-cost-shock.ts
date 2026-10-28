import type {
  ServerContext,
  GetCountryCostShockRequest,
  GetCountryCostShockResponse,
  ChokepointInfo,
  WarRiskTier,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isAssignedCountryCode } from '../../../../shared/country-code-resolve';
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
  // The gateway applies the proto's shape rule only. Check membership here,
  // ahead of the premium gate as the gateway's 400 is, so an unassigned code
  // such as ZZ gets a 400 instead of an energy-shock computation cached under it.
  const iso2 = (req.iso2 ?? '').trim().toUpperCase();
  if (!isAssignedCountryCode(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be an assigned ISO 3166-1 alpha-2 code, e.g. "IQ".' }]);
  }

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

  const chokepointId = req.chokepointId?.trim().toLowerCase();
  const hs2 = req.hs2?.trim() || '27';

  if (!chokepointId) {
    return { ...empty, iso2, chokepointId: chokepointId ?? '' };
  }

  if (!/^\d{1,2}$/.test(hs2)) {
    return { ...empty, iso2, chokepointId: chokepointId ?? '' };
  }

  const registry = CHOKEPOINT_REGISTRY.find(c => c.id === chokepointId);

  const statusRaw = await getCachedJson(CHOKEPOINT_STATUS_KEY).catch(() => null) as { chokepoints?: ChokepointInfo[] } | null;
  const cpStatus = statusRaw?.chokepoints?.find(c => c.id === chokepointId);
  const warRiskTier = (cpStatus?.warRiskTier ?? 'WAR_RISK_TIER_NORMAL') as WarRiskTier;
  const premiumBps = warRiskTierToInsurancePremiumBps(warRiskTier);

  const isEnergy = hs2 === '27';
  const modelSupported = isEnergy && (registry?.shockModelSupported ?? false);
  // has_energy_model means supply_deficit_pct and coverage_days ARE modelled.
  // A supported route whose oil scenario has no usable inputs is still
  // unavailable, so the flag follows the shock's dataAvailable below.
  let hasEnergyModel = modelSupported;

  let supplyDeficitPct = 0;
  let coverageDays = 0;
  let unavailableReason = '';

  if (!isEnergy) {
    unavailableReason = `Energy stockpile coverage (coverageDays) is available for HS 27 (mineral fuels) only. HS ${hs2} cost modelling deferred to v2.`;
  } else if (!modelSupported) {
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

    if (!shock || shock.dataAvailable !== true) {
      // Missing JODI crude imports or Comtrade origin share: the shock reports
      // zeros that are "not modelled", never a zero-impact result. Surface the
      // handler's own reason when it has one.
      hasEnergyModel = false;
      const missing = shock?.limitations?.find((l) => /not modeled/.test(l));
      unavailableReason = shock
        ? `Oil shock modelling is unavailable for ${iso2}: ${missing ?? shock.assessment ?? 'required crude import inputs are missing'}`
        : `Oil shock modelling is unavailable for ${iso2}: the energy scenario could not be computed.`;
    } else {
      // dataAvailable covers the loss inputs only. Each reported field has its
      // own prerequisite: coverage needs an IEA stock observation (a net
      // exporter is observed and reports 0 by contract), the deficit needs at
      // least one refined product with recorded demand. A field without its
      // observation stays 0 and is named in unavailableReason; has_energy_model
      // is true only when both are modelled, as the proto defines it.
      const productDeficits = shock.products?.map((p: { product: string; deficitPct: number }) => p.deficitPct) ?? [];
      const coverageModeled = shock.ieaStocksCoverage === true;
      const deficitModeled = productDeficits.length > 0;
      if (coverageModeled) coverageDays = Math.max(0, shock.effectiveCoverDays ?? 0);
      // Average deficit across all modelled products (Gasoline, Diesel, Jet fuel, LPG) with demand > 0.
      // computeEnergyShockScenario already filters to products with demand; zero-deficit products
      // are valid data points (demand exists but disruption causes no shortage) and must stay in the denominator.
      if (deficitModeled) supplyDeficitPct = productDeficits.reduce((a: number, b: number) => a + b, 0) / productDeficits.length;
      hasEnergyModel = coverageModeled && deficitModeled;
      const gaps: string[] = [];
      if (!coverageModeled) gaps.push(`coverageDays is unavailable: no IEA stock observation for ${iso2}`);
      if (!deficitModeled) gaps.push(`supplyDeficitPct is unavailable: no refined-product demand observation for ${iso2}`);
      if (gaps.length > 0) {
        const modeled = coverageModeled ? 'coverageDays is modelled' : deficitModeled ? 'supplyDeficitPct is modelled' : '';
        unavailableReason = `${gaps.join('; ')}${modeled ? ` (${modeled})` : ''}.`;
      }
    }
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
