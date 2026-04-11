import type {
  ServerContext,
  ComputeEnergyShockScenarioRequest,
  ComputeEnergyShockScenarioResponse,
  ProductImpact,
  GasImpact,
  GasStorageBuffer,
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
  computeGasBufferDays,
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
    gasImpact: undefined,
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

  const cacheKey = `energy:shock:v2:${code}:${chokepointId}:${disruptionPct}:${degraded ? 'd' : 'l'}:${fuelMode}`;
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

  const coverageLevel = deriveCoverageLevel(jodiOilCoverage, comtradeCoverage, ieaStocksCoverage, degraded);

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

  const crudeImportsKbd = n(jodiOil?.crude?.importsKbd);
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
        demandKbd: p.demand,
        deficitPct: Math.round(deficitPct * 10) / 10,
      };
    });

  const rawDaysOfCover = n(ieaStocks?.daysOfCover);
  const daysOfCover = ieaStocksCoverage ? rawDaysOfCover : 0;
  const netExporter = ieaStocksCoverage && ieaStocks?.netExporter === true;
  const effectiveCoverDays = computeEffectiveCoverDays(daysOfCover, netExporter, crudeLossKbd, crudeImportsKbd);

  const dataAvailable = jodiOilCoverage;

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

  let gasImpact: GasImpact | undefined;

  if (needsGas && jodiGas) {
    const lngImportsTj = n(jodiGas.lngImportsTj);
    const lngShareOfImports = n(jodiGas.lngShareOfImports);
    const totalDemandTj = n(jodiGas.totalDemandTj);

    const { lngDisruptionTj, deficitPct: gasDeficitPct } = computeGasDisruption(
      lngImportsTj, totalDemandTj, chokepointId, disruptionPct, liveFlowRatio,
    );

    let storage: GasStorageBuffer | undefined;
    let bufferDays = 0;
    const isEu = EU_GAS_STORAGE_COUNTRIES.has(code);

    if (isEu && gasStorageData) {
      const gasTwh = n(gasStorageData.gasTwh);
      bufferDays = computeGasBufferDays(gasTwh, lngDisruptionTj);
      storage = {
        fillPct: n(gasStorageData.fillPct),
        gasTwh,
        bufferDays,
        trend: gasStorageData.trend ?? '',
        date: gasStorageData.date ?? '',
        scope: 'europe',
      };
    }

    const gasDataAvailable = jodiGas != null;

    gasImpact = {
      lngShareOfImports: Math.round(lngShareOfImports * 1000) / 1000,
      lngImportsTj,
      lngDisruptionTj,
      totalDemandTj,
      deficitPct: gasDeficitPct,
      dataAvailable: gasDataAvailable,
      assessment: buildGasAssessment(
        code, chokepointId, gasDataAvailable, lngImportsTj, lngShareOfImports,
        gasDeficitPct, bufferDays, disruptionPct, storage != null,
      ),
      storage,
      dataSource: isEu && gasStorageData ? 'gie_daily' : 'jodi_monthly',
    };

    if (gasDataAvailable) {
      limitations.push('LNG chokepoint exposure estimates based on global trade route shares');
    }
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
    chokepointConfidence,
    liveFlowRatio: liveFlowRatio !== null ? Math.round(liveFlowRatio * 1000) / 1000 : undefined,
    gasImpact,
  };

  if (!needsOil && gasImpact) {
    response.assessment = gasImpact.assessment;
    response.dataAvailable = gasImpact.dataAvailable;
    response.coverageLevel = gasImpact.dataAvailable
      ? (degraded ? 'partial' : 'full')
      : 'unsupported';
    response.limitations = response.limitations.filter(l =>
      !l.includes('refinery yield') &&
      !l.includes('Gulf crude share') &&
      !l.includes('IEA strategic stock')
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

  if (needsOil && needsGas && gasImpact?.dataAvailable && !jodiOilCoverage) {
    response.coverageLevel = 'partial';
    response.dataAvailable = true;
  }

  const cacheTtl = degraded ? 300 : SHOCK_CACHE_TTL;
  await setCachedJson(cacheKey, response, cacheTtl);
  return response;
}
