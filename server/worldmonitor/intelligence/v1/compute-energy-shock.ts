import type {
  ServerContext,
  ComputeEnergyShockScenarioRequest,
  ComputeEnergyShockScenarioResponse,
  ProductImpact,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import {
  clamp,
  CHOKEPOINT_EXPOSURE,
  VALID_CHOKEPOINTS,
  computeGulfShare,
  computeEffectiveCoverDays,
  buildAssessment,
  deriveCoverageLevel,
  deriveChokepointConfidence,
} from './_shock-compute';
import { ISO2_TO_COMTRADE } from './_comtrade-reporters';

const SHOCK_CACHE_TTL = 300;

const CP_TO_PORTWATCH: Record<string, string> = {
  hormuz: 'hormuz_strait',
  babelm: 'bab_el_mandeb',
  suez: 'suez',
  malacca: 'malacca_strait',
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
  };

  if (!code || code.length !== 2) return EMPTY;
  if (!VALID_CHOKEPOINTS.has(chokepointId)) {
    return {
      ...EMPTY,
      assessment: `Unknown chokepoint: ${chokepointId}. Valid chokepoints: hormuz, malacca, suez, babelm.`,
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

  const cacheKey = `energy:shock:v2:${code}:${chokepointId}:${disruptionPct}:${degraded ? 'd' : 'l'}`;
  const cached = await getCachedJson(cacheKey);
  if (cached) return cached as ComputeEnergyShockScenarioResponse;

  const [jodiOilResult, ieaStocksResult, gulfShareResult] = await Promise.allSettled([
    getCachedJson(`energy:jodi-oil:v1:${code}`, true),
    getCachedJson(`energy:iea-oil-stocks:v1:${code}`, true),
    getGulfCrudeShare(code),
  ]);

  const jodiOil = jodiOilResult.status === 'fulfilled' ? (jodiOilResult.value as JodiOil | null) : null;
  const ieaStocks = ieaStocksResult.status === 'fulfilled' ? (ieaStocksResult.value as IeaStocks | null) : null;
  const { share: rawGulfShare, hasData: comtradeHasData } = gulfShareResult.status === 'fulfilled'
    ? gulfShareResult.value
    : { share: 0, hasData: false };

  const exposureMult = liveFlowRatio !== null ? liveFlowRatio : (CHOKEPOINT_EXPOSURE[chokepointId] ?? 1.0);

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
  limitations.push('refinery yield: 80% crude-to-product heuristic');
  if (degraded) {
    limitations.push('PortWatch flow data unavailable, using historical baseline multipliers');
  }

  const effectiveGulfShare = !comtradeCoverage ? PROXIED_GULF_SHARE : rawGulfShare;
  const gulfCrudeShare = effectiveGulfShare * exposureMult;

  const crudeImportsKbd = n(jodiOil?.crude?.importsKbd);
  const crudeLossKbd = crudeImportsKbd * gulfCrudeShare * (disruptionPct / 100);

  const ratio = crudeImportsKbd > 0 ? crudeLossKbd / crudeImportsKbd : 0;

  const productDefs: Array<{ name: string; demand: number }> = [
    { name: 'Gasoline', demand: n(jodiOil?.gasoline?.demandKbd) },
    { name: 'Diesel', demand: n(jodiOil?.diesel?.demandKbd) },
    { name: 'Jet fuel', demand: n(jodiOil?.jet?.demandKbd) },
    { name: 'LPG', demand: n(jodiOil?.lpg?.demandKbd) },
  ];

  const products: ProductImpact[] = productDefs
    .filter((p) => p.demand > 0)
    .map((p) => {
      const outputLossKbd = p.demand * ratio * 0.8;
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
  };

  const cacheTtl = degraded ? 300 : SHOCK_CACHE_TTL;
  await setCachedJson(cacheKey, response, cacheTtl);
  return response;
}
