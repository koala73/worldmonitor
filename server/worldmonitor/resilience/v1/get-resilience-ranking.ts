import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceRankingRequest,
  GetResilienceRankingResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson, runRedisPipeline } from '../../../_shared/redis';
import { unwrapEnvelope } from '../../../_shared/seed-envelope';
import { isInRankableUniverse } from './_rankable-universe';
import {
  GREY_OUT_COVERAGE_THRESHOLD,
  RESILIENCE_INTERVAL_KEY_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  buildRankingItem,
  getCachedResilienceScores,
  listScorableCountries,
  rankingCacheTagMatches,
  sortRankingItems,
  stampRankingCacheTag,
  scoreCacheKey,
  warmMissingResilienceScores,
  type ScoreInterval,
} from './_shared';

const RESILIENCE_RANKING_META_KEY = 'seed-meta:resilience:ranking';
const RESILIENCE_RANKING_META_TTL_SECONDS = 7 * 24 * 60 * 60;

// Hard ceiling on one synchronous warm pass — purely a safety net against a
// runaway static index. The shared memoized reader means global Redis keys are
// fetched once total (not once per country), so the Upstash burst is
//   17 shared reads + N×3 per-country reads + N pipeline writes
// and wall time does NOT scale with N because all countries run via
// Promise.allSettled in parallel; it is bounded by ~2-3 sequential RTTs within
// one country (~60-150 ms). 1000 is several multiples above the current static
// index (~222 countries) so every warm pass is unconditionally complete.
const SYNC_WARM_LIMIT = 1000;

// Minimum fraction of scorable countries that must have a cached score before we
// persist the ranking to Redis. Prevents a cold-start (0% cached) from being
// locked in, while still allowing partial-state writes (e.g. 90%) to succeed so
// the next call doesn't re-warm everything. This is a safety rail against genuine
// warm failures (Redis blips, data gaps) — it must NOT be tripped by the handler
// capping how many countries it attempts. See SYNC_WARM_LIMIT above.
const RANKING_CACHE_MIN_COVERAGE = 0.75;

async function fetchIntervals(countryCodes: string[]): Promise<Map<string, ScoreInterval>> {
  if (countryCodes.length === 0) return new Map();
  const results = await runRedisPipeline(countryCodes.map((cc) => ['GET', `${RESILIENCE_INTERVAL_KEY_PREFIX}${cc}`]), true);
  const map = new Map<string, ScoreInterval>();
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw !== 'string') continue;
    try {
      // Envelope-aware: interval keys come through seed-resilience-scores' extra-key path.
      const parsed = unwrapEnvelope(JSON.parse(raw)).data as { p05?: number; p95?: number } | null;
      if (parsed && typeof parsed.p05 === 'number' && typeof parsed.p95 === 'number') {
        map.set(countryCodes[i]!, { p05: parsed.p05, p95: parsed.p95 });
      }
    } catch { /* ignore malformed interval entries */ }
  }
  return map;
}

export const getResilienceRanking: ResilienceServiceHandler['getResilienceRanking'] = async (
  ctx: ServerContext,
  _req: GetResilienceRankingRequest,
): Promise<GetResilienceRankingResponse> => {
  // ?refresh=1 forces a full recompute-and-publish instead of returning the
  // existing cache. It is seed-service-only: a full warm is expensive (~222
  // score computations + chunked pipeline SETs) and an unauthenticated or
  // Pro-bearer caller looping on refresh=1 could DoS Upstash quota and Edge
  // budget. Gated on a valid seed API key in X-WorldMonitor-Key (the same
  // WORLDMONITOR_VALID_KEYS list the cron uses). Pro bearer tokens do NOT
  // grant refresh — they get the standard cache-first path.
  const forceRefresh = (() => {
    try {
      if (new URL(ctx.request.url).searchParams.get('refresh') !== '1') return false;
    } catch { return false; }
    const wmKey = ctx.request.headers.get('X-WorldMonitor-Key') ?? '';
    if (!wmKey) return false;
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
    const apiKey = process.env.WORLDMONITOR_API_KEY ?? '';
    const allowed = new Set(validKeys);
    if (apiKey) allowed.add(apiKey);
    if (!allowed.has(wmKey)) {
      console.warn('[resilience] refresh=1 rejected: X-WorldMonitor-Key not in seed allowlist');
      return false;
    }
    return true;
  })();
  if (!forceRefresh) {
    const cached = await getCachedJson(RESILIENCE_RANKING_CACHE_KEY) as (GetResilienceRankingResponse & { _formula?: string }) | null;
    // Stale-formula gate: the ranking cache key is bumped at PR deploy,
    // but the flag flip happens later, so the v10 namespace starts out
    // filled with 6-domain rankings. Without this check, a flip would
    // serve the legacy ranking aggregate for up to the 12h ranking TTL
    // even as per-country reads produced pillar-combined scores. Drop
    // stale-formula hits so the recompute-and-publish path below runs.
    const tagMatches = cached != null && rankingCacheTagMatches(cached);
    if (tagMatches && (cached!.items.length > 0 || (cached!.greyedOut?.length ?? 0) > 0)) {
      // Plan 2026-04-26-002 §U2 (PR 1, review fixup): defense-in-depth
      // universe filter at the cached-response read too. Without this,
      // the cache hit path returns a stale 222-country payload (pre-PR-1
      // ranking) until either the 12h TTL expires or someone runs
      // ?refresh=1. The filter is idempotent — a fresh post-PR-1 ranking
      // is already universe-filtered, so this is a no-op then; a stale
      // pre-PR-1 cached payload gets filtered at handler-time. Same
      // recipe as `_shared.ts:listScorableCountries`. The filter
      // preserves the rest of the cache hit (rankCounts, percentile
      // anchors, etc.) so we don't pay the recompute cost just for
      // universe membership.
      const filteredItems = cached!.items.filter((item) => isInRankableUniverse(item.countryCode));
      const filteredGreyedOut = (cached!.greyedOut ?? []).filter((item) => isInRankableUniverse(item.countryCode));
      const droppedCount = (cached!.items.length - filteredItems.length) + ((cached!.greyedOut?.length ?? 0) - filteredGreyedOut.length);
      if (droppedCount > 0) {
        console.log(`[resilience-ranking] Filtered ${droppedCount} non-rankable territories from cached ranking response (transitional — next recompute will publish a clean payload)`);
      }
      // Plan 2026-04-26-002 §U3 (PR 2) review fix — backfill the
      // `headlineEligible` field on each cached item. The v16 ranking
      // cache predates the field, so cache hits would return items
      // missing the now-required boolean. Defaulting to `true` matches
      // the PR-2 contract for items already in the ranking; the next
      // recompute will publish items with the field stamped at build
      // time. Same backfill pattern as `stripCacheMeta` in `_shared.ts`.
      const backfillEligibility = <T extends { headlineEligible?: boolean }>(item: T): T =>
        (item.headlineEligible === undefined ? { ...item, headlineEligible: true } : item);
      // Strip the cache-only tag before returning to callers so the
      // wire shape matches the generated proto response type.
      const { _formula: _drop, ...publicResponse } = cached!;
      void _drop;
      return {
        ...(publicResponse as GetResilienceRankingResponse),
        items: filteredItems.map(backfillEligibility),
        greyedOut: filteredGreyedOut.map(backfillEligibility),
      };
    }
  }

  const countryCodes = await listScorableCountries();
  if (countryCodes.length === 0) return { items: [], greyedOut: [] };

  const cachedScores = await getCachedResilienceScores(countryCodes);
  const missing = countryCodes.filter((countryCode) => !cachedScores.has(countryCode));
  // Track the country codes whose scores were JUST warmed by this invocation.
  // The persistence parity check below samples from THIS set specifically —
  // pre-warmed entries from `getCachedResilienceScores` already proved they
  // exist (we just read them), so verifying them is uninformative; the keys
  // whose durability is in question are the ones we just SET via the
  // batched pipeline inside `warmMissingResilienceScores`.
  const warmedCountryCodes: string[] = [];
  if (missing.length > 0) {
    try {
      // Merge warm results into cachedScores directly rather than re-reading
      // from Redis. Upstash REST writes (/set) aren't always visible to an
      // immediately-following /pipeline GET in the same Vercel invocation,
      // which collapsed coverage to 0/N and silently dropped the ranking
      // publish. The warmer already holds every score in memory — trust it.
      // See `feedback_upstash_write_reread_race_in_handler.md`.
      const warmed = await warmMissingResilienceScores(missing.slice(0, SYNC_WARM_LIMIT));
      for (const [countryCode, score] of warmed) {
        cachedScores.set(countryCode, score);
        warmedCountryCodes.push(countryCode);
      }
    } catch (err) {
      console.warn('[resilience] ranking warmup failed:', err);
    }
  }

  const intervals = await fetchIntervals([...cachedScores.keys()]);
  const allItems = countryCodes.map((countryCode) => buildRankingItem(countryCode, cachedScores.get(countryCode), intervals.get(countryCode)));
  const response: GetResilienceRankingResponse = {
    items: sortRankingItems(allItems.filter((item) => item.overallCoverage >= GREY_OUT_COVERAGE_THRESHOLD)),
    greyedOut: allItems.filter((item) => item.overallCoverage < GREY_OUT_COVERAGE_THRESHOLD),
  };

  // Cache the ranking when we have substantive coverage — don't hold out for 100%.
  // The previous gate (stillMissing === 0) meant a single failing-to-warm country
  // permanently blocked the write, leaving the cache null for days while the 6h TTL
  // expired between cron ticks. Countries that fail to warm already land in
  // `greyedOut` with coverage 0, so the response is correct for partial states.
  const coverageRatio = cachedScores.size / countryCodes.length;
  if (coverageRatio >= RANKING_CACHE_MIN_COVERAGE) {
    // Persistence parity check: confirm the score SETs actually landed in
    // Redis before declaring success and writing seed-meta. Upstash REST
    // /pipeline returns `result:'OK'` per command, but under saturated edge-
    // runtime conditions that OK can be a transport-level acknowledgement
    // that doesn't translate to durable persistence — observed 2026-04-27
    // when seed-meta:resilience:ranking said scored=196 while a SCAN of
    // resilience:score:v16:* returned just 2 keys. Without this check the
    // meta would lie about success, downstream health flips between OK and
    // EMPTY, and operators chase phantom TTL/cron issues.
    //
    // Critical: sample from `warmedCountryCodes` (entries SET by THIS
    // invocation), NOT from all of cachedScores. Pre-warmed entries came
    // from `getCachedResilienceScores` — we just READ them, so they are
    // tautologically present. The keys whose durability is uncertain are
    // the ones we just WROTE. A naïve `slice(0, 20)` over cachedScores
    // creates a blind spot: if the first 20 are pre-warmed and the
    // durability failure only affects the warmed tail, the check passes
    // and meta still lies (reviewer catch on PR #3458).
    //
    // Within the warmed set, shuffle before slicing so the same N entries
    // aren't checked every invocation — partial-failure modes that
    // consistently affect the same subset (e.g. last batch of 30 fails
    // due to queue saturation) are more likely to be sampled.
    //
    // Cost: one extra ~50-200ms round-trip on Edge. Skip entirely when
    // there were no warmed writes (cache hit on every country).
    if (warmedCountryCodes.length > 0) {
      const shuffled = [...warmedCountryCodes].sort(() => Math.random() - 0.5);
      const sampleKeys = shuffled.slice(0, 20).map(scoreCacheKey);
      const verifyResults = await runRedisPipeline(sampleKeys.map((k) => ['EXISTS', k]));
      const actualPersisted = verifyResults.filter((r) => r?.result === 1).length;
      if (actualPersisted < sampleKeys.length * 0.5) {
        console.warn(
          `[resilience] persistence parity fail: ${actualPersisted}/${sampleKeys.length} ` +
          `sampled WARMED score keys exist in Redis (warmed=${warmedCountryCodes.length}, ` +
          `cachedScores.size=${cachedScores.size}, coverage=${(coverageRatio * 100).toFixed(0)}%) — ` +
          `refusing meta write to avoid lying about ranking publish.`,
        );
        return response;
      }
    }

    // Upstash REST /pipeline is not transactional: each SET can succeed or
    // fail independently. A partial write (ranking OK, meta missed) would
    // leave health.js reading a stale meta over a fresh ranking — the seeder
    // self-heal here ensures we at least log it, and the seeder also verifies
    // BOTH keys post-refresh. If either SET didn't return OK we log a warning
    // that ops can grep for, rather than silently succeeding.
    // Tag the persisted ranking so the stale-formula gate above can
    // detect a cross-formula cache hit after a flag flip. The tag is
    // stripped on read before the response crosses back to callers.
    const persistedRanking = stampRankingCacheTag(response);
    const pipelineResult = await runRedisPipeline([
      ['SET', RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(persistedRanking), 'EX', RESILIENCE_RANKING_CACHE_TTL_SECONDS],
      ['SET', RESILIENCE_RANKING_META_KEY, JSON.stringify({
        fetchedAt: Date.now(),
        count: response.items.length + response.greyedOut.length,
        scored: cachedScores.size,
        total: countryCodes.length,
      }), 'EX', RESILIENCE_RANKING_META_TTL_SECONDS],
    ]);
    const rankingOk = pipelineResult[0]?.result === 'OK';
    const metaOk = pipelineResult[1]?.result === 'OK';
    if (!rankingOk || !metaOk) {
      console.warn(`[resilience] ranking publish partial: ranking=${rankingOk ? 'OK' : 'FAIL'} meta=${metaOk ? 'OK' : 'FAIL'}`);
    }
  } else {
    console.warn(`[resilience] ranking not cached — coverage ${cachedScores.size}/${countryCodes.length} below ${RANKING_CACHE_MIN_COVERAGE * 100}% threshold`);
  }

  return response;
};
