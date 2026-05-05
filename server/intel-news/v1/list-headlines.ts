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

import { cachedFetchJson, getCachedJson, setCachedJson } from '../../_shared/redis';
import { keepAlive } from '../../_shared/keep-alive';
import { INTEL_TOPICS, type IntelTopic } from './_topics';
import { appendToArchive, type ConflictArchiveItem } from '../../conflict-archive/v1/_store';
import { enrichGdeltConflictAsync, attachGdeltEnrichment } from './_enrich-conflict';

// (Removed: per-topic live cache TTL + neg-TTL + stagger constants.
//  The user-facing path no longer triggers GDELT fetches — that work
//  now lives in `refresh.ts` driven by Vercel cron. The user endpoint
//  reads accumulators only, with the top-level digest cache below as
//  the only caching layer in this file's hot path.)

// Per-topic ACCUMULATOR — rolling 7-day window of items merged across
// fetches. Each successful GDELT response gets unioned into the
// accumulator (dedup by article link), items older than 7 days are
// pruned out, and the accumulated set is what we return to clients.
//
// Why an accumulator instead of just the latest fetch:
//   • GDELT returns last-24h only. Without accumulation, items vanish
//     from the chip as soon as they roll out of the 24h window.
//   • Conflict / nuclear / sanctions stories often stay relevant for
//     days; the accumulator keeps them visible.
//   • Doubles as the failure fallback — if a fresh fetch fails, we
//     serve the accumulator (which may already contain hundreds of
//     items from prior successful fetches).
//
// Per-item TTL is enforced at write-time by filtering on `publishedAt`
// rather than a Redis TTL on each entry. The Redis key itself has a
// 7-day TTL as a backstop — if writes stop entirely, the accumulator
// expires cleanly. Cap protects against runaway growth.
const ACCUMULATOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACCUMULATOR_TTL_S = 7 * 24 * 60 * 60;
const ACCUMULATOR_MAX_ITEMS = 500;
const ACCUMULATOR_KEY_SUFFIX = ':accumulator';

const TOP_LEVEL_TTL_S = 30;             // 30 s — same urgency tier as live-news
// Bumped 10s → 20s after observing real-world GDELT response times of
// 7–30 s under their fair-use throttling window. 10 s killed too many
// fetches mid-flight, which then negative-cached for 5 min and starved
// the chips. Vercel edge functions tolerate 25 s on the Pro plan and
// 10 s on Hobby — 20 s is safely below either ceiling for most cases.
const FETCH_TIMEOUT_MS = 20_000;
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

/**
 * Public alias of `fetchTopicArticles` so the cron-refresh handler can
 * call it without exposing additional implementation details. Same
 * behavior — fetches one GDELT topic, dedupes by title, runs conflict-
 * specific enrichment + archive write when applicable.
 */
export async function fetchTopicArticlesPublic(topic: IntelTopic): Promise<IntelNewsTopicBucket | null> {
  return fetchTopicArticles(topic);
}

async function fetchTopicArticles(topic: IntelTopic): Promise<IntelNewsTopicBucket | null> {
  const url = new URL(GDELT_BASE);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  // Reduced 50 → 30 after observing that GDELT response times scale
  // with payload size. 50 was returning healthy data but taking 7–30 s
  // per call, which blew our fetch timeout budget on slow days. 30 is
  // still post-dedup-comfortable (~20–25 unique items per topic) and
  // GDELT typically returns this size in 3–6 s.
  url.searchParams.set('maxrecords', '30');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  // Log request start so we can correlate with the response line below.
  const startMs = Date.now();
  console.log(
    `[intel-news] ${topic.id} GDELT GET maxrecords=30 timespan=24h ` +
    `timeout=${FETCH_TIMEOUT_MS}ms queryLen=${topic.query.length}`,
  );

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
    const elapsedMs = Date.now() - startMs;
    const e = err as Error;
    // Distinguish timeout from other network errors so logs are actionable.
    const isTimeout = e?.name === 'TimeoutError' || /abort|timeout/i.test(e?.message ?? '');
    const reason = isTimeout
      ? `TIMEOUT after ${elapsedMs}ms (limit=${FETCH_TIMEOUT_MS}ms) — GDELT didn't respond in time`
      : `NETWORK ERROR after ${elapsedMs}ms — ${e?.name ?? 'Error'}: ${e?.message ?? 'unknown'}`;
    console.warn(`[intel-news] ${topic.id} FAIL: ${reason}`);
    return null;
  }

  const elapsedMs = Date.now() - startMs;

  if (!resp.ok) {
    // Read up to 200 chars of the body so we can see GDELT's exact error
    // message (HTML page, JSON error, plain-text "rate limit exceeded",
    // etc. — they vary by failure mode).
    let bodyPreview = '';
    try {
      bodyPreview = (await resp.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
    } catch { /* ignore body-read failures */ }
    const kind =
      resp.status === 429 ? 'RATE LIMITED (429)'
      : resp.status === 503 ? 'SERVICE UNAVAILABLE (503)'
      : resp.status >= 500 ? `UPSTREAM ERROR (${resp.status})`
      : `CLIENT ERROR (${resp.status})`;
    console.warn(
      `[intel-news] ${topic.id} FAIL: ${kind} after ${elapsedMs}ms · ` +
      `body="${bodyPreview || '<empty>'}"`,
    );
    return null;
  }

  let data: GdeltResponse;
  let bodySize = 0;
  try {
    const bodyText = await resp.text();
    bodySize = bodyText.length;
    data = JSON.parse(bodyText) as GdeltResponse;
  } catch (err) {
    console.warn(
      `[intel-news] ${topic.id} FAIL: PARSE ERROR after ${elapsedMs}ms · ` +
      `bodySize=${bodySize} · ${(err as Error).message}`,
    );
    return null;
  }

  const articles = Array.isArray(data?.articles) ? data.articles : [];
  if (articles.length === 0) {
    console.warn(
      `[intel-news] ${topic.id} EMPTY: GDELT returned 0 articles after ${elapsedMs}ms · ` +
      `bodySize=${bodySize}B (typical for narrow queries on quiet days)`,
    );
    return null;
  }

  console.log(
    `[intel-news] ${topic.id} OK: ${articles.length} articles in ${elapsedMs}ms · ` +
    `bodySize=${(bodySize / 1024).toFixed(1)}KB`,
  );

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

// ─────────────────────────────────────────────────────────────────────────────
// Per-topic accumulator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge a fresh fetch into the rolling 7-day accumulator for a topic.
 *
 *   1. Read existing accumulator from Redis.
 *   2. Union with the fresh items, deduplicating by article `link` —
 *      newer wins on collisions (so updated tone/source/etc. propagate).
 *   3. Filter to items published within the retention window.
 *   4. Sort newest-first, cap at MAX to bound storage + payload size.
 *   5. Write back with a 7-day Redis TTL as a backstop.
 *
 * Returns the merged set so the caller can use it as the response payload
 * for this fetch (rather than just returning the fresh items).
 */
export async function mergeIntoAccumulator(
  topicId: string,
  freshItems: IntelNewsItem[],
): Promise<IntelNewsItem[]> {
  const key = `intel-news:topic:v6:${topicId}${ACCUMULATOR_KEY_SUFFIX}`;
  const cutoff = Date.now() - ACCUMULATOR_RETENTION_MS;

  const existing = (await getCachedJson(key)) as IntelNewsItem[] | null;
  const byLink = new Map<string, IntelNewsItem>();

  // Existing items first; fresh items overwrite on link collision so
  // a refreshed article (potentially with updated metadata) wins.
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item && typeof item.link === 'string' && item.link.length > 0) {
        byLink.set(item.link, item);
      }
    }
  }
  for (const item of freshItems) {
    if (item && typeof item.link === 'string' && item.link.length > 0) {
      byLink.set(item.link, item);
    }
  }

  const merged = [...byLink.values()]
    .filter((it) => typeof it.publishedAt === 'number' && it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, ACCUMULATOR_MAX_ITEMS);

  // Don't await — the merged set is what we return; the write can land
  // after the response. .catch keeps the unhandled-rejection logger quiet.
  setCachedJson(key, merged, ACCUMULATOR_TTL_S).catch(() => {});

  return merged;
}

/** Read the accumulator without merging. Used as the failure fallback. */
async function readAccumulator(topicId: string): Promise<IntelNewsItem[]> {
  const key = `intel-news:topic:v6:${topicId}${ACCUMULATOR_KEY_SUFFIX}`;
  const cached = (await getCachedJson(key)) as IntelNewsItem[] | null;
  if (!Array.isArray(cached)) return [];
  // Filter on read too — protects against accumulator entries that
  // pre-date a retention-window change without forcing a key bump.
  const cutoff = Date.now() - ACCUMULATOR_RETENTION_MS;
  return cached.filter((it) => typeof it?.publishedAt === 'number' && it.publishedAt >= cutoff);
}

/**
 * Public entrypoint. Reads the per-topic accumulators (no GDELT call from
 * the user-traffic path) and assembles the response. Sub-100ms typical
 * because it's just N Redis reads.
 *
 * GDELT fetching happens in a separate cron job (`/api/intel-news/v1/refresh`)
 * which runs every 15 minutes server-side, sequentially fetching all 10
 * topics with 5.5s pacing per GDELT's rate limit. That keeps the user-
 * facing path completely insulated from GDELT availability and rate
 * limits — the worst-case here is "chip shows yesterday's articles
 * because cron hasn't run yet."
 *
 * Always returns a 200, even with empty topics — iOS tolerates this
 * gracefully (chip just renders empty).
 */
export async function listIntelNews(): Promise<ListIntelNewsResponse> {
  // v6 — see refresh.ts for cron-driven population. The cache key
  // version bump cleared out the legacy fan-out NEG_SENTINEL entries.
  const topLevelKey = 'intel-news:digest:v6';

  const cached = await cachedFetchJson<ListIntelNewsResponse>(
    topLevelKey,
    TOP_LEVEL_TTL_S,
    async () => {
      const fanOutStartMs = Date.now();

      // Read each topic's accumulator. Items live in the 7-day rolling
      // window, deduplicated by article link. Cron job is what actually
      // populates these — this path is read-only.
      const buckets = await Promise.all(
        INTEL_TOPICS.map(async (topic) => {
          const items = await readAccumulator(topic.id);
          if (items.length === 0) return null;
          return {
            id: topic.id,
            label: topic.label,
            items,
            fetchedAt: Date.now(),
          } satisfies IntelNewsTopicBucket;
        }),
      );

      const topics = buckets.filter((b): b is IntelNewsTopicBucket => b !== null);
      const totalArticles = topics.reduce((s, t) => s + t.items.length, 0);
      const fanOutMs = Date.now() - fanOutStartMs;
      const emptyCount = INTEL_TOPICS.length - topics.length;

      console.log(
        `[intel-news] digest: ${topics.length}/${INTEL_TOPICS.length} topics in ${fanOutMs}ms · ` +
        `${emptyCount} empty (cron hasn't populated yet) · ${totalArticles} total articles`,
      );

      return {
        topics,
        generatedAt: new Date().toISOString(),
      };
    },
    30, // negative cache 30 s if every topic fails
  );

  return cached ?? { topics: [], generatedAt: new Date().toISOString() };
}
