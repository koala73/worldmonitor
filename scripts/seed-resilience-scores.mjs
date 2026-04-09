#!/usr/bin/env node
/**
 * Resilience score seeder: reads the static index, checks which countries have
 * cached scores, and computes missing ones directly via the scoring engine.
 *
 * Runs every 5 hours via Railway cron (slightly inside the 6-hour score cache
 * TTL to keep scores warm for the Vercel ranking handler).
 *
 * Requires: node --import tsx/esm scripts/seed-resilience-scores.mjs
 * (tsx/esm is needed to import the TypeScript scoring engine from server/)
 */

import {
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v7:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v7';
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 6 * 60 * 60; // kept for test parity — ranking write owned by Vercel handler
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

  let scored = 0;
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw === 'string') {
      try { JSON.parse(raw); scored++; } catch { /* skip malformed */ }
    }
  }

  console.log(`[resilience-scores] ${scored}/${countryCodes.length} countries have cached scores`);

  const missingCodes = [];
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    const valid = typeof raw === 'string' && (() => { try { JSON.parse(raw); return true; } catch { return false; } })();
    if (!valid) missingCodes.push(countryCodes[i]);
  }

  let warmed = 0;
  if (missingCodes.length > 0) {
    console.log(`[resilience-scores] Computing ${missingCodes.length} missing scores directly...`);

    let ensureResilienceScoreCached, createMemoizedSeedReader;
    try {
      ({ ensureResilienceScoreCached } = await import('../server/worldmonitor/resilience/v1/_shared.ts'));
      ({ createMemoizedSeedReader } = await import('../server/worldmonitor/resilience/v1/_dimension-scorers.ts'));
    } catch (err) {
      console.error(`[resilience-scores] FATAL: Scorer import failed. Check Railway start command includes --import tsx/esm`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const reader = createMemoizedSeedReader();
    const BATCH_SIZE = 20;

    for (let i = 0; i < missingCodes.length; i += BATCH_SIZE) {
      const batch = missingCodes.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map((cc) => ensureResilienceScoreCached(cc, reader)),
      );
      const batchWarmed = batchResults.filter((r) => r.status === 'fulfilled').length;
      warmed += batchWarmed;
      const failed = batchResults.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        console.error(`[resilience-scores] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${failed.length} failed`);
      }
    }

    console.log(`[resilience-scores] Warmed: ${warmed}/${missingCodes.length} scores`);
  }

  return { skipped: false, recordCount: scored + warmed, total: countryCodes.length };
}

async function main() {
  const startedAt = Date.now();
  const result = await seedResilienceScores();
  logSeedResult('resilience:scores', result.recordCount ?? 0, Date.now() - startedAt, {
    skipped: Boolean(result.skipped),
    ...(result.total != null && { total: result.total }),
    ...(result.reason != null && { reason: result.reason }),
  });
}

if (process.argv[1]?.endsWith('seed-resilience-scores.mjs')) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
