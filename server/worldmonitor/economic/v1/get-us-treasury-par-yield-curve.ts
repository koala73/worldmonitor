import type {
  ServerContext,
  GetUsTreasuryParYieldCurveRequest,
  GetUsTreasuryParYieldCurveResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson, getCachedJsonBatch } from '../../../_shared/redis';
import {
  TREASURY_LATEST_KEY,
  treasuryCurvesFromSeed,
  treasuryCurvesFromShards,
  treasuryYearKey,
  treasuryYears,
} from './us-treasury-par-yield';

async function readHistory(): Promise<GetUsTreasuryParYieldCurveResponse['curves']> {
  const keys = treasuryYears().map((year) => treasuryYearKey(year));
  const shards = await getCachedJsonBatch(keys, true);
  return treasuryCurvesFromShards([...shards.values()]);
}

export async function getUsTreasuryParYieldCurve(
  _ctx: ServerContext,
  req: GetUsTreasuryParYieldCurveRequest,
): Promise<GetUsTreasuryParYieldCurveResponse> {
  try {
    if (req.history !== true) {
      const latest = treasuryCurvesFromSeed(await getCachedJson(TREASURY_LATEST_KEY, true));
      if (latest.length > 0) return { curves: latest.slice(-1), unavailable: false };
    }

    const curves = await readHistory();
    if (curves.length === 0) return { curves: [], unavailable: true };
    return {
      curves: req.history === true ? curves : curves.slice(-1),
      unavailable: false,
    };
  } catch {
    return { curves: [], unavailable: true };
  }
}
