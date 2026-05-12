/**
 * `GET /api/live-news/v1/list-us-headlines` — handler core.
 *
 * Pipeline:
 *   1. Fan-out fetch ~25 US RSS sources (per-source Redis cache, 10 min).
 *   2. Dedupe by 80-char title fingerprint, age-filter to last 3 days,
 *      sort by recency, cap at 60 items.
 *   3. BATCH-GET cached LLM locations from Redis for every titleHash.
 *      Items with hits get `location` populated immediately.
 *   4. For items still missing, fire-and-forget LLM enrichment in the
 *      background (no `await`) — the response goes back without waiting.
 *      Next iOS poll's BATCH-GET picks up whatever finished.
 *
 * Caching:
 *   - Top-level digest: `live-news:us:v1`, 30 s TTL.
 *   - Per-feed: 10 min TTL.
 *   - Per-headline location: 30 days (effectively forever).
 */

import { cachedFetchJson } from '../../_shared/redis';
import { isBlockedSource } from '../../_shared/blocked-news-sources';
import { keepAlive } from '../../_shared/keep-alive';
import { buildBaseDigest, type LiveNewsItem } from './_normalize';
// Combined enrichment replaces the old `_enrich.ts` (location-only) +
// `_paraphrase.ts` (summary-only) split. One LLM call, one cache namespace,
// one validation gate. Falls back to Claude Haiku for items where Gemini
// produces invalid output. Items that fail both providers get permanently
// marked `UNENRICHABLE` and never retried.
import { attachCachedEnrichment, enrichMissingAsync } from './_enrich-combined';
import { loadCachedDedupMap, applyDedup, classifyUnknownsAsync } from './_dedup';

const TOP_LEVEL_TTL_S = 30;
const NEGATIVE_TTL_S = 30;
const FAN_OUT_DEADLINE_MS = 20_000;

export interface ListUsHeadlinesResponse {
  items: LiveNewsItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  /** Diagnostic — how many items were missing a cached location at digest time. */
  pendingEnrichment: number;
  /** Diagnostic — how many items were missing a cached LLM summary at digest time. */
  pendingParaphrase: number;
}

/** In-memory last-good — fallback if Redis is hard-down on a cold instance. */
let lastGoodResponse: ListUsHeadlinesResponse | null = null;

async function buildDigestPayload(): Promise<ListUsHeadlinesResponse> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), FAN_OUT_DEADLINE_MS);

  try {
    const { items, feedStatuses } = await buildBaseDigest(deadline.signal);

    // Read path — attach cached enrichment (single namespace covering
    // summary + location + country) and load dedup decisions in parallel.
    const [missingEnrichment, dedupMap] = await Promise.all([
      attachCachedEnrichment(items),
      loadCachedDedupMap(items),
    ]);

    // Write path — fire-and-forget enrichment + dedup classification.
    // Each promise is wrapped with `keepAlive` so the Vercel Edge runtime
    // doesn't kill the isolate before they finish. Combined enrichment
    // tries Gemini first, falls back to Claude for invalid responses,
    // and marks items unenrichable when both fail.
    if (missingEnrichment.length > 0) {
      console.log(`[live-news] Kicking off enrichment for ${missingEnrichment.length} items (Gemini → Claude fallback)`);
      keepAlive(enrichMissingAsync(missingEnrichment), 'live-news:enrich');
    }
    // Dedup classification — find items whose dedup decision isn't cached
    // yet. The classifier groups by country, sends to LLM, and writes
    // per-item decisions to Redis for the NEXT poll to pick up via
    // `loadCachedDedupMap`. Items missing summary or country are skipped
    // by the classifier itself (insufficient signal).
    const unknownDedup = items.filter((it) => !dedupMap.has(it.titleHash));
    if (unknownDedup.length > 0) {
      console.log(`[live-news] Kicking off dedup classification for ${unknownDedup.length} items`);
      keepAlive(classifyUnknownsAsync(items, dedupMap), 'live-news:dedup');
    }

    // Apply dedup *now* using whatever decisions are already cached.
    // Items not yet classified pass through unchanged (their titleHash
    // serves as their own canonical) — no items are dropped because
    // we lack a decision. Each subsequent poll picks up freshly-classified
    // items from the cache, progressively tightening the digest.
    const deduped = applyDedup(items, dedupMap);

    // Diagnostic: composition of the response right before send.
    const withSummary = deduped.filter((it) => typeof it.summary === 'string' && it.summary.length > 0).length;
    const withLocation = deduped.filter((it) => it.location !== null).length;
    const dropped = items.length - deduped.length;
    console.log(`[live-news] returning digest withSummary=${withSummary}/${deduped.length} withLocation=${withLocation}/${deduped.length} dedup-dropped=${dropped}`);

    return {
      items: deduped,
      feedStatuses,
      generatedAt: new Date().toISOString(),
      // After combined-call refactor, summary + location come from one
      // pipeline. We keep `pendingParaphrase` mirrored for iOS Codable
      // compatibility — both fields point at the same number now.
      pendingEnrichment: missingEnrichment.length,
      pendingParaphrase: missingEnrichment.length,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Public entrypoint. Always returns a response (even an empty one if every
 * upstream fails). We never let `cachedFetchJson` write a negative sentinel
 * for the digest — see `live-sports/v1/list-us-events.ts` for the war story
 * on cache-poisoning. Empty digests cache normally for 30 s.
 */
export async function listUsHeadlines(): Promise<ListUsHeadlinesResponse> {
  // v6 — paired with the combined-enrichment refactor. Old v5 digests
  // hold items with separately-cached summary + location + country,
  // backed by `live-news:loc:v1` and `live-news:para:v4`. New digests
  // pull from `live-news:enrichment:v1` (single namespace). Bumping
  // forces immediate rebuild so iOS doesn't see mixed-shape responses.
  // Kept at v6 — bumping would invalidate the production digest cache and
  // force a rebuild burst that degrades old iOS clients. The new `isConflict`
  // field rides through on individual item enrichments as they refresh
  // naturally; the digest itself just relays whatever's on each item.
  const cacheKey = 'live-news:us:v6';

  try {
    const result = await cachedFetchJson<ListUsHeadlinesResponse>(
      cacheKey,
      TOP_LEVEL_TTL_S,
      async () => buildDigestPayload(),
      NEGATIVE_TTL_S,
    );

    if (result) {
      // Defensive: strip any items whose source has been removed from the
      // config for commercial-usage reasons. Catches stale items still
      // sitting in the digest cache from before the source was dropped.
      const filtered: ListUsHeadlinesResponse = {
        ...result,
        items: result.items.filter((it) => !isBlockedSource(it.source)),
      };
      lastGoodResponse = filtered;
      return filtered;
    }
  } catch (err) {
    console.warn('[live-news] listUsHeadlines failed:', err instanceof Error ? err.message : err);
  }

  if (lastGoodResponse) return lastGoodResponse;
  return {
    items: [],
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment: 0,
    pendingParaphrase: 0,
  };
}
