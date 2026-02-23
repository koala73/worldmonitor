import type { Feed, NewsItem } from '@/types';
import { SITE_VARIANT } from '@/config';
import { chunkArray, fetchWithProxy } from '@/utils';
import { classifyByKeyword, classifyWithAI } from './threat-classifier';
import { inferGeoHubsFromTitle } from './geo-hub-index';
import { getPersistentCache, setPersistentCache } from './persistent-cache';
import { dataFreshness } from './data-freshness';

// Per-feed circuit breaker: track failures and cooldowns
const FEED_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes after failure
const MAX_FAILURES = 2; // failures before cooldown
const MAX_CACHE_ENTRIES = 100; // Prevent unbounded growth
const feedFailures = new Map<string, { count: number; cooldownUntil: number }>();
const feedCache = new Map<string, { items: NewsItem[]; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function toSerializable(items: NewsItem[]): Array<Omit<NewsItem, 'pubDate'> & { pubDate: string }> {
  return items.map(item => ({ ...item, pubDate: item.pubDate.toISOString() }));
}

function fromSerializable(items: Array<Omit<NewsItem, 'pubDate'> & { pubDate: string }>): NewsItem[] {
  return items.map(item => ({ ...item, pubDate: new Date(item.pubDate) }));
}

async function loadPersistentFeed(feedName: string): Promise<NewsItem[] | null> {
  const entry = await getPersistentCache<Array<Omit<NewsItem, 'pubDate'> & { pubDate: string }>>(`feed:${feedName}`);
  if (!entry?.data?.length) return null;
  return fromSerializable(entry.data);
}

// Clean up stale entries to prevent unbounded growth
function cleanupCaches(): void {
  const now = Date.now();

  for (const [key, value] of feedCache) {
    if (now - value.timestamp > CACHE_TTL * 2) {
      feedCache.delete(key);
    }
  }

  for (const [key, state] of feedFailures) {
    if (state.cooldownUntil > 0 && now > state.cooldownUntil) {
      feedFailures.delete(key);
    }
  }

  if (feedCache.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(feedCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
    for (const [key] of toRemove) {
      feedCache.delete(key);
    }
  }
}

function isFeedOnCooldown(feedName: string): boolean {
  const state = feedFailures.get(feedName);
  if (!state) return false;
  if (Date.now() < state.cooldownUntil) return true;
  if (state.cooldownUntil > 0) feedFailures.delete(feedName);
  return false;
}

function recordFeedFailure(feedName: string): void {
  const state = feedFailures.get(feedName) || { count: 0, cooldownUntil: 0 };
  state.count++;
  if (state.count >= MAX_FAILURES) {
    state.cooldownUntil = Date.now() + FEED_COOLDOWN_MS;
    console.warn(`[RSS] ${feedName} on cooldown for 5 minutes after ${state.count} failures`);
  }
  feedFailures.set(feedName, state);
}

function recordFeedSuccess(feedName: string): void {
  feedFailures.delete(feedName);
}

export async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  if (feedCache.size > MAX_CACHE_ENTRIES / 2) cleanupCaches();

  if (isFeedOnCooldown(feed.name)) {
    const cached = feedCache.get(feed.name);
    if (cached) return cached.items;
    return (await loadPersistentFeed(feed.name)) || [];
  }

  const cached = feedCache.get(feed.name);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.items;
  }

  try {
    const response = await fetchWithProxy(feed.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      console.warn(`Parse error for ${feed.name}`);
      recordFeedFailure(feed.name);
      const persistent = await loadPersistentFeed(feed.name);
      return cached?.items || persistent || [];
    }

    let items = doc.querySelectorAll('item');
    const isAtom = items.length === 0;
    if (isAtom) items = doc.querySelectorAll('entry');

    const parsed = Array.from(items)
      .slice(0, 5)
      .map((item) => {
        const title = item.querySelector('title')?.textContent || '';
        let link = '';
        if (isAtom) {
          const linkEl = item.querySelector('link[href]');
          link = linkEl?.getAttribute('href') || '';
        } else {
          link = item.querySelector('link')?.textContent || '';
        }

        const pubDateStr = isAtom
          ? (item.querySelector('published')?.textContent || item.querySelector('updated')?.textContent || '')
          : (item.querySelector('pubDate')?.textContent || '');
        const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
        const threat = classifyByKeyword(title, SITE_VARIANT);
        const isAlert = threat.level === 'critical' || threat.level === 'high';
        const geoMatches = inferGeoHubsFromTitle(title);
        const topGeo = geoMatches[0];

        return {
          source: feed.name,
          title,
          link,
          pubDate,
          isAlert,
          threat,
          ...(topGeo && { lat: topGeo.hub.lat, lon: topGeo.hub.lon, locationName: topGeo.hub.name }),
        };
      });

    feedCache.set(feed.name, { items: parsed, timestamp: Date.now() });
    void setPersistentCache(`feed:${feed.name}`, toSerializable(parsed));
    recordFeedSuccess(feed.name);

    for (const item of parsed) {
      if (item.threat.source === 'keyword') {
        classifyWithAI(item.title, SITE_VARIANT).then((aiResult) => {
          if (aiResult && aiResult.confidence > item.threat.confidence) {
            item.threat = aiResult;
            item.isAlert = aiResult.level === 'critical' || aiResult.level === 'high';
          }
        }).catch(() => {});
      }
    }

    return parsed;
  } catch (e) {
    console.error(`Failed to fetch ${feed.name}:`, e);
    recordFeedFailure(feed.name);
    const persistent = await loadPersistentFeed(feed.name);
    return cached?.items || persistent || [];
  }
}

export async function fetchCategoryFeeds(
  feeds: Feed[],
  options: {
    batchSize?: number;
    onBatch?: (items: NewsItem[]) => void;
  } = {}
): Promise<NewsItem[]> {
  const topLimit = 20;
  const batchSize = options.batchSize ?? 5;
  const batches = chunkArray(feeds, batchSize);
  const topItems: NewsItem[] = [];
  let totalItems = 0;

  const ensureSortedDescending = () => [...topItems].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  const insertTopItem = (item: NewsItem) => {
    totalItems += 1;
    if (topItems.length < topLimit) {
      topItems.push(item);
      if (topItems.length === topLimit) topItems.sort((a, b) => a.pubDate.getTime() - b.pubDate.getTime());
      return;
    }

    const itemTime = item.pubDate.getTime();
    if (itemTime <= topItems[0]!.pubDate.getTime()) return;

    topItems[0] = item;
    for (let i = 0; i < topItems.length - 1; i += 1) {
      if (topItems[i]!.pubDate.getTime() <= topItems[i + 1]!.pubDate.getTime()) break;
      [topItems[i], topItems[i + 1]] = [topItems[i + 1]!, topItems[i]!];
    }
  };

  for (const batch of batches) {
    const results = await Promise.all(batch.map(fetchFeed));
    results.flat().forEach(insertTopItem);
    options.onBatch?.(ensureSortedDescending());
  }

  if (totalItems > 0) {
    dataFreshness.recordUpdate('rss', totalItems);
  }

  return ensureSortedDescending();
}
