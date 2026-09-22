import type {
  ServerContext,
  GetUsCpiMonthlyRequest,
  GetUsCpiMonthlyResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson, getCachedJsonBatch } from '../../../_shared/redis';
import {
  CPI_DECADE_STARTS,
  CPI_LATEST_KEY,
  type CpiSeed,
  buildUsCpiMonths,
  cpiDecadeKey,
  mergeCpiShards,
} from './us-cpi-monthly';

function asSeed(value: unknown): CpiSeed | undefined {
  if (!value || typeof value !== 'object' || !('components' in value)) return undefined;
  return value as CpiSeed;
}

export async function getUsCpiMonthly(
  _ctx: ServerContext,
  req: GetUsCpiMonthlyRequest,
): Promise<GetUsCpiMonthlyResponse> {
  try {
    if (req.history !== true) {
      const latest = asSeed(await getCachedJson(CPI_LATEST_KEY, true));
      const months = latest ? buildUsCpiMonths(latest, false) : [];
      if (months.length > 0) return { months, unavailable: false };
    }

    const keys = CPI_DECADE_STARTS.map((decade) => cpiDecadeKey(decade));
    const shards = await getCachedJsonBatch(keys, true);
    const seed = mergeCpiShards([...shards.values()].map((value) => asSeed(value)).filter((value): value is CpiSeed => value != null));
    const months = buildUsCpiMonths(seed, req.history === true);
    if (months.length === 0) return { months: [], unavailable: true };
    return { months, unavailable: false };
  } catch {
    return { months: [], unavailable: true };
  }
}
