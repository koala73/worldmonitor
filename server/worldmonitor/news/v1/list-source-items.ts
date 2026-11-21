/**
 * ListSourceItems: the newest cached items of named sources in one category.
 *
 * A digest category keeps its top items across every feed it carries, so a
 * panel whose user turned most sources off can be left with enabled sources
 * that have no item in the category (#9796). The panel asks for those sources
 * here. Each digest build caches every feed's parse (`rssFeedCacheKey`); this
 * read returns those rows and never fetches a feed or builds a digest.
 *
 * Access matches the dashboard: any session the gateway accepts, anonymous
 * ones included, since anonymous visitors turn panel sources off too. Only
 * sources the requested language's digest fetches are read, so a reply holds
 * rows that already feed a public digest, just past its category cap.
 * Browser calls carry a session and are not shared at the CDN; each is one
 * pipelined Redis read of at most 24 keys.
 */
import type {
  ListSourceItemsRequest,
  ListSourceItemsResponse,
  NewsItem,
  ServerContext,
  SourceItemsState,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { filterRevokedUrls } from '../../../_shared/digest-revocations';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { readRevokedUrlSet } from './_lastgood-store';
import { INTEL_SOURCES, SERVER_EDITIONS, VARIANT_FEEDS, isServerFeedReachableForLanguage, type ServerFeed } from './_feeds';
import { NEWS_LANGUAGES } from '../../../../src/shared/public-rpc-cache';
import { FUTURE_DATE_TOLERANCE_MS, resolveMaxAgeMs, rssFeedCacheKey } from './_rss-cache';
import { healthyRow, scoredRowItem } from './list-news-pool';

export const SOURCE_ITEMS_MAX_SOURCES = 24;
export const SOURCE_ITEMS_PER_SOURCE = 3;
const MAX_SOURCE_NAME_LENGTH = 120;

/** The feeds an edition places in a category; the intel panel is the full edition's intel sources. */
function placedFeeds(edition: string, category: string): ServerFeed[] {
  if (category === 'intel' && edition === 'full') return INTEL_SOURCES;
  return VARIANT_FEEDS[edition]?.[category] ?? [];
}

interface SourceQuery {
  editions: string[];
  category: string;
  sources: string[];
  lang: string;
}

function canonicalQuery(req: ListSourceItemsRequest): SourceQuery {
  const requested = [...new Set(req.editions.map((edition) => edition.trim().toLowerCase()).filter(Boolean))];
  if (requested.some((edition) => !SERVER_EDITIONS.includes(edition))) {
    throw new ValidationError([{ field: 'editions', description: `Use editions from: ${SERVER_EDITIONS.join(', ')}` }]);
  }
  const editions = requested.length > 0 ? requested : ['full'];
  const category = req.category.trim();
  if (!editions.some((edition) => placedFeeds(edition, category).length > 0)) {
    throw new ValidationError([{ field: 'category', description: `Not a category of ${editions.join(', ')}` }]);
  }
  const sources = [...new Set(req.sources.map((source) => source.trim()).filter(Boolean))].sort();
  if (sources.length === 0 || sources.length > SOURCE_ITEMS_MAX_SOURCES) {
    throw new ValidationError([{ field: 'sources', description: `Name 1 to ${SOURCE_ITEMS_MAX_SOURCES} sources` }]);
  }
  if (sources.some((source) => source.length > MAX_SOURCE_NAME_LENGTH)) {
    throw new ValidationError([{ field: 'sources', description: `Source names are at most ${MAX_SOURCE_NAME_LENGTH} characters` }]);
  }
  const lang = req.lang.trim().toLowerCase() || 'en';
  if (!NEWS_LANGUAGES.has(lang)) {
    throw new ValidationError([{ field: 'lang', description: 'Use a supported digest language' }]);
  }
  return { editions, category, sources, lang };
}

export async function listSourceItems(
  ctx: ServerContext,
  req: ListSourceItemsRequest,
): Promise<ListSourceItemsResponse> {
  const response = await readSources(canonicalQuery(req));
  // Only a read that found every source may be cached: a missing row must
  // clear on the next request, once the warm cycle has written it.
  if (response.sources.some((source) => source.state !== 'found')) markNoCacheResponse(ctx.request);
  return response;
}

async function readSources(query: SourceQuery): Promise<ListSourceItemsResponse> {
  const nowMs = Date.now();
  const placements = query.sources.map((source) => {
    for (const edition of query.editions) {
      const feed = placedFeeds(edition, query.category)
        .find((entry) => entry.name === source && isServerFeedReachableForLanguage(entry, query.lang));
      if (feed) return { source, edition, key: rssFeedCacheKey(edition, feed.url) };
    }
    return { source, edition: '', key: '' };
  });
  const keys = placements.flatMap((placement) => placement.key ? [placement.key] : []);
  const [revoked, rows] = await Promise.all([
    readRevokedUrlSet(),
    keys.length > 0 ? getCachedJsonBatch(keys) : Promise.resolve(new Map<string, unknown>()),
  ]);

  const oldest = nowMs - resolveMaxAgeMs();
  const newest = nowMs + FUTURE_DATE_TOLERANCE_MS;
  const items: NewsItem[] = [];
  const sources: SourceItemsState[] = placements.map(({ source, edition, key }) => {
    if (!key) return { source, state: 'unplaced', edition: '', items: 0 };
    const parsed = healthyRow(rows.get(key));
    // Fail closed: no item goes out unchecked against operator revocations.
    if (!parsed || !revoked.readable) return { source, state: 'missing', edition: '', items: 0 };
    const kept = filterRevokedUrls(parsed, revoked.urls).kept
      .filter((value) => value?.title && value.link && value.publishedAt >= oldest && value.publishedAt <= newest)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, SOURCE_ITEMS_PER_SOURCE)
      .map(scoredRowItem);
    items.push(...kept);
    return { source, state: 'found', edition, items: kept.length };
  });

  items.sort((a, b) => (Number(b.publishedAt) || 0) - (Number(a.publishedAt) || 0));
  return { items, sources, generatedAt: new Date(nowMs).toISOString() };
}
