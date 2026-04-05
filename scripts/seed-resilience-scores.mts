#!/usr/bin/env node
/**
 * Pre-warms resilience country scores and the ranking cache so the choropleth
 * layer is always instant for users. Runs every 5 hours via Railway cron
 * (slightly inside the 6-hour score cache TTL to keep caches warm).
 *
 * Flow:
 *   1. Read country list from resilience:static:index:v1
 *   2. Compute / refresh resilience:score:{iso2} for every country
 *      (shared memoized reader means global Redis keys are fetched once)
 *   3. Write resilience:ranking so the first user request is a cache hit
 */

import {
  acquireLockSafely,
  loadEnvFile,
  logSeedResult,
  releaseLock,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

import { setCachedJson } from '../server/_shared/redis.ts';
import {
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  buildRankingItem,
  getCachedResilienceScores,
  listScorableCountries,
  sortRankingItems,
  warmMissingResilienceScores,
} from '../server/worldmonitor/resilience/v1/_shared.ts';

const LOCK_DOMAIN = 'resilience:scores';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min

async function seedResilienceScores(): Promise<{ skipped: boolean; recordCount?: number; total?: number; reason?: string }> {
  const countryCodes = await listScorableCountries();
  if (countryCodes.length === 0) {
    console.warn('[resilience-scores] Static index is empty — has seed-resilience-static run this year?');
    return { skipped: true, reason: 'no_index' };
  }

  console.log(`[resilience-scores] Warming ${countryCodes.length} countries...`);
  await warmMissingResilienceScores(countryCodes);

  const cachedScores = await getCachedResilienceScores(countryCodes);
  const items = sortRankingItems(
    countryCodes.map((code) => buildRankingItem(code, cachedScores.get(code))),
  );
  const scored = items.filter((item) => item.overallScore >= 0).length;
  console.log(`[resilience-scores] Scored ${scored}/${countryCodes.length} countries`);

  // Only write the ranking cache when every country has a real score.
  // A partial write would pin an incomplete choropleth for the full 6h TTL because
  // getResilienceRanking() returns any cached ranking with items.length > 0 unchanged.
  if (scored < countryCodes.length) {
    const missing = countryCodes.length - scored;
    console.warn(`[resilience-scores] ${missing} countries failed to score — skipping ranking cache write to avoid pinning incomplete data`);
    return { skipped: false, recordCount: scored, total: countryCodes.length };
  }

  await setCachedJson(RESILIENCE_RANKING_CACHE_KEY, { items }, RESILIENCE_RANKING_CACHE_TTL_SECONDS);
  console.log('[resilience-scores] Ranking cache written');

  return { skipped: false, recordCount: scored, total: countryCodes.length };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runId = `${LOCK_DOMAIN}:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[resilience-scores] Another seed run is already active');
    return;
  }

  try {
    const result = await seedResilienceScores();
    logSeedResult('resilience:scores', result.recordCount ?? 0, Date.now() - startedAt, {
      skipped: Boolean(result.skipped),
      ...(result.total != null && { total: result.total }),
      ...(result.reason != null && { reason: result.reason }),
    });
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${message}`);
  process.exit(1);
});
