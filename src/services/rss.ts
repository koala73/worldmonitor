import type { Feed, NewsItem } from '@/types';
import { SITE_VARIANT } from '@/config';
import { chunkArray, fetchWithProxy } from '@/utils';
import { classifyByKeyword, classifyWithAI } from './threat-classifier';
import { inferGeoHubsFromTitle } from './geo-hub-index';
import { getPersistentCache, setPersistentCache } from './persistent-cache';
import { dataFreshness } from './data-freshness';
import { ingestHeadlines } from './trending-keywords';
import { getCurrentLanguage } from './i18n';
import { canQueueAiClassification, AI_CLASSIFY_MAX_PER_FEED } from './ai-classify-queue';
import { mlWorker } from './ml-worker';
import { storeVectors } from './vector-store';
import { hashString } from '@/utils/hash';

const FEED_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_FAILURES = 2;
const MAX_CACHE_ENTRIES = 100;
const FEED_SCOPE_SEPARATOR = '::';
const feedFailures = new Map<string, { count: number; cooldownUntil: number }>();
const feedCache = new Map<string, { items: NewsItem[]; timestamp: number }>();
const CACHE_TTL = 30 * 60 * 1000;

function toSerializable(items: NewsItem[]): Array<Omit<NewsItem, 'pubDate'> & { pubDate: string }> {
  return items.map(item => ({ ...item, pubDate: item.pubDate.toISOString() }));
}

function fromSerializable(items: Array<Omit<NewsItem, 'pubDate'> & { pubDate: string }>): NewsItem[] {
  return items.map(item => ({ ...item, pubDate: new Date(item.pubDate) }));
}

function getFeedScope(feedName: string, lang: string): string {
  return `${feedName}${FEED_SCOPE_SEPARATOR}${lang}`;
}

function parseFeedScope(feedScope: string): { feedName: string; lang: string } {
  const splitIndex = feedScope.lastIndexOf(FEED_SCOPE_SEPARATOR);
  if (splitIndex === -1) return { feedName: feedScope, lang: 'en' };
  return {
    feedName: feedScope.slice(0, splitIndex),
    lang: feedScope.slice(splitIndex + FEED_SCOPE_SEPARATOR.length),
  };
}

function getPersistentFeedKey(feedScope: string): string {
  return `feed:${feedScope}`;
}

async function readPersistentFeed(key: string): Promise<NewsItem[] | null> {
  const entry = await getPersistentCache<Array<Omit<NewsItem, 'pubDate'> & { pubDate: string }>>(key);
  if (!entry?.data?.length) return null;
  return fromSerializable(entry.data);
}

async function loadPersistentFeed(feedScope: string): Promise<NewsItem[] | null> {
  const scopedKey = getPersistentFeedKey(feedScope);
  const scoped = await readPersistentFeed(scopedKey);
  if (scoped) return scoped;

  // Migration fallback: older builds stored feeds as `feed:<feedName>` without language scope.
  // Only use this for English to avoid mixing cached content across locales.
  const { feedName, lang } = parseFeedScope(feedScope);
  if (lang !== 'en') return null;
  return readPersistentFeed(`feed:${feedName}`);
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

function isFeedOnCooldown(feedScope: string): boolean {
  const state = feedFailures.get(feedScope);
  if (!state) return false;
  if (Date.now() < state.cooldownUntil) return true;
  if (state.cooldownUntil > 0) feedFailures.delete(feedScope);
  return false;
}

function recordFeedFailure(feedScope: string): void {
  const state = feedFailures.get(feedScope) || { count: 0, cooldownUntil: 0 };
  state.count++;
  if (state.count >= MAX_FAILURES) {
    state.cooldownUntil = Date.now() + FEED_COOLDOWN_MS;
    const { feedName, lang } = parseFeedScope(feedScope);
    console.warn(`[RSS] ${feedName} (${lang}) on cooldown for 5 minutes after ${state.count} failures`);
  }
  feedFailures.set(feedScope, state);
}

function recordFeedSuccess(feedScope: string): void {
  feedFailures.delete(feedScope);
}

export function getFeedFailures(): Map<string, { count: number; cooldownUntil: number }> {
  const currentLang = getCurrentLanguage();
  const currentLangFailures = new Map<string, { count: number; cooldownUntil: number }>();

  for (const [feedScope, state] of feedFailures) {
    const { feedName, lang } = parseFeedScope(feedScope);
    if (lang === currentLang) {
      currentLangFailures.set(feedName, state);
    }
  }

  return currentLangFailures;
}


/**
 * Extract the best image URL from an RSS item element.
 * Tries multiple RSS image sources in priority order:
 * 1. media:content (Yahoo MRSS namespace)
 * 2. media:thumbnail (Yahoo MRSS namespace)
 * 3. <enclosure> with image type
 * 4. First <img> in description/content:encoded
 * Returns undefined if no image found. Never throws.
 */
function extractImageUrl(item: Element): string | undefined {
  const MRSS_NS = 'http://search.yahoo.com/mrss/';
  const IMG_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i;

  try {
    // 1. media:content with MRSS namespace
    const mediaContents = item.getElementsByTagNameNS(MRSS_NS, 'content');
    for (let i = 0; i < mediaContents.length; i++) {
      const el = mediaContents[i]!;
      const url = el.getAttribute('url');
      if (!url) continue;
      const medium = el.getAttribute('medium');
      const type = el.getAttribute('type');
      // Accept if medium is image, type contains image, URL looks like image, or no type specified
      if (medium === 'image' || type?.startsWith('image/') || IMG_EXTENSIONS.test(url) || (!type && !medium)) {
        return url;
      }
    }
  } catch {
    // Namespace not supported or other XML issue, fall through
  }

  try {
    // 2. media:thumbnail with MRSS namespace
    const thumbnails = item.getElementsByTagNameNS(MRSS_NS, 'thumbnail');
    for (let i = 0; i < thumbnails.length; i++) {
      const url = thumbnails[i]!.getAttribute('url');
      if (url) return url;
    }
  } catch {
    // Fall through
  }

  try {
    // 3. <enclosure> with image type
    const enclosures = item.getElementsByTagName('enclosure');
    for (let i = 0; i < enclosures.length; i++) {
      const el = enclosures[i]!;
      const type = el.getAttribute('type');
      const url = el.getAttribute('url');
      if (url && type?.startsWith('image/')) return url;
    }
  } catch {
    // Fall through
  }

  try {
    // 4. Fallback: parse first <img src="..."> from description or content:encoded
    const description = item.querySelector('description')?.textContent || '';
    const contentEncoded = item.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded');
    const contentText = contentEncoded.length > 0 ? (contentEncoded[0]!.textContent || '') : '';
    const htmlContent = contentText || description;
    const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/);
    if (imgMatch?.[1]) return imgMatch[1];
  } catch {
    // Fall through
  }

  return undefined;
}

export async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  if (feedCache.size > MAX_CACHE_ENTRIES / 2) cleanupCaches();
  const currentLang = getCurrentLanguage();
  const feedScope = getFeedScope(feed.name, currentLang);

  if (isFeedOnCooldown(feedScope)) {
    const cached = feedCache.get(feedScope);
    if (cached) return cached.items;
    return (await loadPersistentFeed(feedScope)) || [];
  }

  const cached = feedCache.get(feedScope);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.items;
  }

  try {
    let url = typeof feed.url === 'string' ? feed.url : feed.url['en'];
    if (typeof feed.url !== 'string') {
      url = feed.url[currentLang] || feed.url['en'] || Object.values(feed.url)[0] || '';
    }

    if (!url) throw new Error(`No URL found for feed ${feed.name}`);

    const response = await fetchWithProxy(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      console.warn(`Parse error for ${feed.name}`);
      recordFeedFailure(feedScope);
      const persistent = await loadPersistentFeed(feedScope);
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
        const parsedDate = pubDateStr ? new Date(pubDateStr) : new Date();
        const pubDate = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
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
          lang: feed.lang,
          ...(SITE_VARIANT === 'happy' && { imageUrl: extractImageUrl(item) }),
        };
      });

    feedCache.set(feedScope, { items: parsed, timestamp: Date.now() });
    void setPersistentCache(getPersistentFeedKey(feedScope), toSerializable(parsed));
    recordFeedSuccess(feedScope);
    ingestHeadlines(parsed.map(item => ({
      title: item.title,
      pubDate: item.pubDate,
      source: item.source,
      link: item.link,
    })));

    // Vectorize & store locally in the background
    if (mlWorker.isAvailable) {
      mlWorker.embedTexts(parsed.map(item => item.title))
        .then(embeddings => {
          const vectors = parsed.map((item, idx) => ({
            id: hashString(item.link || item.title),
            text: item.title,
            embedding: embeddings[idx]!,
            pubDate: item.pubDate.getTime(),
            source: item.source,
            url: item.link,
            tags: item.locationName ? [item.locationName] : undefined
          }));
          storeVectors(vectors).catch(e => console.warn('[RAG] Failed to store vectors', e));
        })
        .catch(e => console.warn('[RAG] Failed to embed headlines', e));
    }

    const aiCandidates = parsed
      .filter(item => item.threat.source === 'keyword')
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, AI_CLASSIFY_MAX_PER_FEED);

    for (const item of aiCandidates) {
      if (!canQueueAiClassification(item.title)) continue;
      classifyWithAI(item.title, SITE_VARIANT).then((aiResult) => {
        if (aiResult && aiResult.confidence > item.threat.confidence) {
          item.threat = aiResult;
          item.isAlert = aiResult.level === 'critical' || aiResult.level === 'high';
        }
      }).catch(() => { });
    }

    return parsed;
  } catch (e) {
    console.error(`Failed to fetch ${feed.name}:`, e);
    recordFeedFailure(feedScope);
    const persistent = await loadPersistentFeed(feedScope);
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
  const currentLang = getCurrentLanguage();

  // Filter feeds by language:
  // 1. Feeds with no explicit 'lang' are universal (or multi-url handled inside fetchFeed)
  // 2. Feeds with explicit 'lang' must match current UI language
  const filteredFeeds = feeds.filter(feed => !feed.lang || feed.lang === currentLang);

  const batches = chunkArray(filteredFeeds, batchSize);
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
