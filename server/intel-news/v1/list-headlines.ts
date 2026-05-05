/**
 * `GET /api/intel-news/v1/list-headlines` — handler core.
 *
 * On-demand GDELT digest. Six topics (cyber, military, nuclear, sanctions,
 * intelligence, maritime) are fetched in parallel from the GDELT 2.0 Doc API
 * and cached per-topic in Redis. Mirrors the ADSBExchange on-demand pattern
 * we use for military flights — no GitHub Actions cron.
 *
 * GDELT's per-IP rate limiting is handled by:
 *   • Per-topic cache (30 min) so concurrent client polls share a single
 *     upstream request.
 *   • cachedFetchJson coalescing — concurrent miss callers hit GDELT once.
 *   • Negative-result caching (2 min) so a 429 doesn't get retried until
 *     the cooldown elapses.
 *
 * Articles are normalized to the same shape as live-news items so the iOS
 * client can decode them with the existing `NewsItem` model.
 */

import { cachedFetchJson } from '../../_shared/redis';
import { keepAlive } from '../../_shared/keep-alive';
import { INTEL_TOPICS, type IntelTopic } from './_topics';
import { appendToArchive, type ConflictArchiveItem } from '../../conflict-archive/v1/_store';
import { enrichGdeltConflictAsync, attachGdeltEnrichment } from './_enrich-conflict';

// Per-topic cache freshness target: ~15 min, matching GDELT's own update
// cadence. We add 0–60 s of jitter at write-time so the 9 topics' caches
// don't all expire in the same second post-deploy and trigger a 9-parallel
// GDELT burst (the classic 429 trigger).
const PER_TOPIC_TTL_BASE_S = 15 * 60;
const PER_TOPIC_TTL_JITTER_S = 60;
function perTopicTtlSeconds(): number {
  return PER_TOPIC_TTL_BASE_S + Math.floor(Math.random() * PER_TOPIC_TTL_JITTER_S);
}

// 5 min — when GDELT returns 429 we wait longer before probing again.
// Aggressive retry doesn't help against rate-limit cool-downs and signals
// poor citizenship. The user-visible cost is "an old cache stays warm
// for an extra few minutes" which is fine.
const PER_TOPIC_NEG_TTL_S = 5 * 60;

// Stagger fan-out delay. When multiple topic caches miss simultaneously
// (e.g. post-deploy), this small per-topic delay turns 9-in-the-same-instant
// into 9-spread-over-~2-seconds, which GDELT's per-IP rate limiter handles
// without 429ing. Cold-start latency penalty: ~2 s for the slowest topic.
// Hot-cache requests pay zero — the delay only applies inside the fetcher,
// which only runs on cache miss.
const STAGGER_PER_TOPIC_MS = 250;

const TOP_LEVEL_TTL_S = 30;             // 30 s — same urgency tier as live-news
const FETCH_TIMEOUT_MS = 10_000;
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

interface GdeltArticle {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  socialimage?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
  tone?: string | number;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

/** One outlet's coverage of the same syndicated story. */
export interface IntelNewsAlternateSource {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/** Item shape — matches iOS NewsItem decoder. */
export interface IntelNewsItem {
  source: string;             // domain (e.g. "reuters.com")
  title: string;
  link: string;
  publishedAt: number;        // ms since epoch
  isAlert: boolean;
  /** Topic id — used by iOS chips to filter. */
  topic: string;
  /** Tone score from GDELT, when present (typically -10..+10). */
  tone: number | null;
  /**
   * All outlets reporting the same headline, populated by within-topic
   * title dedup. Always includes the canonical (sources[0] === rep)
   * when present. Empty when the item has no detected duplicates —
   * matches the v2 live-news convention.
   */
  sources?: IntelNewsAlternateSource[];
}

export interface IntelNewsTopicBucket {
  id: string;
  label: string;
  items: IntelNewsItem[];
  fetchedAt: number;
  /** When the upstream call failed and we returned a stale cached value. */
  stale?: boolean;
}

export interface ListIntelNewsResponse {
  topics: IntelNewsTopicBucket[];
  generatedAt: string;
}

/** GDELT seendate is `YYYYMMDDTHHMMSSZ`. Convert to ms-since-epoch. */
function parseGdeltDate(s: string | undefined): number {
  if (!s || s.length < 14) return 0;
  // Example: "20260504T123045Z"
  const yr = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const dy = s.slice(6, 8);
  const hh = s.slice(9, 11);
  const mm = s.slice(11, 13);
  const ss = s.slice(13, 15);
  const iso = `${yr}-${mo}-${dy}T${hh}:${mm}:${ss}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalize a headline for dedup grouping.
 *
 * GDELT republishes wire stories (AP, Reuters, AFP, etc.) across many
 * outlets verbatim, so the same headline shows up under one topic many
 * times. Group by:
 *   - Lower-case
 *   - Strip non-alphanumeric Unicode (commas, dashes, smart quotes, etc.)
 *   - Collapse whitespace
 *
 * This catches wire-syndicated duplicates without false-grouping similar
 * but distinct stories — different events with different headlines stay
 * separate. We deliberately don't do fuzzy matching; LLM-driven
 * semantic dedup (like live-news v2's classifier) is overkill for the
 * intel digest where the duplicate signal is exact-string.
 */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTopicArticles(topic: IntelTopic): Promise<IntelNewsTopicBucket | null> {
  const url = new URL(GDELT_BASE);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  // Bumped 20 → 50 (Task 4c+). Within GDELT's 250 hard cap and gives
  // each topic chip enough depth that scrolling feels meaningful.
  // After title-dedup the visible item count is typically ~30–40.
  url.searchParams.set('maxrecords', '50');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[intel-news] ${topic.id} fetch error:`, (err as Error).message);
    return null;
  }

  if (!resp.ok) {
    console.warn(`[intel-news] ${topic.id} HTTP ${resp.status}`);
    return null;
  }

  let data: GdeltResponse;
  try {
    data = (await resp.json()) as GdeltResponse;
  } catch {
    return null;
  }

  const articles = Array.isArray(data?.articles) ? data.articles : [];
  if (articles.length === 0) return null;

  // First pass: build raw item list straight from the GDELT response.
  // Dedup happens in the second pass.
  const rawItems: IntelNewsItem[] = [];
  for (const art of articles) {
    const link = String(art.url || art.url_mobile || '').trim();
    const title = String(art.title || '').trim();
    if (!link || !title) continue;

    rawItems.push({
      source: String(art.domain || 'GDELT').trim(),
      title,
      link,
      publishedAt: parseGdeltDate(art.seendate),
      isAlert: false,                  // GDELT doesn't flag breaking — clients can layer their own
      topic: topic.id,
      tone: toNumber(art.tone),
    });
  }

  if (rawItems.length === 0) return null;

  // Second pass: group by normalized title. Wire stories (AP, Reuters)
  // get republished verbatim across dozens of domains under the same
  // topic — collapse them into one canonical item with `sources[]`
  // listing every outlet so the iOS detail view can render a stacked
  // "Read on X" CTA per outlet.
  const groups = new Map<string, IntelNewsItem[]>();
  for (const item of rawItems) {
    const key = normalizeTitle(item.title);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }

  const items: IntelNewsItem[] = [];
  let dupedAway = 0;
  for (const group of groups.values()) {
    // Within each group: keep the freshest as canonical, list every
    // outlet under sources[] (canonical first, others by recency).
    group.sort((a, b) => b.publishedAt - a.publishedAt);
    const canonical = group[0]!;
    if (group.length > 1) {
      canonical.sources = group.map((g) => ({
        source: g.source,
        title: g.title,
        link: g.link,
        publishedAt: g.publishedAt,
      }));
      dupedAway += group.length - 1;
    }
    items.push(canonical);
  }

  // Sort newest first — defensive in case GDELT returns out-of-order
  // and to keep the iOS feed in chronological order.
  items.sort((a, b) => b.publishedAt - a.publishedAt);

  if (dupedAway > 0) {
    console.log(`[intel-news] ${topic.id}: ${rawItems.length} raw → ${items.length} unique (-${dupedAway} duplicate outlets)`);
  }

  // Conflict-only side effects: LLM enrichment + archive write.
  // This branch only fires for the `conflict` topic so the other 8 topics
  // stay cheap (no LLM cost) and the conflict feed is the only one that
  // gets the rich location + summary treatment.
  if (topic.id === 'conflict') {
    // Read path: attach already-cached enrichment, identify cache misses.
    type IntelItemWithEnrichment = IntelNewsItem & {
      id?: string;
      enrichment?: {
        summary: string;
        latitude: number;
        longitude: number;
        locationName: string;
        country: string;
        confidence: number;
      } | null;
    };
    const itemsForEnrichment = items as IntelItemWithEnrichment[];
    const missing = await attachGdeltEnrichment(itemsForEnrichment);

    // Write path: fire-and-forget LLM enrichment for misses. Results
    // populate the cache; the next cycle attaches them. keepAlive
    // prevents Vercel from killing the isolate before the LLM call lands.
    if (missing.length > 0) {
      console.log(`[intel-news:conflict] kicking off enrichment for ${missing.length} items`);
      keepAlive(enrichGdeltConflictAsync(missing), 'intel-news:conflict-enrich');
    }

    // Write to long-retention archive — only items that have BOTH
    // location and summary (so the iOS conflict feed and map are both
    // satisfied). Items still pending enrichment write on a future cycle.
    const archiveItems: ConflictArchiveItem[] = itemsForEnrichment
      .filter((it) => it.enrichment != null && it.id != null)
      .map((it) => ({
        id: it.id!,
        source: it.source,
        title: it.title,
        link: it.link,
        publishedAt: it.publishedAt,
        isAlert: it.isAlert,
        summary: it.enrichment!.summary,
        location: { latitude: it.enrichment!.latitude, longitude: it.enrichment!.longitude },
        locationName: it.enrichment!.locationName,
        country: it.enrichment!.country,
        sources: it.sources ?? null,
        origin: 'gdelt',
      }));
    if (archiveItems.length > 0) {
      keepAlive(appendToArchive('gdelt', archiveItems), 'intel-news:conflict-archive');
    }
  }

  return {
    id: topic.id,
    label: topic.label,
    items,
    fetchedAt: Date.now(),
  };
}

/**
 * Public entrypoint. Always returns a 200 — empty buckets on full upstream
 * failure rather than failing the request, so the iOS feed never goes blank.
 */
export async function listIntelNews(): Promise<ListIntelNewsResponse> {
  // v2 — adds title-dedup with sources[]. Old v1 caches still decode
  // safely on the iOS side (sources is optional) but bumping the key
  // forces an immediate rebuild after deploy so users see the dedup
  // benefit without waiting for the 30 min TTL to expire.
  const topLevelKey = 'intel-news:digest:v2';

  // Top-level cache aggregates per-topic results. Per-topic caches let us
  // partially refresh — if 5 topics are fresh and 1 is stale, only 1 GDELT
  // hit is needed.
  const cached = await cachedFetchJson<ListIntelNewsResponse>(
    topLevelKey,
    TOP_LEVEL_TTL_S,
    async () => {
      // Fetch each topic with its own cachedFetchJson so per-topic ~15 min
      // cache survives even when the top-level 30 s key expires.
      //
      // The fetcher embeds a per-topic stagger delay (`index * 250 ms`).
      // It only runs on cache miss, so:
      //   • Hot-cache request: 0 ms penalty (cachedFetchJson returns cached).
      //   • Cold-cache request: 9 GDELT calls spread over ~2 s rather than
      //     all-in-the-same-instant. Spreads load on GDELT's rate-limiter,
      //     drops 429 risk significantly.
      const promises = INTEL_TOPICS.map(async (topic, index) => {
        const perTopicKey = `intel-news:topic:v2:${topic.id}`;
        return cachedFetchJson<IntelNewsTopicBucket>(
          perTopicKey,
          perTopicTtlSeconds(),
          async () => {
            if (index > 0) {
              await new Promise((r) => setTimeout(r, index * STAGGER_PER_TOPIC_MS));
            }
            return fetchTopicArticles(topic);
          },
          PER_TOPIC_NEG_TTL_S,
        );
      });

      const results = await Promise.all(promises);

      // Filter nulls (topics where GDELT failed AND nothing was cached).
      // Note: the iOS client tolerates missing topics — empty chip = "no
      // recent stories" rather than an error state.
      const topics = results.filter((b): b is IntelNewsTopicBucket => b !== null);

      const totalArticles = topics.reduce((s, t) => s + t.items.length, 0);
      console.log(`[intel-news] digest: ${topics.length}/${INTEL_TOPICS.length} topics, ${totalArticles} articles`);

      return {
        topics,
        generatedAt: new Date().toISOString(),
      };
    },
    30, // negative cache 30 s if every topic fails
  );

  return cached ?? { topics: [], generatedAt: new Date().toISOString() };
}
