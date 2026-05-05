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

import { cachedFetchJson, getCachedJson } from '../../_shared/redis';
import { INTEL_TOPICS } from './_topics';

// User-facing endpoint is now READ-ONLY — GDELT fan-out + accumulator
// writes happen in the cron job at api/intel-news/v1/refresh.ts. This
// file just reads what cron has populated.

const ACCUMULATOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACCUMULATOR_KEY_SUFFIX = ':accumulator';
const TOP_LEVEL_TTL_S = 30; // 30 s — same urgency tier as live-news

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

// (parseGdeltDate, toNumber, normalizeTitle moved into the cron handler
// at api/intel-news/v1/refresh.ts — they were only used by the now-deleted
// fan-out path here.)

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
