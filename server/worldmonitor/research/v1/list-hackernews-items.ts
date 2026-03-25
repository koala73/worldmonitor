/**
 * RPC: listHackernewsItems -- reads seeded HN data from Railway seed cache.
 * All external Hacker News Firebase API calls happen in seed-research.mjs on Railway.
 */

import type {
  ServerContext,
  ListHackernewsItemsRequest,
  ListHackernewsItemsResponse,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY_PREFIX = 'research:hackernews:v1';
const ALLOWED_HN_FEEDS = new Set(['top', 'new', 'best', 'ask', 'show', 'job']);

export async function listHackernewsItems(
  _ctx: ServerContext,
  req: ListHackernewsItemsRequest,
): Promise<ListHackernewsItemsResponse> {
  try {
    const feedType = ALLOWED_HN_FEEDS.has(req.feedType) ? req.feedType : 'top';
    const pageSize = clampInt(req.pageSize, 30, 1, 100);
    const seedKey = `${SEED_KEY_PREFIX}:${feedType}:30`;
    const result = await getCachedJson(seedKey, true) as ListHackernewsItemsResponse | null;
    if (!result?.items?.length) return { items: [], pagination: undefined };
    return { items: result.items.slice(0, pageSize), pagination: undefined };
  } catch {
    return { items: [], pagination: undefined };
  }
}
