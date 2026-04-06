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
} from './_shock-compute';

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

  const daysOfCover = n(ieaStocks?.daysOfCover);
  const netExporter = ieaStocks?.netExporter === true;
  const effectiveCoverDays = computeEffectiveCoverDays(daysOfCover, netExporter, crudeLossKbd, crudeImportsKbd);

  const dataAvailable = jodiOil != null && comtradeHasData;

  const assessment = buildAssessment(
    code,
    chokepointId,
    dataAvailable,
    gulfCrudeShare,
    effectiveCoverDays,
    daysOfCover,
    disruptionPct,
    products,
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
  };

  await setCachedJson(cacheKey, response, SHOCK_CACHE_TTL);
  return response;
}
