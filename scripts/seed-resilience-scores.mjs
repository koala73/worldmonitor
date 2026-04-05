#!/usr/bin/env node
/**
 * Pre-warms resilience country scores and the ranking cache so the choropleth
 * layer is always instant for users. Runs every 5 hours via Railway cron
 * (slightly inside the 6-hour score cache TTL to keep caches warm).
 *
 * Flow:
 *   1. Read country list from resilience:static:index:v1
 *   2. Read all resilience:score:{iso2} keys from Redis in a single pipeline
 *   3. Build and write resilience:ranking with a fresh TTL (only if all countries scored)
 *
 * Missing scores are handled on-demand by the Vercel ranking handler
 * (warmMissingResilienceScores with SYNC_WARM_LIMIT=200 covers the full index
 * in parallel — wall time is bounded by ~2-3 Redis RTTs regardless of country count).
 */

import {
  acquireLockSafely,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const LOCK_DOMAIN = 'resilience:scores';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min

export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking';
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';

async function redisGetJson(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function redisPipeline(url, token, commands) {
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/** Mirrors server/worldmonitor/resilience/v1/_shared.ts buildRankingItem */
export function buildRankingItem(countryCode, score) {
  if (!score) return { countryCode, overallScore: -1, level: 'unknown', lowConfidence: true };
  return { countryCode, overallScore: score.overallScore, level: score.level, lowConfidence: score.lowConfidence };
}

/** Mirrors server/worldmonitor/resilience/v1/_shared.ts sortRankingItems */
export function sortRankingItems(items) {
  return [...items].sort((a, b) => {
    if (a.overallScore !== b.overallScore) return b.overallScore - a.overallScore;
    return a.countryCode.localeCompare(b.countryCode);
  });
}

/**
 * Pure: builds and sorts ranking items from a country list + cached score map.
 * Returns { items, scored } where scored = count of items with overallScore >= 0.
 * The caller skips the Redis write when scored < countryCodes.length.
 */
export function buildRankingPayload(countryCodes, scoreMap) {
  const items = sortRankingItems(countryCodes.map((c) => buildRankingItem(c, scoreMap.get(c))));
  const scored = items.filter((item) => item.overallScore >= 0).length;
  return { items, scored };
}

async function seedResilienceScores() {
  const { url, token } = getRedisCredentials();

  const index = await redisGetJson(url, token, RESILIENCE_STATIC_INDEX_KEY);
  const countryCodes = (index?.countries ?? [])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));

  if (countryCodes.length === 0) {
    console.warn('[resilience-scores] Static index is empty — has seed-resilience-static run this year?');
    return { skipped: true, reason: 'no_index' };
  }

  console.log(`[resilience-scores] Reading cached scores for ${countryCodes.length} countries...`);

  const getCommands = countryCodes.map((c) => ['GET', `${RESILIENCE_SCORE_CACHE_PREFIX}${c}`]);
  const results = await redisPipeline(url, token, getCommands);

  const scoreMap = new Map();
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw !== 'string') continue;
    try { scoreMap.set(countryCodes[i], JSON.parse(raw)); } catch { /* skip malformed */ }
  }

  const { items, scored } = buildRankingPayload(countryCodes, scoreMap);
  console.log(`[resilience-scores] ${scored}/${countryCodes.length} countries have cached scores`);

  // Only write the ranking cache when every country has a real score.
  // A partial write would pin an incomplete choropleth for the full 6h TTL because
  // getResilienceRanking() returns any cached ranking with items.length > 0 unchanged.
  if (scored < countryCodes.length) {
    const missing = countryCodes.length - scored;
    console.warn(`[resilience-scores] ${missing} countries missing scores — skipping ranking cache write to avoid pinning incomplete data`);
    return { skipped: false, recordCount: scored, total: countryCodes.length };
  }

  await redisPipeline(url, token, [
    ['SET', RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ items }), 'EX', RESILIENCE_RANKING_CACHE_TTL_SECONDS],
  ]);
  console.log('[resilience-scores] Ranking cache written');

  return { skipped: false, recordCount: scored, total: countryCodes.length };
}

async function main() {
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

if (process.argv[1]?.endsWith('seed-resilience-scores.mjs')) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
