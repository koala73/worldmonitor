// Simplified RSS fetcher — adapted from original src/services/rss.ts
// Removed dependencies on: geo-hub-index, trending-keywords, i18n, ai-classify-queue, ml-worker, ai-flow-settings, persistent-cache (complex), data-freshness

import type { Feed, NewsItem } from '@/types';
import { classifyByKeyword } from './threat-classifier';
import { parseFeedDateOrNow } from './feed-date';

const FEED_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_FAILURES = 2;
const MAX_CACHE_ENTRIES = 100;
const CACHE_TTL = 30 * 60 * 1000;

const feedFailures = new Map<string, { count: number; cooldownUntil: number }>();
const feedCache = new Map<string, { items: NewsItem[]; timestamp: number }>();

function cleanupCaches(): void {
  const now = Date.now();
  for (const [key, value] of feedCache) {
    if (now - value.timestamp > CACHE_TTL * 2) feedCache.delete(key);
  }
  for (const [key, state] of feedFailures) {
    if (state.cooldownUntil > 0 && now > state.cooldownUntil) feedFailures.delete(key);
  }
  if (feedCache.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(feedCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (const [key] of entries.slice(0, entries.length - MAX_CACHE_ENTRIES)) {
      feedCache.delete(key);
    }
  }
}

function isFeedOnCooldown(key: string): boolean {
  const state = feedFailures.get(key);
  if (!state) return false;
  if (Date.now() < state.cooldownUntil) return true;
  if (state.cooldownUntil > 0) feedFailures.delete(key);
  return false;
}

function recordFeedFailure(key: string): void {
  const state = feedFailures.get(key) || { count: 0, cooldownUntil: 0 };
  state.count++;
  if (state.count >= MAX_FAILURES) {
    state.cooldownUntil = Date.now() + FEED_COOLDOWN_MS;
    console.warn(`[RSS] ${key} on cooldown for 5 minutes after ${state.count} failures`);
  }
  feedFailures.set(key, state);
}

function recordFeedSuccess(key: string): void {
  feedFailures.delete(key);
}

export function getFeedFailures(): Map<string, { count: number; cooldownUntil: number }> {
  return new Map(feedFailures);
}

// ── RSS proxy ─────────────────────────────────────────────────────────────

function rssProxyUrl(feedUrl: string): string {
  if (import.meta.env.DEV) {
    return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
  }
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

// ── Image extraction ──────────────────────────────────────────────────────

function extractImageUrl(item: Element): string | undefined {
  const MRSS_NS = 'http://search.yahoo.com/mrss/';
  const IMG_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i;

  try {
    const mediaContents = item.getElementsByTagNameNS(MRSS_NS, 'content');
    for (let i = 0; i < mediaContents.length; i++) {
      const el = mediaContents[i]!;
      const url = el.getAttribute('url');
      if (!url) continue;
      const medium = el.getAttribute('medium');
      const type = el.getAttribute('type');
      if (medium === 'image' || type?.startsWith('image/') || IMG_EXTENSIONS.test(url) || (!type && !medium)) {
        return url;
      }
    }
  } catch { /* fall through */ }

  try {
    const thumbnails = item.getElementsByTagNameNS(MRSS_NS, 'thumbnail');
    for (let i = 0; i < thumbnails.length; i++) {
      const url = thumbnails[i]!.getAttribute('url');
      if (url) return url;
    }
  } catch { /* fall through */ }

  try {
    const enclosures = item.getElementsByTagName('enclosure');
    for (let i = 0; i < enclosures.length; i++) {
      const el = enclosures[i]!;
      const type = el.getAttribute('type');
      const url = el.getAttribute('url');
      if (url && type?.startsWith('image/')) return url;
    }
  } catch { /* fall through */ }

  try {
    const description = item.querySelector('description')?.textContent || '';
    const contentEncoded = item.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded');
    const contentText = contentEncoded.length > 0 ? (contentEncoded[0]!.textContent || '') : '';
    const htmlContent = contentText || description;
    const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/);
    if (imgMatch?.[1]) return imgMatch[1];
  } catch { /* fall through */ }

  return undefined;
}

// ── Fetch a single feed ───────────────────────────────────────────────────

export async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  if (feedCache.size > MAX_CACHE_ENTRIES / 2) cleanupCaches();
  const key = feed.name;

  if (isFeedOnCooldown(key)) {
    return feedCache.get(key)?.items || [];
  }

  const cached = feedCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.items;
  }

  try {
    let url = typeof feed.url === 'string' ? feed.url : feed.url['en'] || Object.values(feed.url)[0] || '';
    if (!url) throw new Error(`No URL for feed ${feed.name}`);

    // All feed URLs go through the RSS proxy
    const proxyUrl = rssProxyUrl(url);
    const response = await fetch(proxyUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');

    if (doc.querySelector('parsererror')) {
      console.warn(`Parse error for ${feed.name}`);
      recordFeedFailure(key);
      return cached?.items || [];
    }

    let items = doc.querySelectorAll('item');
    const isAtom = items.length === 0;
    if (isAtom) items = doc.querySelectorAll('entry');

    const parsed = Array.from(items).slice(0, 5).map((item) => {
      const title = item.querySelector('title')?.textContent || '';
      let link = '';
      if (isAtom) {
        link = item.querySelector('link[href]')?.getAttribute('href') || '';
      } else {
        link = item.querySelector('link')?.textContent || '';
      }

      const pubDateStr = isAtom
        ? (item.querySelector('published')?.textContent || item.querySelector('updated')?.textContent || '')
        : (item.querySelector('pubDate')?.textContent || '');
      const pubDate = parseFeedDateOrNow(pubDateStr);
      const threat = classifyByKeyword(title);
      const isAlert = threat.level === 'critical' || threat.level === 'high';

      return {
        source: feed.name,
        title,
        link,
        pubDate,
        isAlert,
        threat,
        lang: feed.lang,
        imageUrl: extractImageUrl(item),
      } as NewsItem;
    });

    feedCache.set(key, { items: parsed, timestamp: Date.now() });
    recordFeedSuccess(key);
    return parsed;
  } catch (e) {
    console.error(`Failed to fetch ${feed.name}:`, e);
    recordFeedFailure(key);
    return cached?.items || [];
  }
}

// ── Fetch multiple feeds in batches ───────────────────────────────────────

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function fetchCategoryFeeds(
  feeds: Feed[],
  options: { batchSize?: number; onBatch?: (items: NewsItem[]) => void } = {},
): Promise<NewsItem[]> {
  const topLimit = 20;
  const batchSize = options.batchSize ?? 5;
  const batches = chunkArray(feeds, batchSize);
  const topItems: NewsItem[] = [];

  for (const batch of batches) {
    const results = await Promise.all(batch.map(fetchFeed));
    for (const item of results.flat()) {
      topItems.push(item);
    }
    // Sort descending by date, keep top N
    topItems.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
    if (topItems.length > topLimit) topItems.length = topLimit;
    options.onBatch?.(topItems);
  }

  return topItems;
}
