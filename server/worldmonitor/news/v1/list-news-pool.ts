/**
 * ListNewsPool: cached news for several editions and content languages,
 * merged into one list with one item per article URL. It never fetches a
 * feed, so a widened read costs cache reads only.
 *
 * English comes from the `news:digest:v1:<edition>:<lang>` cells the relay's
 * warm cycle keeps fresh. A cell with no fresh body falls back to its
 * last-good snapshot inside the same six-hour window the digest serves.
 *
 * Every other language comes from its feeds' own cached parses
 * (`rssFeedCacheKey`), which the same digest builds write. A digest category
 * keeps only its newest items, and the English feeds with no `lang` ride
 * along in every language cell, so a French cell holds a few French items at
 * most; the feed rows hold every recent one.
 *
 * Each entry in `cells` is one (edition, language) read. Anything the cache
 * could not supply is reported missing or partial rather than quietly short.
 * Each item's language is its outlet's content language, not the cell's.
 * Titles are publisher text, untranslated.
 */
import type {
  ListFeedDigestResponse,
  ListNewsPoolRequest,
  ListNewsPoolResponse,
  NewsItem,
  NewsPoolCell,
  NewsPoolItem,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { getCachedJsonBatch, readCachedJson } from '../../../_shared/redis';
import { getOutletProfile } from '../../../_shared/outlet-profile';
import { filterRevokedUrls } from '../../../_shared/digest-revocations';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { NEWS_POOL_LAYOUT } from '../../../../shared/news-pool-layout.generated';
import { classifyStaleSnapshot, isAcceptableDigest } from './_lastgood';
import { readAcceptedSnapshot, readRevokedUrlSet } from './_lastgood-store';
import { INTEL_SOURCES, VARIANT_FEEDS } from './_feeds';
import { FUTURE_DATE_TOLERANCE_MS, resolveMaxAgeMs, rssFeedCacheKey } from './_rss-cache';
import {
  computeImportanceScore,
  computeItemCredibilityScore,
  suppressRevoked,
  toProtoItem,
  type ParsedItem,
} from './list-feed-digest';

export const NEWS_POOL_MAX_LANGUAGES = 8;

/** Feed language by source name: the language a feed is fetched for (none = English). */
const FEED_LANGUAGE: ReadonlyMap<string, string> = new Map(
  [...Object.values(VARIANT_FEEDS).flatMap((byCategory) => Object.values(byCategory).flat()), ...INTEL_SOURCES]
    .map((feed) => [feed.name, feed.lang ?? 'en'] as const),
);

/** Content language of a source: its reviewed outlet profile, else its feed's. */
export function sourceLanguage(source: string): string {
  return getOutletProfile(source)?.language ?? FEED_LANGUAGE.get(source) ?? 'en';
}

interface PoolQuery {
  languages: string[];
  editions: string[];
  category: string;
}

function canonicalQuery(req: ListNewsPoolRequest): PoolQuery {
  const languages = [...new Set(req.languages.map((lang) => lang.trim().toLowerCase()).filter(Boolean))];
  if (languages.length > NEWS_POOL_MAX_LANGUAGES || languages.some((lang) => !NEWS_POOL_LAYOUT.languages.includes(lang))) {
    throw new ValidationError([{
      field: 'languages',
      description: `Use at most ${NEWS_POOL_MAX_LANGUAGES} of: ${NEWS_POOL_LAYOUT.languages.join(', ')}`,
    }]);
  }
  const editionOrder = Object.keys(NEWS_POOL_LAYOUT.editions);
  const requested = new Set(req.editions.map((edition) => edition.trim().toLowerCase()).filter(Boolean));
  if ([...requested].some((edition) => !editionOrder.includes(edition))) {
    throw new ValidationError([{ field: 'editions', description: `Use editions from: ${editionOrder.join(', ')}` }]);
  }
  const editions = requested.size > 0 ? editionOrder.filter((edition) => requested.has(edition)) : ['full'];
  const category = req.category.trim();
  if (category && !editions.some((edition) => NEWS_POOL_LAYOUT.editions[edition]!.includes(category))) {
    throw new ValidationError([{ field: 'category', description: `Not a category of ${editions.join(', ')}` }]);
  }
  return { languages: languages.length > 0 ? languages.sort() : ['en'], editions, category };
}

type CellRead =
  | { state: 'complete' | 'partial' | 'stale'; data: ListFeedDigestResponse; staleAgeSeconds: number }
  | { state: 'missing' };

async function readCell(edition: string, lang: string, nowMs: number): Promise<CellRead> {
  const fresh = await readCachedJson(`news:digest:v1:${edition}:${lang}`);
  if (fresh.status === 'hit' && isAcceptableDigest(fresh.value as ListFeedDigestResponse)) {
    const data = fresh.value as ListFeedDigestResponse;
    return { state: data.coverage?.state === 'partial' ? 'partial' : 'complete', data, staleAgeSeconds: 0 };
  }
  const stored = await readAcceptedSnapshot<ListFeedDigestResponse>(edition, lang);
  const verdict = classifyStaleSnapshot(stored.snapshot, nowMs);
  if (!verdict.serve || !stored.snapshot) return { state: 'missing' };
  return { state: 'stale', data: stored.snapshot.data, staleAgeSeconds: verdict.ageSeconds };
}

interface FeedRead {
  edition: string;
  language: string;
  category: string;
  name: string;
  key: string;
}

/** The non-English feeds the requested editions place, one row read per (edition, feed). */
function feedReads(query: PoolQuery): FeedRead[] {
  const wanted = new Set(query.languages.filter((lang) => lang !== 'en'));
  if (wanted.size === 0) return [];
  const reads: FeedRead[] = [];
  for (const edition of query.editions) {
    const placed: Array<[string, { name: string; url: string }]> = Object.entries(VARIANT_FEEDS[edition] ?? {})
      .flatMap(([category, feeds]) => feeds.map((feed) => [category, feed] as [string, { name: string; url: string }]));
    if (edition === 'full') placed.push(...INTEL_SOURCES.map((feed) => ['intel', feed] as [string, { name: string; url: string }]));
    const seen = new Set<string>();
    for (const [category, feed] of placed) {
      if (query.category && category !== query.category) continue;
      const language = sourceLanguage(feed.name);
      if (!wanted.has(language) || seen.has(feed.url)) continue;
      seen.add(feed.url);
      reads.push({ edition, language, category, name: feed.name, key: rssFeedCacheKey(edition, feed.url) });
    }
  }
  return reads;
}

/** A cached parse; a fetch that failed is cached as `items: []` with `attempt.failure` set. */
function healthyRow(value: unknown): ParsedItem[] | null {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return null;
  const attempt = 'attempt' in value ? value.attempt : null;
  if (attempt && typeof attempt === 'object' && 'failure' in attempt && attempt.failure) return null;
  return value.items as ParsedItem[];
}

/**
 * A feed row stores zero scores; the digest fills them in after merging every
 * feed. Score the item the same way, counting only the corroboration the row
 * itself recorded, since this read never sees the other feeds.
 */
function scoredRowItem(value: ParsedItem): NewsItem {
  const corroboration = Math.max(value.corroborationCount ?? 1, value.entityCorroborationCount ?? 0);
  return toProtoItem({
    ...value,
    importanceScore: computeImportanceScore(value.level, value.source, corroboration, value.publishedAt, {
      title: value.title,
      classSource: value.classSource,
      entityCorroborationCount: value.entityCorroborationCount,
    }),
    credibilityScore: computeItemCredibilityScore(value, corroboration),
  });
}

function unavailable(at: string, cells: NewsPoolCell[]): ListNewsPoolResponse {
  return { items: [], cells, state: 'unavailable', generatedAt: at };
}

export async function listNewsPool(
  ctx: ServerContext,
  req: ListNewsPoolRequest,
): Promise<ListNewsPoolResponse> {
  const response = await readPool(canonicalQuery(req));
  // Only a complete read may be cached: an outage or a gap must clear on the
  // next request, and a stale replay must not outlive its serving window.
  if (response.state !== 'complete') markNoCacheResponse(ctx.request);
  return response;
}

async function readPool(query: PoolQuery): Promise<ListNewsPoolResponse> {
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const digestCells = query.languages.includes('en')
    ? NEWS_POOL_LAYOUT.cells.filter((cell) => query.editions.includes(cell.edition) && cell.contentLanguages.includes('en'))
    : [];
  const rows = feedReads(query);
  const [revoked, reads, cachedRows] = await Promise.all([
    readRevokedUrlSet(),
    Promise.all(digestCells.map((cell) => readCell(cell.edition, cell.lang, nowMs))),
    rows.length > 0 ? getCachedJsonBatch(rows.map((row) => row.key)) : Promise.resolve(new Map<string, unknown>()),
  ]);

  // One cell per (edition, language) the feed rows cover, in request order.
  const rowCells = new Map<string, { cell: NewsPoolCell; feeds: number; cached: number }>();
  for (const row of rows) {
    const id = `${row.edition}:${row.language}`;
    if (!rowCells.has(id)) {
      rowCells.set(id, {
        cell: { edition: row.edition, language: row.language, state: 'missing', items: 0, staleAgeSeconds: 0, generatedAt: '' },
        feeds: 0,
        cached: 0,
      });
    }
    rowCells.get(id)!.feeds += 1;
  }
  const missingDigestCells = digestCells.map((cell) => ({
    edition: cell.edition, language: cell.lang, state: 'missing', items: 0, staleAgeSeconds: 0, generatedAt: '',
  }));
  // Fail closed: no item goes out unchecked against operator revocations.
  if (!revoked.readable) return unavailable(at, [...missingDigestCells, ...[...rowCells.values()].map(({ cell }) => cell)]);

  const editionOrder = Object.keys(NEWS_POOL_LAYOUT.editions);
  const byKey = new Map<string, { entry: NewsPoolItem; home: boolean }>();
  const add = (item: NewsItem, language: string, edition: string, category: string, home: boolean) => {
    const key = item.link || `${item.source}|${item.title}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { entry: { item, language, editions: [edition], category }, home });
      return;
    }
    if (!seen.entry.editions.includes(edition)) seen.entry.editions.push(edition);
    // Prefer the copy from the cell the feed is fetched for: a feed with
    // no `lang` rides along in every language cell, but its own (English)
    // cell is the one the dashboard shows.
    if (home && !seen.home) {
      seen.entry.item = item;
      seen.entry.category = category;
      seen.home = true;
    }
  };

  const cells: NewsPoolCell[] = digestCells.map((cell, index) => {
    const read = reads[index]!;
    if (read.state === 'missing') return missingDigestCells[index]!;
    const { data } = suppressRevoked(read.data, revoked.urls);
    let contributed = 0;
    for (const [category, bucket] of Object.entries(data.categories ?? {})) {
      if (query.category && category !== query.category) continue;
      for (const item of (bucket?.items ?? []) as NewsItem[]) {
        if (!item?.title || !item.source) continue;
        const language = sourceLanguage(item.source);
        if (language !== 'en') continue;
        contributed += 1;
        add(item, language, cell.edition, category, (FEED_LANGUAGE.get(item.source) ?? 'en') === cell.lang);
      }
    }
    return {
      edition: cell.edition,
      language: cell.lang,
      state: read.state,
      items: contributed,
      staleAgeSeconds: read.staleAgeSeconds,
      generatedAt: data.generatedAt ?? '',
    };
  });

  const oldest = nowMs - resolveMaxAgeMs();
  const newest = nowMs + FUTURE_DATE_TOLERANCE_MS;
  for (const row of rows) {
    const parsed = healthyRow(cachedRows.get(row.key));
    if (!parsed) continue;
    const tally = rowCells.get(`${row.edition}:${row.language}`)!;
    tally.cached += 1;
    for (const value of filterRevokedUrls(parsed, revoked.urls).kept) {
      if (!value?.title || !value.link) continue;
      if (!(value.publishedAt >= oldest && value.publishedAt <= newest)) continue;
      const item = scoredRowItem(value);
      const language = sourceLanguage(item.source || row.name);
      if (language !== row.language) continue;
      tally.cell.items += 1;
      add(item, language, row.edition, row.category, true);
    }
  }
  for (const { cell, feeds, cached } of rowCells.values()) {
    cell.state = cached === 0 ? 'missing' : cached < feeds ? 'partial' : 'complete';
    cells.push(cell);
  }

  const items = [...byKey.values()].map(({ entry }) => {
    entry.editions.sort((a, b) => editionOrder.indexOf(a) - editionOrder.indexOf(b));
    return entry;
  }).sort((a, b) => (Number(b.item?.publishedAt) || 0) - (Number(a.item?.publishedAt) || 0));

  const served = cells.filter((cell) => cell.state !== 'missing');
  if (cells.length > 0 && served.length === 0) return unavailable(at, cells);
  const state = cells.some((cell) => cell.state === 'missing' || cell.state === 'partial')
    ? 'partial'
    : cells.some((cell) => cell.state === 'stale') ? 'stale' : 'complete';
  return { items, cells, state, generatedAt: at };
}
