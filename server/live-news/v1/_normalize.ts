/**
 * RSS fetch → parse → dedupe → age-filter → digest item shape.
 *
 * Mirrors the regex-based parser used by `list-feed-digest.ts` so we don't
 * pull in a heavyweight XML library. The trade-off: weird RSS dialects can
 * slip through with empty fields, but the same parser has worked across
 * 300+ feeds in production.
 */

import { US_NEWS_SOURCES, ITEMS_PER_FEED, MAX_ITEMS, MAX_AGE_MS, type NewsSource } from './_sources';
import { detectBreaking } from './_breaking';
import { CHROME_UA } from '../../_shared/constants';
import { cachedFetchJson, getCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';

const FEED_TIMEOUT_MS = 8_000;
const PER_FEED_TTL_S = 600; // 10 min RSS cache — RSS rarely updates faster

/** Output shape — designed to decode into the iOS `NewsItem` model verbatim. */
export interface LiveNewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;     // ms since epoch
  isAlert: boolean;
  /** SHA-256 of normalized title — used as the cache key for both location
   *  and paraphrase LLM enrichments. */
  titleHash: string;
  /** Filled in by the location-enrichment step; absent on first poll. */
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  /** LLM confidence 0..1 (only meaningful when location is non-null). */
  confidence: number | null;
  /** Optional ISO country code from the LLM. Useful for client-side filtering. */
  country: string | null;
  /**
   * 8-region taxonomy code (`"us"`, `"middle_east"`, etc.) derived from
   * `country` during enrichment. Optional — items still in the legacy
   * country-only enrichment path won't have it; iOS falls back to the
   * country-code → region mapping in that case.
   */
  region?: string;
  /** Neutral 2–3 sentence summary written by the paraphrase LLM. Null when
   *  enrichment hasn't run yet, or when the LLM declined to summarize
   *  (sparse RSS description, paywalled story, etc.). iOS falls back to
   *  the source web view when null. */
  summary: string | null;
  /**
   * Internal-only — RSS description/excerpt forwarded to the paraphrase LLM
   * as the source material. Strip-tagged plain text. Not displayed in the
   * iOS UI; the LLM's `summary` is the user-visible output. We expose it
   * on the wire so any future tooling can re-summarize from the same source.
   */
  rawDescription: string | null;
  /**
   * True when the LLM enrichment classified this story as an active
   * armed-conflict event. iOS uses this to:
   *   1. Surface the item under the CONFLICT chip in the feed.
   *   2. Add it to the conflict-pin layer on the map (lat/lng come
   *      from the same enrichment call).
   * Null while enrichment hasn't run yet — iOS treats null/false the
   * same way (item doesn't appear under CONFLICT until classified).
   */
  isConflict: boolean | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML parsing — regex-based, mirrors list-feed-digest.ts
// ─────────────────────────────────────────────────────────────────────────────

const TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();
for (const tag of ['title', 'link', 'pubDate', 'published', 'updated', 'description', 'summary', 'content', 'dc:date']) {
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
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-feed fetch + parse (with Redis caching)
// ─────────────────────────────────────────────────────────────────────────────

interface RawItem {
  source: string;
  /** Lower number = more authoritative; used for dedup tie-breaks. */
  sourcePriority: number;
  title: string;
  link: string;
  publishedAt: number;
  /** RSS `<description>` or Atom `<summary>` / `<content>` — HTML stripped. */
  rawDescription: string;
}

/**
 * Crude HTML-tag stripper for RSS description content.
 * Many feeds embed `<p>`, `<a>`, `<img>`, etc. inside their descriptions;
 * we don't want to send that to the LLM (wastes tokens, distracts the model).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchRssText(url: string, signal: AbortSignal): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function parseFeed(xml: string, source: NewsSource): RawItem[] {
  const items: RawItem[] = [];
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
    if (!link) continue;

    // Date extraction — try every known tag variant in order. Different
    // feed formats use different conventions:
    //   - RSS 2.0: `<pubDate>`
    //   - RDF (RSS 1.0 — Deutsche Welle, some others): `<dc:date>`
    //   - Atom: `<published>` / `<updated>`
    //   - Some feeds also expose `<dc:date>` even in RSS 2.0
    // Without the dc:date fallback, Deutsche Welle items would parse to
    // publishedAt=0 and sink to the bottom of the digest — effectively
    // disappearing under the MAX_ITEMS cap.
    const pubStr = isAtom
      ? (extractTag(block, 'published') || extractTag(block, 'updated') || extractTag(block, 'dc:date'))
      : (extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'published'));
    let publishedAt = 0;
    if (pubStr) {
      const parsed = new Date(pubStr);
      if (!Number.isNaN(parsed.getTime())) {
        publishedAt = parsed.getTime();
      }
    }

    // Pull RSS description / Atom summary / RSS 2.0 content:encoded.
    // Different feeds use different tags; we take whichever is longest.
    const candidates = [
      extractTag(block, 'description'),
      extractTag(block, 'summary'),
      extractTag(block, 'content'),
    ].map(stripHtml).filter((s) => s.length > 0);
    const rawDescription = candidates.sort((a, b) => b.length - a.length)[0] ?? '';

    items.push({
      source: source.name,
      sourcePriority: source.priority,
      title,
      link,
      publishedAt,
      rawDescription,
    });
  }

  return items;
}

async function fetchSourceWithCache(source: NewsSource, signal: AbortSignal): Promise<RawItem[]> {
  const cacheKey = `live-news:rss:v1:${source.url}`;
  try {
    const items = await cachedFetchJson<{ items: RawItem[] }>(
      cacheKey,
      PER_FEED_TTL_S,
      async () => {
        const xml = await fetchRssText(source.url, signal);
        if (!xml) return null;
        const parsed = parseFeed(xml, source);
        if (parsed.length === 0) return null;
        return { items: parsed };
      },
      120, // negative TTL — short so sources self-heal quickly
    );
    return items?.items ?? [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Title fingerprinting (dedup + LLM cache key)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common headline noise that obscures dedup. Each pattern is anchored to
 * the start of the (already-lowercased) title because outlet-branding
 * prefixes virtually always appear there.
 */
const HEADLINE_NOISE_PATTERNS: readonly RegExp[] = [
  /^breaking[:\-\s]+/i,
  /^live[:\-\s]+/i,
  /^update[:\-\s]+/i,
  /^updated[:\-\s]+/i,
  /^developing[:\-\s]+/i,
  /^exclusive[:\-\s]+/i,
  /^just\s+in[:\-\s]+/i,
  /^urgent[:\-\s]+/i,
  /^watch[:\-\s]+/i,
  /^opinion[:\-\s]+/i,
  /^analysis[:\-\s]+/i,
];

/**
 * Outlet branding suffixes — `" - BBC News"`, `" | Reuters"`, etc. We
 * strip everything from the first occurrence of these separators to the
 * end so headlines that re-broadcast the same wire story converge.
 */
const OUTLET_SEPARATOR_RE = /[\s]*[\-\|–—:][\s]*[A-Z][A-Za-z0-9'&\.]+(\s+[A-Z][A-Za-z0-9'&\.]+){0,4}\s*$/;

/**
 * Normalize a title for fingerprinting. Steps:
 *   1. Lowercase.
 *   2. Strip outlet-branding suffix (`" – Reuters"`, `" | NPR"`, etc.).
 *   3. Strip breaking/live/update prefixes (`"BREAKING: "`, `"LIVE — "`).
 *   4. Drop punctuation/symbols, collapse whitespace.
 *   5. Truncate to first 80 chars (most outlets share opening wording).
 *
 * The result is a stable fingerprint that catches near-identical wording
 * across outlets. Semantic-but-differently-worded duplicates still slip
 * through; those need LLM-based clustering (separate proposal).
 */
export function normalizeTitle(title: string): string {
  let s = title;
  // Strip outlet branding suffix BEFORE lowercasing so the regex can use
  // capitalization to anchor on outlet names (which are usually
  // PascalCase / TitleCase). A bare lowercased "- bbc" would match too
  // aggressively and chop real titles.
  s = s.replace(OUTLET_SEPARATOR_RE, '');
  s = s.toLowerCase();
  for (const pattern of HEADLINE_NOISE_PATTERNS) {
    s = s.replace(pattern, '');
  }
  return s
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** SHA-256 hex of normalized title — stable LLM-cache key. */
export async function titleHash(title: string): Promise<string> {
  return sha256Hex(normalizeTitle(title));
}

// ─────────────────────────────────────────────────────────────────────────────
// Brief top-stories injection
// ─────────────────────────────────────────────────────────────────────────────

/** Shape of one story in `news:insights:v1` written by `seed-insights.mjs`. */
interface BriefTopStory {
  primaryTitle?: string;
  primarySource?: string;
  primaryLink?: string;
  pubDate?: number;
  isAlert?: boolean;
}

interface BriefInsights {
  topStories?: BriefTopStory[];
}

/**
 * Read the AI World Brief's top stories from Redis and convert them into
 * `RawItem`s so they flow through the same dedup + enrichment pipeline as
 * RSS-sourced items. Solves iOS's "top story has no AI summary" problem:
 * the brief picks 8 daily headlines, some of which come from outlets that
 * aren't in our RSS list (so the summary cache never hit before).
 *
 * Priority 2 puts them in the "top broadcaster" tier — they win dedup
 * against analysis outlets (tier 3-4) but lose to wire services (tier 1)
 * for the same story, which is the right behavior. We never want to
 * displace Reuters/AP with whatever outlet the brief clustering picked.
 *
 * Soft-failing on every error path. If insights are missing, malformed,
 * or Redis is unreachable, this returns [] and the digest builds exactly
 * as before. The injection is strictly additive — no existing live-news
 * functionality depends on it.
 */
async function readBriefTopStoriesAsRawItems(): Promise<RawItem[]> {
  try {
    const insights = (await getCachedJson('news:insights:v1', true)) as BriefInsights | null;
    if (!insights?.topStories?.length) return [];

    const now = Date.now();
    const items: RawItem[] = [];
    for (const s of insights.topStories) {
      const title = (s.primaryTitle ?? '').trim();
      const link = (s.primaryLink ?? '').trim();
      // Reject anything missing the essentials — title + URL are required
      // for downstream dedup (titleHash) and the iOS detail view.
      if (!title || !link) continue;

      items.push({
        source: s.primarySource ?? 'World Brief',
        sourcePriority: 2,
        title,
        link,
        publishedAt: s.pubDate ?? now,
        // No RSS excerpt available for brief stories. The enrichment LLM
        // will summarize from the title alone — thinner than RSS-based
        // summaries but still useful. Body fetching can be layered in
        // later if quality proves insufficient.
        rawDescription: '',
      });
    }
    return items;
  } catch (err) {
    console.warn('[live-news] brief-top-stories injection failed (soft-fail):',
      err instanceof Error ? err.message : err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: build the digest (without LLM enrichment — that runs separately)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all sources, parse, dedupe, age-filter, and produce the base digest
 * with `location` left null. The enrichment step fills in `location`/etc.
 */
export async function buildBaseDigest(signal: AbortSignal): Promise<{
  items: LiveNewsItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
}> {
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;

  const settled = await Promise.allSettled(
    US_NEWS_SOURCES.map((src) => fetchSourceWithCache(src, signal)),
  );

  const feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'> = {};
  const allRaw: RawItem[] = [];

  settled.forEach((result, i) => {
    const src = US_NEWS_SOURCES[i]!;
    if (result.status === 'rejected') {
      feedStatuses[src.name] = 'timeout';
      return;
    }
    const arr = result.value;
    feedStatuses[src.name] = arr.length > 0 ? 'ok' : 'empty';
    allRaw.push(...arr);
  });

  // Inject AI World Brief top stories into the same pool. They flow
  // through dedup + enrichment exactly like RSS items — no parallel code
  // path. Soft-fails to [] on any error, so a broken brief cron can't
  // break live-news.
  const briefItems = await readBriefTopStoriesAsRawItems();
  if (briefItems.length > 0) {
    console.log(`[live-news] Injected ${briefItems.length} brief top-story items into the digest pool`);
    allRaw.push(...briefItems);
  }

  // Dedup by 80-char title fingerprint, picking the most authoritative
  // copy of each story. Tie-break order:
  //   1. Lower `sourcePriority` wins (1 = wires, beats 4 = analysis).
  //   2. Among same-priority, freshest `publishedAt` wins.
  // This makes Reuters/AP the canonical version when the same story is
  // also reported by BBC/Guardian/etc.
  const dedupMap = new Map<string, RawItem>();
  for (const item of allRaw) {
    const key = normalizeTitle(item.title);
    if (!key) continue; // skip items whose title normalizes to empty
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, item);
      continue;
    }
    const incomingWins =
      item.sourcePriority < existing.sourcePriority ||
      (item.sourcePriority === existing.sourcePriority && item.publishedAt > existing.publishedAt);
    if (incomingWins) {
      dedupMap.set(key, item);
    }
  }

  // Time-based filter: items WITH a publishedAt must fall within MAX_AGE_MS
  // of now. Items WITHOUT a publishedAt are kept (sorted to the bottom)
  // — many feeds still emit valuable stories with malformed/missing dates,
  // and the global MAX_ITEMS cap prevents these from drowning the digest.
  const fresh = [...dedupMap.values()].filter((it) => {
    if (it.publishedAt > 0) {
      return it.publishedAt >= cutoff;
    }
    return true;
  });

  fresh.sort((a, b) => b.publishedAt - a.publishedAt);
  const top = fresh.slice(0, MAX_ITEMS);

  // Assemble the digest items in parallel — `titleHash` is async (Web Crypto).
  const items: LiveNewsItem[] = await Promise.all(
    top.map(async (it) => {
      const breaking = detectBreaking(it.title, it.publishedAt, now);
      // Cap rawDescription so a single chatty feed doesn't blow our LLM
      // context budget. 1200 chars ≈ 300 tokens — enough to summarize from.
      const cappedDescription = it.rawDescription.length > 1200
        ? it.rawDescription.slice(0, 1200) + '…'
        : it.rawDescription;
      return {
        source: it.source,
        title: it.title,
        link: it.link,
        publishedAt: it.publishedAt,
        isAlert: breaking.isAlert,
        titleHash: await titleHash(it.title),
        location: null,
        locationName: null,
        confidence: null,
        country: null,
        summary: null,
        rawDescription: cappedDescription || null,
        isConflict: null,            // populated by attachCachedEnrichment
      };
    }),
  );

  return { items, feedStatuses };
}
