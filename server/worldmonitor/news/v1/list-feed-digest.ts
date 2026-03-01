import type {
  ServerContext,
  ListFeedDigestRequest,
  ListFeedDigestResponse,
  CategoryBucket,
  NewsItem as ProtoNewsItem,
  ThreatLevel as ProtoThreatLevel,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { VARIANT_FEEDS, INTEL_SOURCES, type ServerFeed } from './_feeds';
import { classifyByKeyword, type ThreatLevel } from './_classifier';

declare const process: { env: Record<string, string | undefined> };

const VALID_VARIANTS = new Set(['full', 'tech', 'finance', 'happy']);
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

interface ParsedItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  level: ThreatLevel;
  category: string;
  confidence: number;
  classSource: 'keyword';
}

async function fetchAndParseRss(
  feed: ServerFeed,
  variant: string,
  signal: AbortSignal,
): Promise<ParsedItem[]> {
  const cacheKey = `rss:feed:v1:${feed.url}`;

  try {
    const cached = await cachedFetchJson<ParsedItem[]>(cacheKey, 600, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        const resp = await fetch(feed.url, {
          headers: {
            'User-Agent': CHROME_UA,
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: controller.signal,
        });
        if (!resp.ok) return null;

        const text = await resp.text();
        return parseRssXml(text, feed, variant);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      }
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

function toProtoItem(item: ParsedItem): ProtoNewsItem {
  return {
    source: item.source,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    isAlert: item.isAlert,
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
  _ctx: ServerContext,
  req: ListFeedDigestRequest,
): Promise<ListFeedDigestResponse> {
  const variant = VALID_VARIANTS.has(req.variant) ? req.variant : 'full';
  const lang = req.lang || 'en';

  const digestCacheKey = `news:digest:v1:${variant}:${lang}`;

  try {
    const cached = await cachedFetchJson<ListFeedDigestResponse>(digestCacheKey, 900, async () => {
      return buildDigest(variant, lang);
    });
    return cached ?? { categories: {}, feedStatuses: {}, generatedAt: new Date().toISOString() };
  } catch {
    return { categories: {}, feedStatuses: {}, generatedAt: new Date().toISOString() };
  }
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

    for (let i = 0; i < allEntries.length; i += BATCH_CONCURRENCY) {
      if (deadlineController.signal.aborted) break;

      const batch = allEntries.slice(i, i + BATCH_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ category, feed }) => {
          const items = await fetchAndParseRss(feed, variant, deadlineController.signal);
          feedStatuses[feed.name] = items.length > 0 ? 'ok' : 'empty';
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
      if (!(entry.feed.name in feedStatuses)) {
        feedStatuses[entry.feed.name] = 'timeout';
      }
    }

    for (const [category, items] of results) {
      items.sort((a, b) => b.publishedAt - a.publishedAt);
      categories[category] = {
        items: items.slice(0, MAX_ITEMS_PER_CATEGORY).map(toProtoItem),
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
