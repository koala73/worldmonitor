import type {
  ServerContext,
  GetCustomsRevenueRequest,
  GetCustomsRevenueResponse,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const CUSTOMS_KEY = 'trade:customs-revenue:v1';

export async function getCustomsRevenue(
  _ctx: ServerContext,
  _req: GetCustomsRevenueRequest,
): Promise<GetCustomsRevenueResponse> {
  try {
    const data = (await getCachedJson(CUSTOMS_KEY, true)) as GetCustomsRevenueResponse | null;
    if (data?.months?.length) return data;
    return { months: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch (err: unknown) {
    console.warn('[CustomsRevenue] Redis read error:', err instanceof Error ? err.message : err);
    return { months: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
