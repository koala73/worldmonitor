/**
 * RPC: getTariffTrends -- reads seeded WTO MFN tariff trends from Railway seed cache.
 * The seed payload may also include an optional US effective tariff snapshot.
 */
import type {
  ServerContext,
  GetTariffTrendsRequest,
  GetTariffTrendsResponse,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { isCallerPremium } from '../../../_shared/premium-check';

const SEED_KEY_PREFIX = 'trade:tariffs:v1';

function isValidCode(c: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(c);
}

export async function getTariffTrends(
  ctx: ServerContext,
  req: GetTariffTrendsRequest,
): Promise<GetTariffTrendsResponse> {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) return { datapoints: [], fetchedAt: '', upstreamUnavailable: true };

  try {
    const reporter = isValidCode(req.reportingCountry) ? req.reportingCountry : '840';
    const productSector = isValidCode(req.productSector) ? req.productSector : '';
    const years = Math.max(1, Math.min(req.years > 0 ? req.years : 10, 30));

    const seedKey = `${SEED_KEY_PREFIX}:${reporter}:${productSector || 'all'}:${years}`;
    const result = await getCachedJson(seedKey, true) as GetTariffTrendsResponse | null;
    if (!result?.datapoints?.length) {
      return { datapoints: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
    }
    return result;
  } catch {
    return { datapoints: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
