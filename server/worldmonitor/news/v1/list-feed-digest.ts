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

// U3 — hard freshness floor (default 48h, env override NEWS_MAX_AGE_HOURS).
// Items older than this are dropped before scoring. The 24h `recencyScore`
// component already treats anything older than 24h as zero recency, so the
// 48h default is a soft buffer beyond that. Out-of-range / unparseable env
// values fall back to the default silently. See R3 in
// docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md.
function resolveMaxAgeMs(): number {
  const raw = Number.parseInt(process.env.NEWS_MAX_AGE_HOURS ?? '', 10);
  const hours = Number.isInteger(raw) && raw > 0 ? raw : 48;
  return hours * 60 * 60 * 1000;
}

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
  severity: 0.55,
  sourceTier: 0.2,
  corroboration: 0.15,
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
  lang: string;
  // Cleaned RSS/Atom article description: HTML-stripped, entity-decoded,
  // whitespace-normalised, clipped to MAX_DESCRIPTION_LEN. Empty string when
  // absent, too short, or indistinguishable from the headline. Grounding input
  // for brief / whyMatters / SummarizeArticle LLMs.
  description: string;
}

const MAX_DESCRIPTION_LEN = 400;
const MIN_DESCRIPTION_LEN = 40;

const DESCRIPTION_TAG_PRIORITY = {
  rss: ['description', 'content:encoded'] as const,
  atom: ['summary', 'content'] as const,
};

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

/**
 * Parser output: items that survived all parse-time gates plus per-feed
 * stats so the caller can classify feed health (e.g. silent zeroing from
 * an unrecognized date dialect — see U2 in
 * docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md).
 */
interface ParseResult {
  items: ParsedItem[];
  parsedTotal: number;     // count of <item>/<entry> blocks attempted
  droppedUndated: number;  // count dropped because every recognized date tag was empty/unparseable/future
}

async function fetchAndParseRss(
  feed: ServerFeed,
  variant: string,
  signal: AbortSignal,
): Promise<ParseResult> {
  // v2 cache shape carries items + stats; bump prevents v1 array values
  // from being mistyped as the new struct after deploy. Old v1 entries
  // TTL-expire within 1h.
  const cacheKey = `rss:feed:v2:${variant}:${feed.url}`;

  try {
    const cached = await cachedFetchJson<ParseResult>(cacheKey, 3600, async () => {
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

    return cached ?? { items: [], parsedTotal: 0, droppedUndated: 0 };
  } catch {
    return { items: [], parsedTotal: 0, droppedUndated: 0 };
  }
}

// Date-tag priority lists. RSS feeds typically carry <pubDate>; Atom carries
// <published>/<updated>; ArXiv (and other Dublin Core dialects) carry <dc:date>
// or <dc:Date.Issued>; some hybrid feeds emit RSS-shaped items with Atom-style
// date tags. First non-empty hit wins.
const DATE_TAG_PRIORITY = {
  rss: ['pubDate', 'dc:date', 'dc:Date.Issued', 'published'] as const,
  atom: ['published', 'updated', 'dc:date', 'dc:Date.Issued'] as const,
};

// Future-dated guard: items > 1h ahead of now are clock-skew or malformed.
const FUTURE_DATE_TOLERANCE_MS = 60 * 60 * 1000;

function extractFirstDateTag(block: string, isAtom: boolean): string {
  const tags = isAtom ? DATE_TAG_PRIORITY.atom : DATE_TAG_PRIORITY.rss;
  for (const tag of tags) {
    const value = extractTag(block, tag);
    if (value) return value;
  }
  return '';
}

function parseRssXml(xml: string, feed: ServerFeed, variant: string): ParseResult | null {
  const items: ParsedItem[] = [];
  let parsedTotal = 0;
  let droppedUndated = 0;

  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  let matches = [...xml.matchAll(itemRegex)];
  const isAtom = matches.length === 0;
  if (isAtom) matches = [...xml.matchAll(entryRegex)];

  for (const match of matches.slice(0, ITEMS_PER_FEED)) {
    const block = match[1]!;

    const title = extractTag(block, 'title');
    if (!title) continue;

    parsedTotal++;

    let link: string;
    if (isAtom) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/);
      link = hrefMatch?.[1] ?? '';
    } else {
      link = extractTag(block, 'link');
    }
    // Strip non-HTTP links (javascript:, data:, etc.) before any downstream use.
    if (!/^https?:\/\//i.test(link)) link = '';

    // Strict date gate (R2): walk the dialect-specific tag priority list and
    // require at least one non-empty, parseable, non-future timestamp. Items
    // that fail the gate are dropped — never silently stamped with Date.now()
    // (which is the bug that let static institutional pages reach the brief).
    const pubDateStr = extractFirstDateTag(block, isAtom);
    if (!pubDateStr) {
      droppedUndated++;
      continue;
    }
    const parsedDate = new Date(pubDateStr);
    const parsedMs = parsedDate.getTime();
    if (Number.isNaN(parsedMs)) {
      droppedUndated++;
      continue;
    }
    if (parsedMs > Date.now() + FUTURE_DATE_TOLERANCE_MS) {
      droppedUndated++;
      continue;
    }
    const publishedAt = parsedMs;

    const threat = classifyByKeyword(title, variant);
    const isAlert = threat.level === 'critical' || threat.level === 'high';
    const description = extractDescription(block, isAtom, title);

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
      lang: feed.lang ?? 'en',
      description,
    });
  }

  // Per-feed structured WARN when every parsed item was dropped for missing
  // dates. Distinguishable from a genuinely empty feed (parsedTotal === 0)
  // by the keyword `FEED_HEALTH_WARNING all-undated` — log aggregation can
  // grep for it. Defers a Redis-backed health-key wiring to a follow-up;
  // see the linked plan.
  if (parsedTotal > 0 && items.length === 0 && droppedUndated > 0) {
    console.warn(
      `[digest] FEED_HEALTH_WARNING all-undated feed="${feed.name}" ` +
        `variant=${variant} parsed=${parsedTotal} dropped=${droppedUndated}`,
    );
  } else if (droppedUndated > 0) {
    console.warn(
      `[digest] partial-undated feed="${feed.name}" variant=${variant} ` +
        `parsed=${parsedTotal} dropped=${droppedUndated} kept=${items.length}`,
    );
  }

  // Two cases:
  //
  // (a) parsedTotal > 0 — we recognized at least one <item>/<entry> block in
  //     the XML, so the stats are meaningful (whether all dropped, partially
  //     dropped, or none dropped). Return the struct so cachedFetchJson
  //     positive-caches it for the full TTL and the 'all-undated' branch in
  //     buildDigest's caller can fire (parsedTotal>0 ∧ items=[] ∧ dropped>0).
  //
  // (b) parsedTotal === 0 — the XML body had no recognizable items at all.
  //     This covers genuinely empty feeds (channel exists, no items),
  //     malformed XML responses, transient block pages, and Cloudflare
  //     interstitials that don't match the item/entry regexes. Return null
  //     so cachedFetchJson writes NEG_SENTINEL with the short negativeTtl
  //     (default 120s) — the feed retries quickly instead of being pinned
  //     empty for the full 3600s TTL.
  if (parsedTotal === 0) return null;
  return { items, parsedTotal, droppedUndated };
}

/**
 * Raw-body extractor for HTML-carrying tags (description, content:encoded,
 * summary, content). Non-greedy `[\s\S]*?` captures the full tag body including
 * nested markup; the CDATA end is anchored to the closing tag so internal `]]>`
 * sequences followed by more content do not truncate the match prematurely.
 * Returns the raw content without entity decoding — caller strips HTML and
 * decodes entities via `decodeXmlEntities`.
 */
const DESCRIPTION_TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();

function extractRawTagBody(xml: string, tag: string): string {
  let cached = DESCRIPTION_TAG_REGEX_CACHE.get(tag);
  if (!cached) {
    cached = {
      cdata: new RegExp(
        `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
        'i',
      ),
      plain: new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
    };
    DESCRIPTION_TAG_REGEX_CACHE.set(tag, cached);
  }
  const cdataMatch = xml.match(cached.cdata);
  if (cdataMatch) return cdataMatch[1] ?? '';

  const match = xml.match(cached.plain);
  return match ? match[1] ?? '' : '';
}

function normalizeForDescriptionEquality(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract + clean the article description/summary for an RSS `<item>` or Atom
 * `<entry>` block. Picks the LONGEST non-empty candidate across the dialect's
 * tag priority list after HTML-strip + entity-decode + whitespace-normalise.
 * Returns '' when the best candidate is empty, shorter than
 * MIN_DESCRIPTION_LEN, or normalises-equal to the headline — in those cases
 * downstream consumers must fall back to the cleaned headline (R6).
 */
function extractDescription(block: string, isAtom: boolean, title: string): string {
  const tags = isAtom ? DESCRIPTION_TAG_PRIORITY.atom : DESCRIPTION_TAG_PRIORITY.rss;

  let best = '';
  for (const tag of tags) {
    const raw = extractRawTagBody(block, tag);
    if (!raw) continue;
    const cleaned = decodeXmlEntities(raw)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length > best.length) best = cleaned;
  }

  if (best.length === 0) return '';
  if (best.length < MIN_DESCRIPTION_LEN) return '';
  if (normalizeForDescriptionEquality(best) === normalizeForDescriptionEquality(title)) return '';

  return best.slice(0, MAX_DESCRIPTION_LEN);
}

const TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();
const KNOWN_TAGS = [
  'title',
  'link',
  'pubDate',
  'published',
  'updated',
  // Dublin Core date dialects (ArXiv and similar feeds publish via these
  // instead of <pubDate>). Pre-caching their regexes mirrors the perf
  // pattern used for other hot-path tags.
  'dc:date',
  'dc:Date.Issued',
] as const;
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
    const key = `classify:sebuf:v3:${hash}`;
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
    // Strip source attribution suffixes ("- Reuters", "- reuters.com", etc.)
    // so the same story from different domains hashes identically.
    .replace(/\s*[-\u2013\u2014]\s*[\w\s.]+\.(?:com|org|net|co\.uk)\s*$/, '')
    .replace(/\s*[-\u2013\u2014]\s*(?:reuters|ap news|bbc|cnn|al jazeera|france 24|dw news|pbs newshour|cbs news|nbc|abc|associated press|the guardian|nos nieuws|tagesschau|cnbc|the national)\s*$/, '')
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
    snippet: item.description ?? '',
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

/**
 * Build the HSET field list for a story:track:v1 row.
 *
 * Description is written UNCONDITIONALLY (empty string when the current
 * mention has no body). Rationale: story:track rows are collapsed by
 * normalized-title hash, so multiple wire reports of the same event share a
 * row. If we only wrote description when non-empty, an earlier mention's
 * body would persist on subsequent body-less mentions for up to STORY_TTL
 * (7 days), and consumers would unknowingly ground LLMs on "some mention's
 * body" rather than "this mention's body" — violating the grounding
 * contract advertised to brief / whyMatters / SummarizeArticle. Writing
 * empty is the authoritative signal that the current mention has no body;
 * consumers then fall back to the cleaned headline (R6) honestly, and the
 * next mention with a body re-populates the field naturally.
 */
function buildStoryTrackHsetFields(
  item: ParsedItem,
  nowStr: string,
  score: number,
): Array<string | number> {
  return [
    'lastSeen', nowStr,
    'currentScore', score,
    'title', item.title,
    'link', item.link,
    'severity', item.level,
    'lang', item.lang,
    'description', item.description ?? '',
  ];
}

async function writeStoryTracking(items: ParsedItem[], variant: string, lang: string, hashes: string[]): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();
  const accKey = DIGEST_ACCUMULATOR_KEY(variant, lang);

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

      const hsetFields = buildStoryTrackHsetFields(item, nowStr, score);

      commands.push(
        ['HINCRBY', trackKey, 'mentionCount', '1'],
        ['HSET', trackKey, ...hsetFields],
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
          const result = await fetchAndParseRss(feed, variant, deadlineController.signal);
          completedFeeds.add(feed.name);
          // Classify per-feed status. 'all-undated' is the silent-zeroing
          // failure mode (every parsed item dropped for missing/unparseable
          // dates) — distinguished from a genuinely empty fetch ('empty')
          // so log aggregation can keyword-match. 'partial-undated' is
          // informational (some items dropped, some kept).
          if (result.parsedTotal > 0 && result.items.length === 0 && result.droppedUndated > 0) {
            feedStatuses[feed.name] = 'all-undated';
          } else if (result.items.length === 0) {
            feedStatuses[feed.name] = 'empty';
          } else if (result.droppedUndated > 0) {
            feedStatuses[feed.name] = 'partial-undated';
          }
          return { category, items: result.items };
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

    // U3 — hard freshness floor. Drop items older than NEWS_MAX_AGE_HOURS
    // (default 48h) BEFORE corroboration counting so a stale duplicate of a
    // fresh story can't inflate the cluster's source count. Runs after parse
    // (where U2 already dropped undated items) so every item here carries a
    // real publishedAt. See R3.
    const maxAgeMs = resolveMaxAgeMs();
    const freshnessCutoff = Date.now() - maxAgeMs;
    let droppedStaleTotal = 0;
    for (const [category, items] of results) {
      const fresh = items.filter((it) => it.publishedAt >= freshnessCutoff);
      droppedStaleTotal += items.length - fresh.length;
      results.set(category, fresh);
    }
    if (droppedStaleTotal > 0) {
      console.warn(
        `[digest] freshness floor dropped ${droppedStaleTotal} stale items ` +
          `(max age: ${maxAgeMs / (60 * 60 * 1000)}h)`,
      );
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
    await writeStoryTracking(allSliced, variant, lang, titleHashes).catch((err: unknown) =>
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

/** Internal exports for unit tests only — do not import in production code. */
export const __testing__ = {
  parseRssXml,
  extractDescription,
  extractRawTagBody,
  extractFirstDateTag,
  buildStoryTrackHsetFields,
  resolveMaxAgeMs,
  MAX_DESCRIPTION_LEN,
  MIN_DESCRIPTION_LEN,
  FUTURE_DATE_TOLERANCE_MS,
};
