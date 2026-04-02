import type {
  ServerContext,
  ListFeedDigestRequest,
  ListFeedDigestResponse,
  CategoryBucket,
  NewsItem as ProtoNewsItem,
  ThreatLevel as ProtoThreatLevel,
  StoryMeta as ProtoStoryMeta,
  StoryPhase as ProtoStoryPhase,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { cachedFetchJson, getCachedJsonBatch, runRedisPipeline } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { sha256Hex } from '../../../_shared/hash';
import { CHROME_UA } from '../../../_shared/constants';
import { VARIANT_FEEDS, INTEL_SOURCES, type ServerFeed } from './_feeds';
import { classifyByKeyword, type ThreatLevel } from './_classifier';
import { getSourceTier } from '../../../_shared/source-tiers';
import {
  STORY_TRACK_KEY,
  STORY_SOURCES_KEY,
  STORY_PEAK_KEY,
  DIGEST_ACCUMULATOR_KEY,
  STORY_TTL,
  STORY_TRACK_KEY_PREFIX,
  DIGEST_ACCUMULATOR_TTL,
} from '../../../_shared/cache-keys';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';

const RSS_ACCEPT = 'application/rss+xml, application/xml, text/xml, */*';

const VALID_VARIANTS = new Set(['full', 'tech', 'finance', 'happy', 'commodity']);
const fallbackDigestCache = new Map<string, { data: ListFeedDigestResponse; ts: number }>();
const ITEMS_PER_FEED = 5;
const MAX_ITEMS_PER_CATEGORY = 20;
const FEED_TIMEOUT_MS = 8_000;
const OVERALL_DEADLINE_MS = 25_000;
const BATCH_CONCURRENCY = 20;

const LEVEL_TO_PROTO: Record<ThreatLevel, ProtoThreatLevel> = {
  critical: 'THREAT_LEVEL_CRITICAL',
  high: 'THREAT_LEVEL_HIGH',
  medium: 'THREAT_LEVEL_MEDIUM',
  low: 'THREAT_LEVEL_LOW',
  info: 'THREAT_LEVEL_UNSPECIFIED',
};

/** Numeric severity values for importanceScore computation (0–100). */
const SEVERITY_SCORES: Record<ThreatLevel, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
  info: 0,
};

/**
 * Importance score component weights (must sum to 1.0).
 * Severity dominates because threat level is the primary signal.
 * Corroboration (independent sources) strongly validates an event.
 * Source tier boosts confidence. Recency is a minor tiebreaker.
 */
const SCORE_WEIGHTS = {
  severity: 0.4,
  sourceTier: 0.2,
  corroboration: 0.3,
  recency: 0.1,
} as const;


interface ParsedItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  level: ThreatLevel;
  category: string;
  confidence: number;
  classSource: 'keyword' | 'llm';
  importanceScore: number;
  corroborationCount: number;
  titleHash?: string;
}

function computeImportanceScore(
  level: ThreatLevel,
  source: string,
  corroborationCount: number,
  publishedAt: number,
): number {
  const tier = getSourceTier(source);
  const tierScore = tier === 1 ? 100 : tier === 2 ? 75 : tier === 3 ? 50 : 25;
  const corroborationScore = Math.min(corroborationCount, 5) * 20;
  const ageMs = Date.now() - publishedAt;
  const recencyScore = Math.max(0, 1 - ageMs / (24 * 60 * 60 * 1000)) * 100;
  return Math.round(
    SEVERITY_SCORES[level] * SCORE_WEIGHTS.severity +
    tierScore * SCORE_WEIGHTS.sourceTier +
    corroborationScore * SCORE_WEIGHTS.corroboration +
    recencyScore * SCORE_WEIGHTS.recency,
  );
}

function createTimeoutLinkedController(parentSignal: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onAbort, { once: true });

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

async function fetchRssText(
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  const { controller, cleanup } = createTimeoutLinkedController(signal);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } finally {
    cleanup();
  }
}

async function fetchAndParseRss(
  feed: ServerFeed,
  variant: string,
  signal: AbortSignal,
): Promise<ParsedItem[]> {
  const cacheKey = `rss:feed:v1:${variant}:${feed.url}`;

  try {
    const cached = await cachedFetchJson<ParsedItem[]>(cacheKey, 3600, async () => {
      // Try direct fetch first
      let text = await fetchRssText(feed.url, signal).catch(() => null);

      // Fallback: route through Railway relay (different IP, avoids Vercel blocks)
      if (!text) {
        const relayBase = getRelayBaseUrl();
        if (relayBase) {
          const relayUrl = `${relayBase}/rss?url=${encodeURIComponent(feed.url)}`;
          const { controller, cleanup } = createTimeoutLinkedController(signal);
          try {
            const resp = await fetch(relayUrl, {
              headers: getRelayHeaders({ Accept: RSS_ACCEPT }),
              signal: controller.signal,
            });
            if (resp.ok) text = await resp.text();
          } catch { /* relay also failed */ } finally {
            cleanup();
          }
        }
      }

      if (!text) return null;
      return parseRssXml(text, feed, variant);
    });

    return cached ?? [];
  } catch {
    return [];
  }
}

function parseRssXml(xml: string, feed: ServerFeed, variant: string): ParsedItem[] | null {
  const items: ParsedItem[] = [];

  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  let matches = [...xml.matchAll(itemRegex)];
  const isAtom = matches.length === 0;
  if (isAtom) matches = [...xml.matchAll(entryRegex)];

  for (const match of matches.slice(0, ITEMS_PER_FEED)) {
    const block = match[1]!;

    const title = extractTag(block, 'title');
    if (!title) continue;

    let link: string;
    if (isAtom) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/);
      link = hrefMatch?.[1] ?? '';
    } else {
      link = extractTag(block, 'link');
    }
    // Strip non-HTTP links (javascript:, data:, etc.) before any downstream use.
    if (!/^https?:\/\//i.test(link)) link = '';

    const pubDateStr = isAtom
      ? (extractTag(block, 'published') || extractTag(block, 'updated'))
      : extractTag(block, 'pubDate');
    const parsedDate = pubDateStr ? new Date(pubDateStr) : new Date();
    const publishedAt = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime();

    const threat = classifyByKeyword(title, variant);
    const isAlert = threat.level === 'critical' || threat.level === 'high';

    items.push({
      source: feed.name,
      title,
      link,
      publishedAt,
      isAlert,
      level: threat.level,
      category: threat.category,
      confidence: threat.confidence,
      classSource: 'keyword',
      importanceScore: 0,
      corroborationCount: 1,
    });
  }

  return items.length > 0 ? items : null;
}

const TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();
const KNOWN_TAGS = ['title', 'link', 'pubDate', 'published', 'updated'] as const;
for (const tag of KNOWN_TAGS) {
  TAG_REGEX_CACHE.set(tag, {
    cdata: new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'),
    plain: new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'),
  });
}

function extractTag(xml: string, tag: string): string {
  const cached = TAG_REGEX_CACHE.get(tag);
  const cdataRe = cached?.cdata ?? new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const plainRe = cached?.plain ?? new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');

  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1]!.trim();

  const match = xml.match(plainRe);
  return match ? decodeXmlEntities(match[1]!.trim()) : '';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

async function enrichWithAiCache(items: ParsedItem[]): Promise<void> {
  const candidates = items.filter(i => i.classSource === 'keyword');
  if (candidates.length === 0) return;

  const keyMap = new Map<string, ParsedItem[]>();
  for (const item of candidates) {
    const hash = (await sha256Hex(item.title.toLowerCase())).slice(0, 16);
    const key = `classify:sebuf:v1:${hash}`;
    const existing = keyMap.get(key) ?? [];
    existing.push(item);
    keyMap.set(key, existing);
  }

  const keys = [...keyMap.keys()];
  const cached = await getCachedJsonBatch(keys);

  for (const [key, relatedItems] of keyMap) {
    const hit = cached.get(key) as { level?: string; category?: string } | undefined;
    if (!hit || hit.level === '_skip' || !hit.level || !hit.category) continue;

    for (const item of relatedItems) {
      if (0.9 <= item.confidence) continue;
      item.level = hit.level as typeof item.level;
      item.category = hit.category;
      item.confidence = 0.9;
      item.classSource = 'llm';
      item.isAlert = hit.level === 'critical' || hit.level === 'high';
    }
  }
}

// ── Story persistence tracking ────────────────────────────────────────────────

function normalizeTitle(title: string): string {
  // \p{L} = any Unicode letter; \p{N} = any Unicode number.
  // The `u` flag is required for Unicode property escapes — without it \w
  // matches only ASCII [A-Za-z0-9_], stripping all Arabic/CJK/Cyrillic chars
  // and collapsing every non-Latin title to the same empty hash.
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

interface StoryTrack {
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
  sourceCount: number;
  currentScore: number;
  peakScore: number;
}

function derivePhase(track: StoryTrack): ProtoStoryPhase {
  const ageMs = Date.now() - track.firstSeen;
  if (track.mentionCount <= 1) return 'STORY_PHASE_BREAKING';
  if (track.mentionCount <= 5 && ageMs < 2 * 60 * 60 * 1000) return 'STORY_PHASE_DEVELOPING';
  // FADING requires real scores from E1. Until E1 ships, currentScore and
  // peakScore are both 0 (HSETNX placeholders), so this branch is intentionally
  // inactive — stories fall through to SUSTAINED rather than incorrectly FADING.
  if (track.currentScore > 0 && track.peakScore > 0 && track.currentScore < track.peakScore * 0.5) return 'STORY_PHASE_FADING';
  return 'STORY_PHASE_SUSTAINED';
}

/**
 * Batch-read existing story:track hashes from Redis for a list of title hashes.
 * Returns a Map<titleHash, StoryTrack>. Missing entries are absent from the map.
 */
async function readStoryTracks(titleHashes: string[]): Promise<Map<string, StoryTrack>> {
  if (titleHashes.length === 0) return new Map();
  const fields = ['firstSeen', 'lastSeen', 'mentionCount', 'sourceCount', 'currentScore', 'peakScore'];
  const commands = titleHashes.map(h => [
    'HMGET', `${STORY_TRACK_KEY_PREFIX}${h}`, ...fields,
  ]);
  const results = await runRedisPipeline(commands, true);
  const map = new Map<string, StoryTrack>();
  for (let i = 0; i < titleHashes.length; i++) {
    const vals = results[i]?.result as string[] | null;
    if (!vals || !vals[0]) continue; // firstSeen missing → new story
    map.set(titleHashes[i]!, {
      firstSeen:    Number(vals[0]),
      lastSeen:     Number(vals[1] ?? 0),
      mentionCount: Number(vals[2] ?? 0),
      sourceCount:  Number(vals[3] ?? 0),
      currentScore: Number(vals[4] ?? 0),
      peakScore:    Number(vals[5] ?? 0),
    });
  }
  return map;
}

function toProtoItem(item: ParsedItem, storyMeta?: ProtoStoryMeta): ProtoNewsItem {
  return {
    source: item.source,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    isAlert: item.isAlert,
    importanceScore: item.importanceScore,
    corroborationCount: item.corroborationCount ?? 0,
    storyMeta,
    threat: {
      level: LEVEL_TO_PROTO[item.level],
      category: item.category,
      confidence: item.confidence,
      source: item.classSource,
    },
    locationName: '',
  };
}

export async function listFeedDigest(
  ctx: ServerContext,
  req: ListFeedDigestRequest,
): Promise<ListFeedDigestResponse> {
  const variant = VALID_VARIANTS.has(req.variant) ? req.variant : 'full';
  const lang = req.lang || 'en';

  const digestCacheKey = `news:digest:v1:${variant}:${lang}`;
  const fallbackKey = `${variant}:${lang}`;

  const empty = (): ListFeedDigestResponse => ({ categories: {}, feedStatuses: {}, generatedAt: new Date().toISOString() });

  try {
    // cachedFetchJson coalesces concurrent cold-path calls: concurrent requests
    // for the same key share a single buildDigest() run instead of fanning out
    // across all RSS feeds. Returning null skips the Redis write and caches a
    // neg-sentinel (120s) to absorb the request storm during degraded periods.
    const fresh = await cachedFetchJson<ListFeedDigestResponse>(
      digestCacheKey,
      900,
      async () => {
        const result = await buildDigest(variant, lang);
        const totalItems = Object.values(result.categories).reduce((sum, b) => sum + b.items.length, 0);
        return totalItems > 0 ? result : null;
      },
    );

    if (fresh === null) {
      markNoCacheResponse(ctx.request);
      return fallbackDigestCache.get(fallbackKey)?.data ?? empty();
    }

    if (fallbackDigestCache.size > 50) fallbackDigestCache.clear();
    fallbackDigestCache.set(fallbackKey, { data: fresh, ts: Date.now() });
    return fresh;
  } catch {
    markNoCacheResponse(ctx.request);
    return fallbackDigestCache.get(fallbackKey)?.data ?? empty();
  }
}

const STORY_BATCH_SIZE = 80; // keeps each pipeline call well under Upstash's 1000-command cap

async function writeStoryTracking(items: ParsedItem[], variant: string, hashes: string[]): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();
  const accKey = DIGEST_ACCUMULATOR_KEY(variant);

  for (let batchStart = 0; batchStart < items.length; batchStart += STORY_BATCH_SIZE) {
    const batch = items.slice(batchStart, batchStart + STORY_BATCH_SIZE);
    const commands: Array<Array<string | number>> = [];

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!;
      const hash = hashes[batchStart + i]!;
      const trackKey = STORY_TRACK_KEY(hash);
      const sourcesKey = STORY_SOURCES_KEY(hash);
      const peakKey = STORY_PEAK_KEY(hash);
      const score = item.importanceScore;
      const nowStr = String(now);
      const ttl = STORY_TTL;

      commands.push(
        ['HINCRBY', trackKey, 'mentionCount', '1'],
        ['HSET', trackKey,
          'lastSeen', nowStr,
          'currentScore', score,
          'title', item.title,
          'link', item.link,
          'severity', item.level,
        ],
        ['HSETNX', trackKey, 'firstSeen', nowStr],
        ['ZADD', peakKey, 'GT', score, 'peak'],
        ['SADD', sourcesKey, item.source],
        ['EXPIRE', trackKey, ttl],
        ['EXPIRE', sourcesKey, ttl],
        ['EXPIRE', peakKey, ttl],
        ['ZADD', accKey, nowStr, hash],
      );
    }

    await runRedisPipeline(commands);
  }

  // Refresh accumulator TTL once per build — 48h, shorter than STORY_TTL since digest cron only needs ~24h lookback.
  await runRedisPipeline([['EXPIRE', accKey, DIGEST_ACCUMULATOR_TTL]]);
}

async function buildDigest(variant: string, lang: string): Promise<ListFeedDigestResponse> {
  const feedsByCategory = VARIANT_FEEDS[variant] ?? {};
  const feedStatuses: Record<string, string> = {};
  const categories: Record<string, CategoryBucket> = {};

  const deadlineController = new AbortController();
  const deadlineTimeout = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS);

  try {
    const allEntries: Array<{ category: string; feed: ServerFeed }> = [];

    for (const [category, feeds] of Object.entries(feedsByCategory)) {
      const filtered = feeds.filter(f => !f.lang || f.lang === lang);
      for (const feed of filtered) {
        allEntries.push({ category, feed });
      }
    }

    if (variant === 'full') {
      const filteredIntel = INTEL_SOURCES.filter(f => !f.lang || f.lang === lang);
      for (const feed of filteredIntel) {
        allEntries.push({ category: 'intel', feed });
      }
    }

    const results = new Map<string, ParsedItem[]>();
    // Track feeds that actually completed (with or without items) so we can
    // distinguish a genuine timeout (never ran) from a successful empty fetch.
    const completedFeeds = new Set<string>();

    for (let i = 0; i < allEntries.length; i += BATCH_CONCURRENCY) {
      if (deadlineController.signal.aborted) break;

      const batch = allEntries.slice(i, i + BATCH_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ category, feed }) => {
          const items = await fetchAndParseRss(feed, variant, deadlineController.signal);
          completedFeeds.add(feed.name);
          if (items.length === 0) feedStatuses[feed.name] = 'empty';
          return { category, items };
        }),
      );

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          const { category, items } = result.value;
          const existing = results.get(category) ?? [];
          existing.push(...items);
          results.set(category, existing);
        }
      }
    }

    for (const entry of allEntries) {
      if (!completedFeeds.has(entry.feed.name)) {
        feedStatuses[entry.feed.name] = 'timeout';
      }
    }

    // Flatten ALL items before any truncation so cross-category corroboration is counted.
    const allItems = [...results.values()].flat();

    // Compute sha256 title hashes and build corroboration map in one pass.
    // Hashes are stored on each item for reuse as Redis story-tracking keys.
    const corroborationMap = new Map<string, Set<string>>();
    await Promise.all(allItems.map(async (item) => {
      const hash = await sha256Hex(normalizeTitle(item.title));
      item.titleHash = hash;
      const sources = corroborationMap.get(hash) ?? new Set<string>();
      sources.add(item.source);
      corroborationMap.set(hash, sources);
    }));

    for (const item of allItems) {
      item.corroborationCount = corroborationMap.get(item.titleHash!)?.size ?? 1;
    }

    // Enrich ALL items with the AI classification cache BEFORE scoring so that
    // importanceScore uses the final (post-LLM) threat level, and truncation
    // discards items based on their true score.
    await enrichWithAiCache(allItems);

    // Compute importance score using final (post-enrichment) threat levels.
    for (const item of allItems) {
      item.importanceScore = computeImportanceScore(
        item.level, item.source, item.corroborationCount, item.publishedAt,
      );
    }

    // Sort by importanceScore desc, then pubDate desc; then truncate per category.
    const slicedByCategory = new Map<string, ParsedItem[]>();
    for (const [category, items] of results) {
      items.sort((a, b) =>
        b.importanceScore - a.importanceScore || b.publishedAt - a.publishedAt,
      );
      slicedByCategory.set(category, items.slice(0, MAX_ITEMS_PER_CATEGORY));
    }

    const allSliced = [...slicedByCategory.values()].flat();
    // titleHash was already set on each item during the corroboration pass above.
    const titleHashes = allSliced.map(i => i.titleHash!);

    const now = Date.now();

    // Read existing story tracking BEFORE writing so we know the previous cycle's
    // mentionCount. We merge read state + this cycle's increment in memory to
    // produce accurate, current StoryMeta without a second Redis round-trip.
    const uniqueHashes = [...new Set(titleHashes)];
    const storyTracks = await readStoryTracks(uniqueHashes).catch(() => new Map<string, StoryTrack>());

    // Write story tracking. Errors never fail the digest build.
    await writeStoryTracking(allSliced, variant, titleHashes).catch((err: unknown) =>
      console.warn('[digest] story tracking write failed:', err),
    );

    for (const [category, sliced] of slicedByCategory) {
      categories[category] = {
        items: sliced.map((item) => {
          const hash = item.titleHash!;
          const sourceCount = corroborationMap.get(hash)?.size ?? 1;
          const stale = storyTracks.get(hash);
          // Merge stale state + this cycle's HINCRBY to get the current mentionCount.
          // New stories (stale = undefined) start at mentionCount=1 this cycle.
          const mentionCount = stale ? stale.mentionCount + 1 : 1;
          const firstSeen = stale?.firstSeen ?? now;
          const merged: StoryTrack = {
            firstSeen,
            lastSeen: now,
            mentionCount,
            sourceCount,
            currentScore: stale?.currentScore ?? 0,
            peakScore: stale?.peakScore ?? 0,
          };
          const storyMeta: ProtoStoryMeta = {
            firstSeen,
            mentionCount,
            sourceCount,
            phase: derivePhase(merged),
          };
          return toProtoItem(item, storyMeta);
        }),
      };
    }

    return {
      categories,
      feedStatuses,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(deadlineTimeout);
  }
}
