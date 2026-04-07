import type {
  ClimateServiceHandler,
  ServerContext,
  GetOceanIceDataRequest,
  GetOceanIceDataResponse,
  OceanIceData,
  IceTrendPoint,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { CLIMATE_OCEAN_ICE_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  return value != null && typeof value === 'object' ? (value as LooseRecord) : null;
}

function pickKey(record: LooseRecord, snakeKey: string, camelKey: string): unknown {
  if (record[snakeKey] != null) return record[snakeKey];
  return record[camelKey];
}

function asFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeTrendPoints(value: unknown): IceTrendPoint[] {
  if (!Array.isArray(value)) return [];
  const points: IceTrendPoint[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const month = asString(record.month);
    const extentMkm2 = asFiniteNumber(pickKey(record, 'extent_mkm2', 'extentMkm2'));
    const anomalyMkm2 = asFiniteNumber(pickKey(record, 'anomaly_mkm2', 'anomalyMkm2'));
    if (!month || extentMkm2 == null || anomalyMkm2 == null) continue;
    points.push({ month, extentMkm2, anomalyMkm2 });
  }
  return points;
}

function normalizeOceanIceSeed(value: unknown): GetOceanIceDataResponse {
  const root = asRecord(value);
  if (!root) return {};

  const seeded = asRecord(root.data) ?? root;
  const normalized: Partial<OceanIceData> = {
    iceTrend12m: normalizeTrendPoints(pickKey(seeded, 'ice_trend_12m', 'iceTrend12m')),
  };

  const arcticExtentMkm2 = asFiniteNumber(pickKey(seeded, 'arctic_extent_mkm2', 'arcticExtentMkm2'));
  if (arcticExtentMkm2 != null) normalized.arcticExtentMkm2 = arcticExtentMkm2;

  const arcticExtentAnomalyMkm2 = asFiniteNumber(pickKey(seeded, 'arctic_extent_anomaly_mkm2', 'arcticExtentAnomalyMkm2'));
  if (arcticExtentAnomalyMkm2 != null) normalized.arcticExtentAnomalyMkm2 = arcticExtentAnomalyMkm2;

  const arcticTrend = asString(pickKey(seeded, 'arctic_trend', 'arcticTrend'));
  if (arcticTrend) normalized.arcticTrend = arcticTrend;

  const seaLevelMmAbove1993 = asFiniteNumber(pickKey(seeded, 'sea_level_mm_above_1993', 'seaLevelMmAbove1993'));
  if (seaLevelMmAbove1993 != null) normalized.seaLevelMmAbove1993 = seaLevelMmAbove1993;

  const seaLevelAnnualRiseMm = asFiniteNumber(pickKey(seeded, 'sea_level_annual_rise_mm', 'seaLevelAnnualRiseMm'));
  if (seaLevelAnnualRiseMm != null) normalized.seaLevelAnnualRiseMm = seaLevelAnnualRiseMm;

  const ohc0700mZj = asFiniteNumber(pickKey(seeded, 'ohc_0_700m_zj', 'ohc0700mZj'));
  if (ohc0700mZj != null) normalized.ohc0700mZj = ohc0700mZj;

  const sstAnomalyC = asFiniteNumber(pickKey(seeded, 'sst_anomaly_c', 'sstAnomalyC'));
  if (sstAnomalyC != null) normalized.sstAnomalyC = sstAnomalyC;

  const measuredAt = asFiniteNumber(pickKey(seeded, 'measured_at', 'measuredAt'));
  if (measuredAt != null) normalized.measuredAt = Math.round(measuredAt);

  const normalizedKeys = Object.keys(normalized);
  const onlyEmptyTrend = normalizedKeys.length === 1
    && Array.isArray(normalized.iceTrend12m)
    && normalized.iceTrend12m.length === 0;
  if (normalizedKeys.length === 0 || onlyEmptyTrend) {
    return {};
  }

  return { data: normalized as OceanIceData };
}

export const getOceanIceData: ClimateServiceHandler['getOceanIceData'] = async (
  _ctx: ServerContext,
  _req: GetOceanIceDataRequest,
): Promise<GetOceanIceDataResponse> => {
  try {
    const cached = await getCachedJson(CLIMATE_OCEAN_ICE_KEY, true);
    return normalizeOceanIceSeed(cached);
  } catch {
    return {};
  }
};
