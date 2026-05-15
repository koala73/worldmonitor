/**
 * v6 RSS normalizer — fetches feeds, parses items, extracts image URLs.
 *
 * # Why a separate normalizer instead of reusing v1's
 *
 * The v1 `buildBaseDigest` does too much: it dedups, age-filters, and
 * injects AI World Brief items. v6 wants the raw stream of parsed items
 * so the clustering layer can decide what to keep. We also need image
 * URLs, which v1 doesn't extract (it was never a wire field on
 * `LiveNewsItem`).
 *
 * Source list + per-feed cache are reused from v1.
 */

import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';
import { V6_NEWS_SOURCES, type NewsSource, ITEMS_PER_FEED, MAX_AGE_MS } from './_sources';

/** Per-feed cache TTL — 10 min, same as the legacy v1 pipeline. */
const PER_FEED_TTL_S = 10 * 60;
/** Shorter TTL when the fetch fails so a transient outlet outage
 *  recovers within ~2 min instead of waiting for the regular cache
 *  expiry. */
const PER_FEED_NEG_TTL_S = 2 * 60;

/**
 * Raw item we extract from a feed. Same shape used through clustering;
 * the orchestrator may add enrichment-derived fields later when it
 * writes to the digest.
 */
export interface RawRssItem {
  source: string;          // outlet name (e.g. "Al Jazeera")
  sourceUrl: string;       // feed url
  sourcePriority: number;  // 1 = wires, higher = analysis
  title: string;
  link: string;
  publishedAt: number;     // ms epoch
  /** Raw RSS description, HTML stripped + collapsed. Used by clustering
   *  (input to embedder) and as the wire `summary` field after clustering
   *  picks the longest one across cluster members. */
  description: string;
  /** First image URL found anywhere in the item's RSS body
   *  (media:thumbnail / media:content / enclosure / <img src=...>). */
  imageUrl: string | null;
  /** SHA-256 of normalized title — kept compatible with v1 caches so
   *  embedding/dedup decisions can be reused across pipelines. */
  titleHash: string;
}

export interface NormalizeResult {
  items: RawRssItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
}

// ── RSS parsing helpers ──────────────────────────────────────────────

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[^>]*>.*?<\/script>/gis, ' ')
    .replace(/<style[^>]*>.*?<\/style>/gis, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(item: string, tag: string): string {
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i');
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const cd = item.match(cdataRe);
  if (cd) return cd[1]!.trim();
  const m = item.match(plainRe);
  return m ? decodeXmlEntities(m[1]!.trim()) : '';
}

/**
 * Try every common RSS image source and return the first valid one.
 *
 *   1. <media:thumbnail url="…"/>
 *   2. <media:content url="…" type="image/*"/>
 *   3. <enclosure url="…" type="image/*"/>
 *   4. <img src="…"> inside description/content
 */
function extractImage(item: string, descriptionRaw: string): string | null {
  const tryPatterns: RegExp[] = [
    /<media:thumbnail[^>]+url=["']([^"']+)["']/i,
    /<media:content[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i,
    /<media:content[^>]+type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i,
    /<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i,
    /<enclosure[^>]+type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i,
  ];
  for (const re of tryPatterns) {
    const m = item.match(re);
    if (m && /^https?:\/\//i.test(m[1]!)) return m[1]!;
  }
  // Inline <img src="..."> in the description body
  const imgInDesc = descriptionRaw.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgInDesc && /^https?:\/\//i.test(imgInDesc[1]!)) return imgInDesc[1]!;
  return null;
}

function parseDate(s: string): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

async function parseFeed(xml: string, src: NewsSource): Promise<RawRssItem[]> {
  // Match either RSS <item> or Atom <entry>
  const itemRe = /<(item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  const out: RawRssItem[] = [];
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = itemRe.exec(xml)) !== null) {
    if (count >= ITEMS_PER_FEED) break;
    const item = m[2]!;

    const title = stripHtml(extractTag(item, 'title'));
    if (!title) continue;

    // Atom uses <link href="…"/>; RSS uses <link>…</link>
    let link = extractTag(item, 'link');
    if (!link) {
      const atomLink = item.match(/<link[^>]+href=["']([^"']+)["']/i);
      link = atomLink ? atomLink[1]! : '';
    }
    if (!link) continue;

    // Prefer content:encoded > description > summary > content
    const descRaw =
      extractTag(item, 'content:encoded') ||
      extractTag(item, 'description') ||
      extractTag(item, 'summary') ||
      extractTag(item, 'content');
    const description = stripHtml(descRaw);

    const imageUrl = extractImage(item, descRaw);

    const pubStr =
      extractTag(item, 'pubDate') ||
      extractTag(item, 'published') ||
      extractTag(item, 'updated') ||
      extractTag(item, 'dc:date');
    const publishedAt = parseDate(pubStr);
    if (publishedAt === 0) continue;

    const titleHash = await sha256Hex(normalizeTitle(title));

    out.push({
      source: src.name,
      sourceUrl: src.url,
      sourcePriority: src.priority,
      title,
      link,
      publishedAt,
      description,
      imageUrl,
      titleHash,
    });
    count++;
  }
  return out;
}

async function fetchFeedWithCache(src: NewsSource, signal: AbortSignal): Promise<RawRssItem[]> {
  // Per-feed cache lives in the v6 namespace so v1's existing cache isn't
  // shadowed (different shape — v6 has imageUrl, v1 doesn't).
  const cacheKey = `live-news:v6:rss:${src.url}`;
  const cached = (await getCachedJson(cacheKey)) as RawRssItem[] | null;
  if (Array.isArray(cached)) return cached;

  try {
    const resp = await fetch(src.url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (worldmonitor-bot/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      // Per-feed timeout — Edge handlers cap on the AbortSignal we hand
      // them, so this is mostly belt-and-suspenders.
    });
    if (!resp.ok) {
      console.warn(`[live-news:v6:fetch] ${src.name} → HTTP ${resp.status}`);
      await setCachedJson(cacheKey, [], PER_FEED_NEG_TTL_S);
      return [];
    }
    const xml = await resp.text();
    if (xml.length < 100) {
      await setCachedJson(cacheKey, [], PER_FEED_NEG_TTL_S);
      return [];
    }
    const items = await parseFeed(xml, src);
    // 0-item parses get the short negative TTL so an empty result
    // (publisher emptied the channel, Vercel egress served a sparse
    // response, etc.) retries within 2 min instead of locking the
    // feed out for the full 10 min positive cache window.
    const ttl = items.length > 0 ? PER_FEED_TTL_S : PER_FEED_NEG_TTL_S;
    await setCachedJson(cacheKey, items, ttl);
    return items;
  } catch (err) {
    console.warn(`[live-news:v6:fetch] ${src.name} threw:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fan out across all configured feeds in parallel. Returns per-feed
 * status so callers can surface health diagnostics. Items are
 * age-filtered against MAX_AGE_MS (14 days, same as v1).
 */
export async function fetchAllFeeds(signal: AbortSignal): Promise<NormalizeResult> {
  const cutoff = Date.now() - MAX_AGE_MS;
  const results = await Promise.allSettled(
    V6_NEWS_SOURCES.map((src) => fetchFeedWithCache(src, signal)),
  );

  const items: RawRssItem[] = [];
  const feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'> = {};

  results.forEach((r, i) => {
    const src = V6_NEWS_SOURCES[i]!;
    if (r.status === 'rejected') {
      feedStatuses[src.name] = 'timeout';
      return;
    }
    const arr = r.value.filter((it) => it.publishedAt >= cutoff);
    feedStatuses[src.name] = arr.length > 0 ? 'ok' : 'empty';
    items.push(...arr);
  });

  return { items, feedStatuses };
}
