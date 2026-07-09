/**
 * RPC: listHackernewsItems -- reads seeded HN data from Railway seed cache.
 * All external Hacker News Firebase API calls happen in seed-research.mjs on Railway.
 */

import type {
  ServerContext,
  ListHackernewsItemsRequest,
  ListHackernewsItemsResponse,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';
import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_KEY_PREFIX = 'research:hackernews:v1';
const ALLOWED_HN_FEEDS = new Set(filterParamContracts.researchHackerNewsFeedTypes);

export async function listHackernewsItems(
  ctx: ServerContext,
  req: ListHackernewsItemsRequest,
): Promise<ListHackernewsItemsResponse> {
  try {
    const feedType = ALLOWED_HN_FEEDS.has(req.feedType) ? req.feedType : 'top';
    const pageSize = clampInt(req.pageSize, 30, 1, 100);
    const seedKey = `${SEED_KEY_PREFIX}:${feedType}:30`;
    const result = await getCachedJson(seedKey, true) as ListHackernewsItemsResponse | null;
    if (!result?.items?.length) return markNoStoreFallbackResponse(ctx.request, { items: [], pagination: undefined });
    return { items: result.items.slice(0, pageSize), pagination: undefined };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { items: [], pagination: undefined });
  }
}
