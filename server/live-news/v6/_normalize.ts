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
 *
 * # Why `description` and `body` are split
 *
 * Many RSS feeds emit BOTH:
 *   • `<description>` — a short publisher-written lede (100-400 chars),
 *     intended to be the headline summary readers see in a reader app.
 *   • `<content:encoded>` — the full article body (5-40+ KB), which is
 *     effectively the article-behind-the-link.
 *
 * The user-facing summary we ship on the wire should come from the brief
 * `description` field — that's what the publisher intended as a summary.
 * Showing the full article body would be functionally the same as
 * scraping the article URL: "from within the links", not "from the
 * articles in the RSS feed".
 *
 * For clustering input, we want the richer text — more semantic signal
 * for the embedder. So we keep both around. The cache cost is bounded
 * by capping body length on read (`MAX_BODY_LEN`).
 */
/** A single outlet's coverage of a GDELT conflict candidate. Structurally
 *  identical to `_cluster.ts`'s `ClusterSource` — defined here to avoid a
 *  circular import. */
export interface GdeltSourceEntry {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/** GKG-derived incident location carried by a GDELT clustering item. */
export interface GdeltItemLocation {
  latitude: number;
  longitude: number;
  country: string | null;
  locationName: string | null;
}

export interface RawRssItem {
  source: string;          // outlet name (e.g. "Al Jazeera")
  sourceUrl: string;       // feed url
  sourcePriority: number;  // 1 = wires, higher = analysis
  title: string;
  link: string;
  publishedAt: number;     // ms epoch
  /** Brief publisher-supplied lede — pulled from `<description>` (RSS)
   *  or `<summary>` (Atom) ONLY. Never the full article body. This is
   *  what surfaces as the wire `summary` on the v6 digest. May be empty
   *  for feeds that don't emit a brief field. */
  description: string;
  /** Richer text used as clustering input — `<content:encoded>` or
   *  `<content>` if the feed supplies them, otherwise the brief
   *  description. Capped at MAX_BODY_LEN to keep cache sane; the
   *  embedder only sees the first 300 chars anyway. Never appears on
   *  the user-facing wire. */
  body: string;
  /** First image URL found anywhere in the item's RSS body
   *  (media:thumbnail / media:content / enclosure / <img src=...>). */
  imageUrl: string | null;
  /** Photo credit that accompanied `imageUrl` in the feed's media block
   *  — `<media:credit>`, `<media:copyright>`, or a `credit="…"` attribute.
   *  null when the feed supplied no separate image attribution. */
  imageCredit: string | null;
  /** SHA-256 of normalized title — kept compatible with v1 caches so
   *  embedding/dedup decisions can be reused across pipelines. */
  titleHash: string;
  /**
   * Which pipeline this item came from.
   *   'rss'   — a parsed RSS feed item (the default; has content).
   *   'gdelt' — a GDELT conflict candidate used purely as clustering
   *             corroboration. Never canonical, never displayed as
   *             content, never article-fetched, never sent to an LLM.
   */
  origin: 'rss' | 'gdelt';
  /** GDELT-only: GKG-parsed incident location. The cluster adopts this
   *  (mode across GDELT members) when no RSS-derived location exists. */
  gdeltLocation?: GdeltItemLocation | null;
  /** GDELT-only: every outlet that ran this story, per GKG. These are
   *  appended below the RSS sources in the cluster's `sources[]`. */
  gdeltSources?: GdeltSourceEntry[];
  /** GDELT-only: intel-topic ids this story's headline keyword-matched
   *  (cyber, military, …). The cluster unions these across its GDELT
   *  members into `ClusteredItem.categories`. Absent on conflict
   *  candidates and RSS items. */
  gdeltCategories?: string[];
  /** GDELT-only: cleaned GKG entity/theme tokens (named entities + top
   *  themes), folded into the embed input by `inputTextFor` to strengthen
   *  GDELT clustering vectors. Embedding-only — never displayed, never
   *  article-fetched, never sent to an LLM. */
  gdeltEntities?: string;
}

/** Cap on the cached `body` field. The embedder only ingests the first
 *  300 chars in inputTextFor, so 800 gives us headroom for any future
 *  use (e.g. first-paragraph fallback) without bloating per-feed cache. */
const MAX_BODY_LEN = 800;

export interface NormalizeResult {
  items: RawRssItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
}

// ── RSS parsing helpers ──────────────────────────────────────────────

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Compute the v6 title hash — sha256 of the normalized title. Exported
 * so other pipelines (e.g. GDELT conflict candidates) can hash titles
 * with the EXACT same function, keeping the embedding cache and
 * cross-origin dedup consistent. A GDELT item and an RSS item for the
 * same headline must produce the same titleHash.
 */
export async function titleHashFor(title: string): Promise<string> {
  return sha256Hex(normalizeTitle(title));
}

/**
 * Decode XML/HTML entities. The named-entity coverage matters for the
 * embedder: leaving `&ndash;` / `&mdash;` / `&rsquo;` as literal text
 * makes the same headline embed differently when one outlet uses
 * `&#8211;` (numeric) and another uses `&ndash;` (named), perturbing
 * cosine similarity unnecessarily.
 *
 * Order matters: named non-amp entities first, then `&amp;`, then
 * numeric. Putting `&amp;` before named entities would corrupt nested
 * cases like `&amp;ndash;` (which should stay as literal "&ndash;").
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Typography — common in news headlines
    .replace(/&ndash;/g, '–')   // –
    .replace(/&mdash;/g, '—')   // —
    .replace(/&hellip;/g, '…')  // …
    .replace(/&lsquo;/g, '‘')   // '
    .replace(/&rsquo;/g, '’')   // '
    .replace(/&ldquo;/g, '“')   // "
    .replace(/&rdquo;/g, '”')   // "
    .replace(/&laquo;/g, '«')   // «
    .replace(/&raquo;/g, '»')   // »
    .replace(/&bull;/g, '•')    // •
    .replace(/&middot;/g, '·')  // ·
    .replace(/&copy;/g, '©')    // ©
    .replace(/&reg;/g, '®')     // ®
    .replace(/&trade;/g, '™')   // ™
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

/**
 * Pull a photo credit / copyright line out of an item's media block.
 * Media RSS feeds (and many WordPress feeds) ship the image's own
 * attribution separately from the article byline — `<media:credit>`,
 * `<media:copyright>`, or a `credit="…"` attribute on the media tag.
 * Returns null when the feed gives no separate image attribution.
 */
function extractImageCredit(item: string): string | null {
  const fromTag = stripHtml(
    extractTag(item, 'media:credit') || extractTag(item, 'media:copyright'),
  ).trim();
  if (fromTag && fromTag.length <= 200) return fromTag;

  const attr = item.match(/<media:(?:content|thumbnail)\b[^>]*\scredit=["']([^"']+)["']/i);
  if (attr) {
    const txt = decodeXmlEntities(attr[1]!).trim();
    if (txt && txt.length <= 200) return txt;
  }
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

    // Split extraction:
    //   • description = brief publisher lede (<description> / Atom <summary>)
    //   • body = richer text used for clustering (<content:encoded> /
    //     <content>), falls back to the brief when no rich field exists
    // The wire summary is built from `description` only — never from
    // `body` — so we don't serve article-behind-the-link content to
    // users. Both come from the RSS feed; only their role differs.
    const briefRaw =
      extractTag(item, 'description') ||
      extractTag(item, 'summary');
    const richRaw =
      extractTag(item, 'content:encoded') ||
      extractTag(item, 'content');
    // Keep the publisher's trailing "…" / "Continue reading" markers on
    // `description` — the cluster summary picker (`pickSummary` in
    // _cluster.ts) needs them to tell a truncated lede from a full one,
    // so it can prefer a clean lede from another outlet in the same
    // cluster. It strips the marker off whatever it finally picks; if
    // every outlet truncated, it ends the chosen lede with a single "…".
    const description = stripHtml(briefRaw);
    const body = (stripHtml(richRaw) || description).slice(0, MAX_BODY_LEN);

    // For image extraction we want the richer source — content:encoded
    // tends to contain <img> tags inline; description often doesn't.
    const imageUrl = extractImage(item, richRaw || briefRaw);
    // Only look for a photo credit when we actually have an image.
    const imageCredit = imageUrl ? extractImageCredit(item) : null;

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
      body,
      imageUrl,
      imageCredit,
      titleHash,
      origin: 'rss',
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
