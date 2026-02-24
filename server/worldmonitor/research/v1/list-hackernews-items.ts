/**
 * RPC: listHackernewsItems
 *
 * Fetches Hacker News stories via the Firebase JSON API with a 2-step fetch
 * (IDs then items) and bounded concurrency. Returns empty array on any failure.
 */

import type {
  ServerContext,
  ListHackernewsItemsRequest,
  ListHackernewsItemsResponse,
  HackernewsItem,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'research:hackernews:v1';
const REDIS_CACHE_TTL = 600; // 10 min

// ---------- Constants ----------

const ALLOWED_HN_FEEDS = new Set(['top', 'new', 'best', 'ask', 'show', 'job']);
const HN_MAX_CONCURRENCY = 10;

// ---------- Fetch ----------

async function fetchHackernewsItems(req: ListHackernewsItemsRequest): Promise<HackernewsItem[]> {
  const feedType = ALLOWED_HN_FEEDS.has(req.feedType) ? req.feedType : 'top';
  const pageSize = req.pagination?.pageSize || 30;

  // Step 1: Fetch story IDs
  const idsUrl = `https://hacker-news.firebaseio.com/v0/${feedType}stories.json`;
  const idsResponse = await fetch(idsUrl, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10000),
  });

  if (!idsResponse.ok) return [];

  const allIds: unknown = await idsResponse.json();
  if (!Array.isArray(allIds)) return [];

  // Step 2: Batch-fetch individual items with bounded concurrency
  const ids = allIds.slice(0, pageSize) as number[];
  const items: HackernewsItem[] = [];

  for (let i = 0; i < ids.length; i += HN_MAX_CONCURRENCY) {
    const batch = ids.slice(i, i + HN_MAX_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id): Promise<HackernewsItem | null> => {
        try {
          const res = await fetch(
            `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
            { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(5000) },
          );
          if (!res.ok) return null;
          const raw: any = await res.json();
          if (!raw || raw.type !== 'story') return null;
          return {
            id: raw.id || 0,
            title: raw.title || '',
            url: raw.url || '',
            score: raw.score || 0,
            commentCount: raw.descendants || 0,
            by: raw.by || '',
            submittedAt: (raw.time || 0) * 1000, // HN uses Unix seconds, proto uses ms
          };
        } catch {
          return null;
        }
      }),
    );
    for (const item of results) {
      if (item) items.push(item);
    }
  }

  return items;
}

// ---------- Handler ----------

export async function listHackernewsItems(
  _ctx: ServerContext,
  req: ListHackernewsItemsRequest,
): Promise<ListHackernewsItemsResponse> {
  try {
    const feedType = ALLOWED_HN_FEEDS.has(req.feedType) ? req.feedType : 'top';
    const cacheKey = `${REDIS_CACHE_KEY}:${feedType}:${req.pagination?.pageSize || 30}`;
    const cached = (await getCachedJson(cacheKey)) as ListHackernewsItemsResponse | null;
    if (cached?.items?.length) return cached;

    const items = await fetchHackernewsItems(req);
    const result: ListHackernewsItemsResponse = { items, pagination: undefined };
    if (items.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { items: [], pagination: undefined };
  }
}
