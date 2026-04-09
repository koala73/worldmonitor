#!/usr/bin/env node
/**
 * Read-only health check for resilience country scores. Reads the static index
 * and checks how many countries have cached scores. Does NOT write rankings
 * (the Vercel ranking handler owns that with proper greyedOut split).
 *
 * Runs every 5 hours via Railway cron (slightly inside the 6-hour score cache
 * TTL to keep monitoring warm).
 *
 * Missing scores are handled on-demand by the Vercel ranking handler
 * (warmMissingResilienceScores with SYNC_WARM_LIMIT=200 covers the full index
 * in parallel).
 */

import {
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v6:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v6';
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

  if (scored < countryCodes.length) {
    const missing = countryCodes.length - scored;
    console.warn(`[resilience-scores] ${missing} countries missing scores — will be warmed on-demand by ranking handler`);
  }

  return { skipped: false, recordCount: scored, total: countryCodes.length };
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
