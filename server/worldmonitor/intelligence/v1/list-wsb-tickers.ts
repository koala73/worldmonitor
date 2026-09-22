import type { IntelligenceServiceHandler, ListWsbTickersResponse } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

export const listWsbTickers: IntelligenceServiceHandler['listWsbTickers'] = async () => {
  const data = await getCachedJson('intelligence:wsb-tickers:v1', true) as ListWsbTickersResponse | null;
  return { tickers: Array.isArray(data?.tickers) ? data.tickers.slice(0, 50).map(({ symbol, mentionCount, totalScore, subreddits, velocityScore }) => ({ symbol, mentionCount, totalScore, subreddits, velocityScore })) : [] };
};
