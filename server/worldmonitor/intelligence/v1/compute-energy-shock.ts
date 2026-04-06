import type {
  ServerContext,
  ComputeEnergyShockScenarioRequest,
  ComputeEnergyShockScenarioResponse,
  ProductImpact,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const SHOCK_CACHE_TTL = 3600;

// ISO2 → Comtrade numeric reporter code (only 6 seeded reporters)
const ISO2_TO_COMTRADE: Record<string, string> = {
  US: '842',
  CN: '156',
  RU: '643',
  IR: '364',
  IN: '356',
  TW: '158',
};

// Gulf partner codes (SA, AE, IQ, KW, IR) used for crude share calculation
const GULF_PARTNER_CODES = new Set(['682', '784', '368', '414', '364']);

// Chokepoint → Gulf crude exposure multiplier
const CHOKEPOINT_EXPOSURE: Record<string, number> = {
  hormuz: 1.0,
  babelm: 0.85,
  suez: 0.5,
  malacca: 0.7,
};

const VALID_CHOKEPOINTS = new Set(['hormuz', 'malacca', 'suez', 'babelm']);

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

function n(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
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

  let totalImports = 0;
  let gulfImports = 0;

  for (const flow of flows) {
    const val = typeof flow.tradeValueUsd === 'number' ? flow.tradeValueUsd : 0;
    if (val <= 0) continue;
    totalImports += val;
    if (GULF_PARTNER_CODES.has(String(flow.partnerCode))) {
      gulfImports += val;
    }
  }

  if (totalImports === 0) return { share: 0, hasData: true };
  return { share: gulfImports / totalImports, hasData: true };
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
  };

  if (!code || code.length !== 2) return EMPTY;
  if (!VALID_CHOKEPOINTS.has(chokepointId)) {
    return {
      ...EMPTY,
      assessment: `Unknown chokepoint: ${chokepointId}. Valid chokepoints: hormuz, malacca, suez, babelm.`,
    };
  }

  const cacheKey = `energy:shock:v1:${code}:${chokepointId}:${disruptionPct}`;
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

  // Apply chokepoint-specific exposure multiplier to Gulf share
  const exposureMult = CHOKEPOINT_EXPOSURE[chokepointId] ?? 1.0;
  const gulfCrudeShare = rawGulfShare * exposureMult;

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

  // Effective cover days
  const daysOfCover = n(ieaStocks?.daysOfCover);
  const netExporter = ieaStocks?.netExporter === true;
  let effectiveCoverDays: number;
  if (netExporter) {
    effectiveCoverDays = -1;
  } else if (daysOfCover > 0 && crudeLossKbd > 0 && crudeImportsKbd > 0) {
    effectiveCoverDays = Math.round(daysOfCover / (crudeLossKbd / crudeImportsKbd));
  } else {
    effectiveCoverDays = daysOfCover;
  }

  const dataAvailable = jodiOil != null && comtradeHasData;

  // Deterministic assessment string
  let assessment: string;
  if (!dataAvailable) {
    assessment = `Insufficient import data for ${code} to model ${chokepointId} exposure.`;
  } else if (gulfCrudeShare < 0.1) {
    assessment = `${code} has low Gulf crude dependence (${Math.round(gulfCrudeShare * 100)}%); ${chokepointId} disruption has limited direct impact.`;
  } else if (effectiveCoverDays > 90) {
    assessment = `With ${daysOfCover} days IEA cover, ${code} can bridge a ${disruptionPct}% ${chokepointId} disruption for ~${effectiveCoverDays} days.`;
  } else {
    const dieselDeficit = products.find((p) => p.product === 'Diesel')?.deficitPct ?? 0;
    const jetDeficit = products.find((p) => p.product === 'Jet fuel')?.deficitPct ?? 0;
    const worstDeficit = Math.max(dieselDeficit, jetDeficit);
    assessment = `${code} faces ${worstDeficit.toFixed(1)}% diesel/jet deficit under ${disruptionPct}% ${chokepointId} disruption; IEA cover: ${daysOfCover} days.`;
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
  };

  await setCachedJson(cacheKey, response, SHOCK_CACHE_TTL);
  return response;
}
