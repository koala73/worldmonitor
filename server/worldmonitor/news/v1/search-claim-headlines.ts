import type {
  ClaimHeadline,
  SearchClaimHeadlinesRequest,
  SearchClaimHeadlinesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import type { NewsItemCore } from '../../../../shared/news-clustering-core.js';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { CLAIM_MAX_CHARS, claimCandidates } from '../../../_shared/claim-match';
import { INTEL_SOURCES, isServerFeedReachableForLanguage, VARIANT_FEEDS } from './_feeds';
import { FUTURE_DATE_TOLERANCE_MS, resolveMaxAgeMs, rssFeedCacheKey } from './_rss-cache';

/**
 * #9092 follow-up: /verify and verify_claim searched only the served digest,
 * which keeps five items per feed and twenty per category (about 280
 * headlines). This searches every fresh headline the full-variant RSS caches
 * hold, including the entries kept past the dashboard cap, and returns the
 * ones worth clustering for the claim. The card is still built by
 * buildClaimCard, in the browser and in the MCP tool alike.
 */

/** Headlines read from the feed caches, shared by every claim this isolate serves for a short while. */
type ClaimPool = {
  readonly items: NewsItemCore[];
  /** Feeds that contributed at least one fresh headline. */
  readonly feedsSearched: number;
  readonly feedTotal: number;
  readonly feedCached: number;
  readonly readable: boolean;
  readonly readAt: number;
};

const POOL_TTL_MS = 120_000;
let pool: { at: number; promise: Promise<ClaimPool> } | null = null;

/**
 * A Google News search without `site:` (AI News, Africa News, Oil & Gas)
 * carries many publishers under one feed label. Its rows are credited to the
 * trusted origin publisher, so two outlets in one such feed still count as
 * two. A `site:` feed is one publisher by construction and keeps its label,
 * which is what source tiers are keyed on (AP News, not "The Associated Press").
 */
function isMultiPublisherFeed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'news.google.com' && !/\bsite:/i.test(parsed.searchParams.get('q') ?? '');
  } catch {
    return false;
  }
}

function poolSource(row: Record<string, unknown>, feedName: string, multiPublisher: boolean): string {
  if (!multiPublisher || row.originPublisherTrusted !== true || typeof row.originPublisher !== 'string') return feedName;
  const origin = row.originPublisher.replace(/\s+/g, ' ').trim();
  return origin && origin.length <= 200 ? origin : feedName;
}

function poolItem(
  value: unknown,
  feedName: string,
  multiPublisher: boolean,
  now: number,
  cutoff: number,
  revoked: ReadonlySet<string>,
): NewsItemCore | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.source !== feedName || typeof row.title !== 'string') return null;
  const source = poolSource(row, feedName, multiPublisher);
  const title = row.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length > 1000) return null;
  if (typeof row.publishedAt !== 'number' || !Number.isFinite(row.publishedAt)
    || row.publishedAt < cutoff || row.publishedAt > now + FUTURE_DATE_TOLERANCE_MS) return null;
  // Links were gated at ingest (#8398); a blanked or non-http one stays empty.
  const link = typeof row.link === 'string' && /^https?:\/\//i.test(row.link) && row.link.length <= 2048 ? row.link : '';
  if (link && revoked.has(link)) return null;
  return { source, title, link, pubDate: new Date(row.publishedAt), isAlert: false };
}

function cachedRows(entry: unknown): unknown[] | null {
  if (!entry || typeof entry !== 'object' || !('items' in entry) || !Array.isArray(entry.items)) return null;
  return 'countryItems' in entry && Array.isArray(entry.countryItems) ? [...entry.items, ...entry.countryItems] : entry.items;
}

/**
 * A depth feed is a Google News site: search, whose titles end in
 * " - <publisher>". Dropping it lets a story the native feed also carries be
 * recognised as the same headline.
 */
function depthTitle(row: unknown, title: string): string {
  const origin = row && typeof row === 'object' && (row as Record<string, unknown>).originPublisherTrusted === true
    ? (row as Record<string, unknown>).originPublisher : '';
  const suffix = typeof origin === 'string' && origin ? ` - ${origin.trim()}` : '';
  return suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

async function readPool(): Promise<ClaimPool> {
  const feeds = [...Object.values(VARIANT_FEEDS.full ?? {}).flat(), ...INTEL_SOURCES]
    .filter(feed => isServerFeedReachableForLanguage(feed, 'en'));
  const unique = [...new Map(feeds.map(feed => [rssFeedCacheKey('full', feed.url), feed])).entries()];
  const depthKeys = unique.flatMap(([, feed]) => feed.depthUrl ? [rssFeedCacheKey('full', feed.depthUrl)] : []);
  const now = Date.now();
  const [cached, revoked] = await Promise.all([
    getCachedJsonBatch([...unique.map(([key]) => key), ...depthKeys]),
    readRevokedUrlSet(),
  ]);
  if (!revoked.readable) return { items: [], feedsSearched: 0, feedTotal: unique.length, feedCached: 0, readable: false, readAt: now };
  const cutoff = now - resolveMaxAgeMs();
  const items: NewsItemCore[] = [];
  const seen = new Set<string>();
  let feedCached = 0;
  let feedsSearched = 0;
  for (const [key, feed] of unique) {
    const rows = cachedRows(cached.get(key));
    if (rows) feedCached++;
    // Coverage totals count catalog feeds only; a depth feed adds headlines.
    const depthRows = feed.depthUrl ? cachedRows(cached.get(rssFeedCacheKey('full', feed.depthUrl))) : null;
    const multiPublisher = isMultiPublisherFeed(feed.url);
    const before = items.length;
    const titles = new Set<string>();
    for (const value of rows ?? []) {
      // Every native title, kept or not, so a revoked or stale native story
      // cannot come back through its depth copy's different link.
      const row = value as Record<string, unknown> | null;
      if (feed.depthUrl && row && row.source === feed.name && typeof row.title === 'string') {
        titles.add(row.title.replace(/\s+/g, ' ').trim().toLowerCase());
      }
      const item = poolItem(value, feed.name, multiPublisher, now, cutoff, revoked.urls);
      if (!item) continue;
      const dedupe = item.link || `${item.source}|${item.title}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      items.push(item);
    }
    for (const value of depthRows ?? []) {
      const item = poolItem(value, feed.name, false, now, cutoff, revoked.urls);
      if (!item) continue;
      const title = depthTitle(value, item.title);
      if (titles.has(title.toLowerCase())) continue;
      const dedupe = item.link || `${item.source}|${title}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      titles.add(title.toLowerCase());
      items.push({ ...item, title });
    }
    if (items.length > before) feedsSearched++;
  }
  return { items, feedsSearched, feedTotal: unique.length, feedCached, readable: true, readAt: now };
}

function loadPool(): Promise<ClaimPool> {
  const now = Date.now();
  if (pool && now - pool.at < POOL_TTL_MS) return pool.promise;
  const promise = readPool();
  pool = { at: now, promise };
  // A failed or empty read is not reused: the next claim reads again.
  void promise.then(
    (read) => { if ((!read.readable || read.items.length === 0) && pool?.promise === promise) pool = null; },
    () => { if (pool?.promise === promise) pool = null; },
  );
  return promise;
}

export type ClaimPoolSearch = {
  /** claimCandidates of the claim; empty for an empty claim or when nothing was searched. */
  readonly candidates: NewsItemCore[];
  readonly searchedHeadlines: number;
  readonly searchedFeeds: number;
  readonly feedTotal: number;
  readonly feedCached: number;
  /** complete | partial | unavailable. Unavailable searched nothing. */
  readonly state: 'complete' | 'partial' | 'unavailable';
  readonly readAt: string;
};

/** The search behind both the RPC and the verify_claim MCP tool, which runs it in-process. */
export async function searchClaimPool(claimText: string): Promise<ClaimPoolSearch> {
  const claim = claimText.trim().slice(0, CLAIM_MAX_CHARS);
  const read = await loadPool();
  const state = !read.readable || read.feedCached === 0 || read.items.length === 0
    ? 'unavailable'
    : read.feedCached === read.feedTotal ? 'complete' : 'partial';
  const searched = state === 'unavailable' ? [] : read.items;
  return {
    candidates: claim ? claimCandidates(claim, searched) : [],
    searchedHeadlines: searched.length,
    searchedFeeds: state === 'unavailable' ? 0 : read.feedsSearched,
    feedTotal: read.feedTotal,
    feedCached: read.feedCached,
    state,
    readAt: new Date(read.readAt).toISOString(),
  };
}

function toHeadline(item: NewsItemCore): ClaimHeadline {
  return { source: item.source, title: item.title, link: item.link, publishedAt: item.pubDate.getTime() };
}

export async function searchClaimHeadlines(
  ctx: ServerContext,
  req: SearchClaimHeadlinesRequest,
): Promise<SearchClaimHeadlinesResponse> {
  const { candidates, ...search } = await searchClaimPool(req.claim ?? '');
  // A few feed caches are usually missing (231 of 241 on 2026-10-16), so a
  // partial search is the normal answer and may be cached; a search that did
  // not run may not.
  if (search.state === 'unavailable') markNoCacheResponse(ctx.request);
  return { headlines: candidates.map(toHeadline), ...search };
}

export const __testing__ = {
  resetPool(): void { pool = null; },
};
