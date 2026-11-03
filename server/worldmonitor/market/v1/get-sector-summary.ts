/**
 * RPC: GetSectorSummary -- reads seeded sector data from Railway seed cache.
 * All external Finnhub/Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  GetSectorSummaryRequest,
  GetSectorSummaryResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { readRequiredSeed } from '../../../_shared/required-seed';

const SEED_CACHE_KEY = 'market:sectors:v2';

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  const result = await readRequiredSeed(SEED_CACHE_KEY, value => {
    const data = value as GetSectorSummaryResponse | null;
    return data && Array.isArray(data.sectors) ? data : undefined;
  });
  return result;
}
