import type {
  ServerContext,
  ComputeEnergyShockScenarioRequest,
  ComputeEnergyShockScenarioResponse,
  ProductImpact,
  GasSensitivity,
  GasStorageObservation,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { SPR_POLICIES_KEY } from '../../../_shared/cache-keys';
import {
  clamp,
  CHOKEPOINT_EXPOSURE,
  VALID_CHOKEPOINTS,
  computeGulfShare,
  computeEffectiveCoverDays,
  buildAssessment,
  deriveCoverageLevel,
  deriveChokepointConfidence,
  parseFuelMode,
  EU_GAS_STORAGE_COUNTRIES,
  computeGasDisruption,
  buildGasAssessment,
  REFINERY_YIELD,
  REFINERY_YIELD_BASIS,
} from './_shock-compute';
import { ISO2_TO_COMTRADE } from './_comtrade-reporters';

const SHOCK_CACHE_TTL = 300;

const CP_TO_PORTWATCH: Record<string, string> = {
  hormuz_strait: 'hormuz_strait',
  bab_el_mandeb: 'bab_el_mandeb',
  suez: 'suez',
  malacca_strait: 'malacca_strait',
};

const PROXIED_GULF_SHARE = 0.40;

interface JodiProduct {
  demandKbd?: number | null;
  importsKbd?: number | null;
}

interface JodiOil {
  dataMonth?: string | null;
  gasoline?: JodiProduct | null;
  diesel?: JodiProduct | null;
  jet?: JodiProduct | null;
  lpg?: JodiProduct | null;
  crude?: { importsKbd?: number | null } | null;
}

interface IeaStocks {
  dataMonth?: string | null;
  daysOfCover?: number | null;
  netExporter?: boolean | null;
  belowObligation?: boolean | null;
  anomaly?: boolean | null;
}

interface JodiGas {
  dataMonth?: string | null;
  lngImportsTj?: number | null;
  pipeImportsTj?: number | null;
  totalDemandTj?: number | null;
  lngShareOfImports?: number | null;
  closingStockTj?: number | null;
}

interface GasStorageData {
  fillPct?: number | null;
  gasTwh?: number | null;
  trend?: string | null;
  date?: string | null;
}

interface ComtradeFlowRecord {
  reporterCode: string;
  partnerCode: string;
  cmdCode: string;
  tradeValueUsd: number;
  year: number;
}

interface ComtradeFlowsResult {
  flows?: ComtradeFlowRecord[];
  fetchedAt?: string;
}

interface ChokepointEntry {
  currentMbd?: number;
  baselineMbd?: number;
  flowRatio: number;
  disrupted?: boolean;
  source?: string;
  hazardAlertLevel?: string | null;
  hazardAlertName?: string | null;
}

function n(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function getGulfCrudeShare(countryCode: string): Promise<{ share: number; hasData: boolean }> {
  const numericCode = ISO2_TO_COMTRADE[countryCode];
  if (!numericCode) return { share: 0, hasData: false };

  const key = `comtrade:flows:${numericCode}:2709`;
  const result = await getCachedJson(key, true);
  if (!result) return { share: 0, hasData: false };

  const flowsResult = result as ComtradeFlowsResult;
  const flows: ComtradeFlowRecord[] = Array.isArray(result)
    ? (result as ComtradeFlowRecord[])
    : (flowsResult.flows ?? []);

  if (flows.length === 0) return { share: 0, hasData: false };

  return computeGulfShare(flows);
}

export async function computeEnergyShockScenario(
  _ctx: ServerContext,
  req: ComputeEnergyShockScenarioRequest,
): Promise<ComputeEnergyShockScenarioResponse> {
  const code = req.countryCode?.trim().toUpperCase() ?? '';
  const chokepointId = req.chokepointId?.trim().toLowerCase() ?? '';
  const disruptionPct = clamp(Math.round(req.disruptionPct ?? 0), 10, 100);
  const fuelMode = parseFuelMode(req.fuelMode);
  const needsOil = fuelMode === 'oil' || fuelMode === 'both';
  const needsGas = fuelMode === 'gas' || fuelMode === 'both';

  const EMPTY: ComputeEnergyShockScenarioResponse = {
    countryCode: code,
    chokepointId,
    disruptionPct,
    gulfCrudeShare: 0,
    crudeLossKbd: 0,
    products: [],
    effectiveCoverDays: 0,
    assessment: `Insufficient data to compute shock scenario for ${code}.`,
    dataAvailable: false,
    jodiOilCoverage: false,
    comtradeCoverage: false,
    ieaStocksCoverage: false,
    portwatchCoverage: false,
    coverageLevel: 'unsupported',
    limitations: [],
    degraded: false,
    chokepointConfidence: 'none',
    liveFlowRatio: undefined,
    gasSensitivity: undefined,
  };

  if (!code || code.length !== 2) return EMPTY;
  if (!VALID_CHOKEPOINTS.has(chokepointId)) {
    return {
      ...EMPTY,
      assessment: `Unknown chokepoint: ${chokepointId}. Valid chokepoints: hormuz_strait, malacca_strait, suez, bab_el_mandeb.`,
    };
  }

  const chokepointFlowsRaw2 = await getCachedJson('energy:chokepoint-flows:v1', true)
    .then((v) => v as Record<string, ChokepointEntry> | null)
    .catch(() => null);

  const portWatchKey = CP_TO_PORTWATCH[chokepointId];
  const cpEntry = portWatchKey ? (chokepointFlowsRaw2?.[portWatchKey] ?? null) : null;

  const degraded = !chokepointFlowsRaw2 || cpEntry == null || !Number.isFinite(cpEntry.flowRatio as number);

  const rawFlowRatio = (!degraded && cpEntry != null && Number.isFinite(cpEntry.flowRatio as number))
    ? cpEntry.flowRatio
    : null;
  const liveFlowRatio: number | null = rawFlowRatio !== null ? clamp(rawFlowRatio, 0, 1.5) : null;

  const cacheKey = `energy:shock:${needsOil ? 'v7' : 'v4'}:${code}:${chokepointId}:${disruptionPct}:${degraded ? 'd' : 'l'}:${fuelMode}`;
  const cached = await getCachedJson(cacheKey);
  if (cached) return cached as ComputeEnergyShockScenarioResponse;

  const [jodiOilResult, ieaStocksResult, gulfShareResult, emberResult, jodiGasResult, gasStorageResult] = await Promise.allSettled([
    getCachedJson(`energy:jodi-oil:v1:${code}`, true),
    getCachedJson(`energy:iea-oil-stocks:v1:${code}`, true),
    getGulfCrudeShare(code),
    getCachedJson(`energy:ember:v1:${code}`, true),
    needsGas ? getCachedJson(`energy:jodi-gas:v1:${code}`, true) : Promise.resolve(null),
    needsGas && EU_GAS_STORAGE_COUNTRIES.has(code)
      ? getCachedJson(`energy:gas-storage:v1:${code}`, true)
      : Promise.resolve(null),
  ]);

  const jodiOil = jodiOilResult.status === 'fulfilled' ? (jodiOilResult.value as JodiOil | null) : null;
  const ieaStocks = ieaStocksResult.status === 'fulfilled' ? (ieaStocksResult.value as IeaStocks | null) : null;
  const { share: rawGulfShare, hasData: comtradeHasData } = gulfShareResult.status === 'fulfilled'
    ? gulfShareResult.value
    : { share: 0, hasData: false };

  const emberData = emberResult.status === 'fulfilled' ? (emberResult.value as { fossilShare?: number } | null) : null;
  const jodiGas = jodiGasResult.status === 'fulfilled' ? (jodiGasResult.value as JodiGas | null) : null;
  const gasStorageData = gasStorageResult.status === 'fulfilled' ? (gasStorageResult.value as GasStorageData | null) : null;

  const baseExposure = CHOKEPOINT_EXPOSURE[chokepointId] ?? 1.0;
  const exposureMult = liveFlowRatio !== null ? baseExposure * liveFlowRatio : baseExposure;

  const jodiOilCoverage = jodiOil != null;
  const comtradeCoverage = comtradeHasData;
  const ieaStocksCoverage = ieaStocks != null && ieaStocks.anomaly !== true
    && (ieaStocks.netExporter === true || (ieaStocks.daysOfCover != null && Number.isFinite(ieaStocks.daysOfCover) && ieaStocks.daysOfCover >= 0));
  const portwatchCoverage = liveFlowRatio !== null;

  const limitations: string[] = [];
  if (!comtradeCoverage && jodiOilCoverage) {
    limitations.push('Gulf crude share proxied at 40% (no Comtrade data)');
  }
  if (!ieaStocksCoverage) {
    limitations.push('IEA strategic stock data unavailable');
  }
  limitations.push(REFINERY_YIELD_BASIS);
  if (degraded) {
    limitations.push('PortWatch flow data unavailable, using historical baseline multipliers');
  }

  const fossilShare = typeof emberData?.fossilShare === 'number' ? emberData.fossilShare : null;
  if (fossilShare !== null && fossilShare > 70) {
    limitations.push('high fossil grid dependency: limited electricity substitution capacity');
  }

  if (needsOil) {
    const sprRegistryRaw = await getCachedJson(SPR_POLICIES_KEY, true).catch(() => null) as Record<string, unknown> | null;
    const sprPolicies = (sprRegistryRaw as { policies?: Record<string, { regime?: string; ieaMember?: boolean; operator?: string; capacityMb?: number }> } | null)?.policies;
    const sprPolicy = sprPolicies?.[code];
    if (sprPolicy) {
      if (sprPolicy.regime === 'government_spr' && !sprPolicy.ieaMember) {
        limitations.push(`strategic reserves: ${sprPolicy.regime} (${sprPolicy.operator ?? 'state-run'}, ${sprPolicy.capacityMb ?? '?'}Mb capacity)`);
      }
    } else {
      limitations.push('strategic reserve policy: not classified for this country');
    }
  }

  const effectiveGulfShare = !comtradeCoverage ? PROXIED_GULF_SHARE : rawGulfShare;
  const gulfCrudeShare = effectiveGulfShare * exposureMult;

  const observedCrudeImportsKbd = jodiOil?.crude?.importsKbd;
  const dataAvailable = typeof observedCrudeImportsKbd === 'number'
    && Number.isFinite(observedCrudeImportsKbd) && observedCrudeImportsKbd >= 0;
  const crudeImportsKbd = dataAvailable ? observedCrudeImportsKbd : 0;

  // Keyed on dataAvailable, not jodiOilCoverage: a JODI row can exist while its
  // crude.importsKbd is unusable, and reporting "full" coverage next to
  // dataAvailable:false let the panel paint a green badge beside an
  // insufficient-data message. jodi_oil_coverage still reports row presence.
  const coverageLevel = deriveCoverageLevel(dataAvailable, comtradeCoverage, ieaStocksCoverage, degraded);
  const crudeLossKbd = crudeImportsKbd * gulfCrudeShare * (disruptionPct / 100);

  const productDefs: Array<{ name: string; demand: number }> = [
    { name: 'Gasoline', demand: n(jodiOil?.gasoline?.demandKbd) },
    { name: 'Diesel', demand: n(jodiOil?.diesel?.demandKbd) },
    { name: 'Jet fuel', demand: n(jodiOil?.jet?.demandKbd) },
    { name: 'LPG', demand: n(jodiOil?.lpg?.demandKbd) },
  ];

  const products: ProductImpact[] = productDefs
    .filter((p) => p.demand > 0)
    .map((p) => {
      const yieldFactor = REFINERY_YIELD[p.name] ?? 0.20;
      const outputLossKbd = crudeLossKbd * yieldFactor;
      const deficitPct = clamp((outputLossKbd / p.demand) * 100, 0, 100);
      return {
        product: p.name,
        outputLossKbd: Math.round(outputLossKbd * 10) / 10,
        // Round to 1 decimal to match outputLossKbd precision; raw JODI values like
        // 136.5629 kbd wasted display space with fake precision (see #2971).
        demandKbd: Math.round(p.demand * 10) / 10,
        deficitPct: Math.round(deficitPct * 10) / 10,
      };
    });

  const rawDaysOfCover = n(ieaStocks?.daysOfCover);
  const daysOfCover = ieaStocksCoverage ? rawDaysOfCover : 0;
  const netExporter = ieaStocksCoverage && ieaStocks?.netExporter === true;
  const effectiveCoverDays = computeEffectiveCoverDays(daysOfCover, netExporter, crudeLossKbd, crudeImportsKbd);

  const chokepointConfidence = deriveChokepointConfidence(liveFlowRatio, degraded);

  const assessment = buildAssessment(
    code,
    chokepointId,
    dataAvailable,
    gulfCrudeShare,
    effectiveCoverDays,
    daysOfCover,
    disruptionPct,
    products,
    coverageLevel,
    degraded,
    ieaStocksCoverage,
    comtradeCoverage,
  );

  let gasSensitivity: GasSensitivity | undefined;

  const gasDisruption = needsGas && jodiGas
    ? computeGasDisruption(jodiGas.lngImportsTj, jodiGas.totalDemandTj, chokepointId, disruptionPct)
    : undefined;

  if (needsGas) {
    limitations.push('Gas results are assumed route sensitivities, not measured country-specific supplier exposure or supply-shortage forecasts.');
    limitations.push('Gas input availability does not establish freshness or model confidence. JODI observation month and storage date apply separately.');
    limitations.push('Shipping flow ratio is context only, has no observation date in this feed, and does not scale the assumed gas route baseline.');
    limitations.push('National gas stock does not establish accessible stock, withdrawal capacity, or operational endurance; no buffer duration is estimated.');
    if (!gasDisruption) limitations.push(`Insufficient gas measurements for ${code}: finite nonnegative LNG imports and positive demand are required.`);
  }

  if (gasDisruption && jodiGas) {
    const lngImportsTj = jodiGas.lngImportsTj!;
    const totalDemandTj = jodiGas.totalDemandTj!;
    const lngShareOfImports = typeof jodiGas.lngShareOfImports === 'number'
      && Number.isFinite(jodiGas.lngShareOfImports) && jodiGas.lngShareOfImports >= 0 && jodiGas.lngShareOfImports <= 1
      ? Math.round(jodiGas.lngShareOfImports * 1000) / 1000 : undefined;
    const dataMonth = typeof jodiGas.dataMonth === 'string' ? jodiGas.dataMonth : '';
    const { lngDisruptionTj, deficitPct: gasDeficitPct } = gasDisruption;

    let storage: GasStorageObservation | undefined;
    const isEu = EU_GAS_STORAGE_COUNTRIES.has(code);

    if (isEu && gasStorageData
      && typeof gasStorageData.gasTwh === 'number' && Number.isFinite(gasStorageData.gasTwh) && gasStorageData.gasTwh >= 0
      && typeof gasStorageData.fillPct === 'number' && Number.isFinite(gasStorageData.fillPct)
      && gasStorageData.fillPct >= 0 && gasStorageData.fillPct <= 100) {
      storage = {
        fillPct: gasStorageData.fillPct,
        gasTwh: gasStorageData.gasTwh,
        trend: gasStorageData.trend ?? '',
        date: gasStorageData.date ?? '',
        scope: 'europe',
      };
    }

    gasSensitivity = {
      lngShareOfImports,
      lngImportsTj,
      lngDisruptionTj,
      totalDemandTj,
      deficitPct: gasDeficitPct,
      dataAvailable: true,
      assessment: buildGasAssessment(
        code, chokepointId, true, lngImportsTj, gasDeficitPct, disruptionPct, dataMonth,
      ),
      storage,
      dataSource: 'jodi_monthly',
      dataMonth,
      modelBasis: 'assumed_route_sensitivity',
    };
  }

  const response: ComputeEnergyShockScenarioResponse = {
    countryCode: code,
    chokepointId,
    disruptionPct,
    gulfCrudeShare: Math.round(gulfCrudeShare * 1000) / 1000,
    crudeLossKbd: Math.round(crudeLossKbd * 10) / 10,
    products,
    effectiveCoverDays,
    assessment,
    dataAvailable,
    jodiOilCoverage,
    comtradeCoverage,
    ieaStocksCoverage,
    portwatchCoverage,
    coverageLevel,
    limitations,
    degraded,
    chokepointConfidence: needsGas ? 'none' : chokepointConfidence,
    liveFlowRatio: liveFlowRatio !== null ? Math.round(liveFlowRatio * 1000) / 1000 : undefined,
    gasSensitivity,
  };

  if (!needsOil) {
    response.assessment = gasSensitivity?.assessment ?? buildGasAssessment(code, chokepointId, false, 0, 0, disruptionPct, '');
    response.dataAvailable = gasSensitivity?.dataAvailable ?? false;
    response.coverageLevel = gasSensitivity ? 'partial' : 'unsupported';
    response.limitations = response.limitations.filter(l =>
      !l.includes('refinery yield') &&
      !l.includes('Gulf crude share') &&
      !l.includes('IEA strategic stock') &&
      !l.includes('PortWatch flow data unavailable, using historical baseline multipliers')
    );
    // Zero out oil-specific fields for gas-only mode
    response.gulfCrudeShare = 0;
    response.crudeLossKbd = 0;
    response.products = [];
    response.effectiveCoverDays = 0;
    response.jodiOilCoverage = false;
    response.comtradeCoverage = false;
    response.ieaStocksCoverage = false;
  }

  if (needsOil && needsGas) {
    response.dataAvailable = dataAvailable || gasSensitivity != null;
    response.coverageLevel = response.dataAvailable ? 'partial' : 'unsupported';
  }

  const cacheTtl = degraded ? 300 : SHOCK_CACHE_TTL;
  await setCachedJson(cacheKey, response, cacheTtl);
  return response;
}
