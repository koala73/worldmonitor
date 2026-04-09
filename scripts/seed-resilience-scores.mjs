#!/usr/bin/env node
import {
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
const WM_KEY = process.env.WORLDMONITOR_API_KEY || '';
const SEED_UA = 'Mozilla/5.0 (compatible; WorldMonitor-Seed/1.0)';

export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v7:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v7';
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

function countCachedFromPipeline(results) {
  let count = 0;
  for (const entry of results) {
    if (typeof entry?.result === 'string') {
      try { JSON.parse(entry.result); count++; } catch { /* malformed */ }
    }
  }
  return count;
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
  const preResults = await redisPipeline(url, token, getCommands);
  const preWarmed = countCachedFromPipeline(preResults);

  console.log(`[resilience-scores] ${preWarmed}/${countryCodes.length} scores pre-warmed`);

  const missing = countryCodes.length - preWarmed;
  if (missing > 0) {
    console.log(`[resilience-scores] Warming ${missing} missing via ranking endpoint...`);
    try {
      const headers = { 'User-Agent': SEED_UA, 'Accept': 'application/json' };
      if (WM_KEY) headers['X-WorldMonitor-Key'] = WM_KEY;
      const resp = await fetch(`${API_BASE}/api/resilience/v1/get-resilience-ranking`, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const ranked = data.items?.length ?? 0;
        const greyed = data.greyedOut?.length ?? 0;
        console.log(`[resilience-scores] Ranking: ${ranked} ranked, ${greyed} greyed out`);
      } else {
        console.warn(`[resilience-scores] Ranking endpoint returned ${resp.status}`);
      }
    } catch (err) {
      console.warn(`[resilience-scores] Ranking warmup failed (best-effort): ${err.message}`);
    }

    // Re-check which countries are still missing after bulk warmup
    const postResults = await redisPipeline(url, token, getCommands);
    const stillMissing = [];
    for (let i = 0; i < countryCodes.length; i++) {
      const raw = postResults[i]?.result ?? null;
      if (!raw || raw === 'null') { stillMissing.push(countryCodes[i]); continue; }
      try {
        const parsed = JSON.parse(raw);
        if (parsed.overallScore <= 0) stillMissing.push(countryCodes[i]);
      } catch { stillMissing.push(countryCodes[i]); }
    }

    // Warm laggards individually (countries the bulk ranking timed out on)
    if (stillMissing.length > 0 && !WM_KEY) {
      console.warn(`[resilience-scores] ${stillMissing.length} laggards found but WORLDMONITOR_API_KEY not set — skipping individual warmup`);
    }
    if (stillMissing.length > 0 && WM_KEY) {
      console.log(`[resilience-scores] Warming ${stillMissing.length} laggards individually...`);
      const BATCH = 5;
      let warmed = 0;
      for (let i = 0; i < stillMissing.length; i += BATCH) {
        const batch = stillMissing.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(async (cc) => {
          const scoreUrl = `${API_BASE}/api/resilience/v1/get-resilience-score?countryCode=${cc}`;
          const resp = await fetch(scoreUrl, {
            headers: { 'User-Agent': SEED_UA, 'Accept': 'application/json', 'X-WorldMonitor-Key': WM_KEY },
            signal: AbortSignal.timeout(30_000),
          });
          if (!resp.ok) throw new Error(`${cc}: HTTP ${resp.status}`);
          return cc;
        }));
        warmed += results.filter(r => r.status === 'fulfilled').length;
      }
      console.log(`[resilience-scores] Laggards warmed: ${warmed}/${stillMissing.length}`);
    }

    const finalResults = await redisPipeline(url, token, getCommands);
    const finalWarmed = countCachedFromPipeline(finalResults);
    console.log(`[resilience-scores] Final: ${finalWarmed}/${countryCodes.length} cached`);
    return { skipped: false, recordCount: finalWarmed, total: countryCodes.length };
  }

  return { skipped: false, recordCount: preWarmed, total: countryCodes.length };
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
