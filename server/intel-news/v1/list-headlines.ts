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

// Per-topic cache freshness target: ~15 min, matching GDELT's own update
// cadence. We add 0–60 s of jitter at write-time so the 9 topics' caches
// don't all expire in the same second post-deploy and trigger a 9-parallel
// GDELT burst (the classic 429 trigger).
const PER_TOPIC_TTL_BASE_S = 15 * 60;
const PER_TOPIC_TTL_JITTER_S = 60;
function perTopicTtlSeconds(): number {
  return PER_TOPIC_TTL_BASE_S + Math.floor(Math.random() * PER_TOPIC_TTL_JITTER_S);
}

// 15 min — when GDELT returns 429 we back off hard. Aggressive retry
// makes the rate-limit window LONGER (GDELT's limiter ratchets up on
// repeated knocks), and we'd rather show old cached data than zero data.
// 15 min is comfortably past GDELT's typical 429 cool-down (~10 min),
// so the next miss-probe usually succeeds.
const PER_TOPIC_NEG_TTL_S = 15 * 60;

// Stagger fan-out delay. When multiple topic caches miss simultaneously,
// this per-topic delay turns N-in-the-same-instant into N-spread-over-~2.5s.
//
// Reverted to 250 ms after my earlier bump to 1000 ms broke things:
// 10 topics × 1000 ms = 10 s of stagger PLUS up to FETCH_TIMEOUT_MS for
// the slowest topic = 20+ s total, blowing past Vercel's edge function
// budget. With 250 ms total stagger budget is 2.5 s, leaving plenty of
// timeout headroom even if GDELT is slow.
const STAGGER_PER_TOPIC_MS = 250;

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
async function mergeIntoAccumulator(
  topicId: string,
  freshItems: IntelNewsItem[],
): Promise<IntelNewsItem[]> {
  const key = `intel-news:topic:v5:${topicId}${ACCUMULATOR_KEY_SUFFIX}`;
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
  const key = `intel-news:topic:v5:${topicId}${ACCUMULATOR_KEY_SUFFIX}`;
  const cached = (await getCachedJson(key)) as IntelNewsItem[] | null;
  if (!Array.isArray(cached)) return [];
  // Filter on read too — protects against accumulator entries that
  // pre-date a retention-window change without forcing a key bump.
  const cutoff = Date.now() - ACCUMULATOR_RETENTION_MS;
  return cached.filter((it) => typeof it?.publishedAt === 'number' && it.publishedAt >= cutoff);
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
  // v5 — bumped alongside the per-topic accumulator redesign. Clears
  // out v4 stale-snapshot keys (different schema) and the v4 negative
  // cache entries from the slow-GDELT incident.
  const topLevelKey = 'intel-news:digest:v5';

  // Top-level cache aggregates per-topic results. Per-topic caches let us
  // partially refresh — if 5 topics are fresh and 1 is stale, only 1 GDELT
  // hit is needed.
  const cached = await cachedFetchJson<ListIntelNewsResponse>(
    topLevelKey,
    TOP_LEVEL_TTL_S,
    async () => {
      // Fetch each topic with cachedFetchJson (live cache, ~15 min TTL).
      //
      // Layers around the fetch:
      //   1. Stagger delay (250 ms × index) — spreads cold-start fan-out
      //      to ~2.5 s so GDELT's rate-limiter doesn't 429 the burst.
      //   2. Accumulator merge on success — fresh items get unioned into
      //      a 7-day rolling store (deduplicated by article link). The
      //      accumulator is what we return, not just the fresh fetch.
      //   3. Accumulator fallback on failure — when GDELT is slow / 429s /
      //      times out, we serve the accumulator unchanged. The chip
      //      stays populated with up to 7 days of recent stories instead
      //      of going empty.
      const promises = INTEL_TOPICS.map(async (topic, index) => {
        const perTopicKey = `intel-news:topic:v5:${topic.id}`;

        const result = await cachedFetchJson<IntelNewsTopicBucket>(
          perTopicKey,
          perTopicTtlSeconds(),
          async () => {
            if (index > 0) {
              await new Promise((r) => setTimeout(r, index * STAGGER_PER_TOPIC_MS));
            }

            const fresh = await fetchTopicArticles(topic);
            if (fresh) {
              // Successful fetch — merge into accumulator and return
              // the full merged set as this fetch's payload.
              const merged = await mergeIntoAccumulator(topic.id, fresh.items);
              if (fresh.items.length !== merged.length) {
                console.log(
                  `[intel-news] ${topic.id}: ${fresh.items.length} fresh + ` +
                  `${merged.length - fresh.items.length} from accumulator = ${merged.length} merged`,
                );
              }
              return { ...fresh, items: merged };
            }

            // Fresh fetch failed — serve the accumulator if it has anything.
            const accumulated = await readAccumulator(topic.id);
            if (accumulated.length > 0) {
              console.log(`[intel-news] ${topic.id}: fresh failed, serving accumulator (${accumulated.length} items)`);
              return {
                id: topic.id,
                label: topic.label,
                items: accumulated,
                fetchedAt: Date.now(),
                stale: true,
              };
            }
            return null; // truly nothing — let cachedFetchJson NEG-cache
          },
          PER_TOPIC_NEG_TTL_S,
        );

        return result;
      });

      const fanOutStartMs = Date.now();
      const results = await Promise.all(promises);
      const fanOutMs = Date.now() - fanOutStartMs;

      // Filter nulls (topics where GDELT failed AND no accumulator existed).
      // Note: the iOS client tolerates missing topics — empty chip = "no
      // recent stories" rather than an error state.
      const topics = results.filter((b): b is IntelNewsTopicBucket => b !== null);

      const totalArticles = topics.reduce((s, t) => s + t.items.length, 0);
      const staleCount = topics.filter((t) => t.stale === true).length;
      const freshCount = topics.length - staleCount;
      const failedCount = INTEL_TOPICS.length - topics.length;

      console.log(
        `[intel-news] digest: ${topics.length}/${INTEL_TOPICS.length} topics in ${fanOutMs}ms · ` +
        `${freshCount} fresh, ${staleCount} accumulator-served, ${failedCount} failed · ` +
        `${totalArticles} total articles`,
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
