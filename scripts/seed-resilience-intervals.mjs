#!/usr/bin/env node
import {
  acquireLockSafely,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  writeFreshnessMetadata,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import {
  DRAWS,
  RESILIENCE_INTERVAL_KEY_PREFIX as INTERVAL_KEY_PREFIX,
  buildScoreIntervalPayload,
  computeIntervals,
  createIntervalDiagnostics,
} from './_resilience-intervals.mjs';

loadEnvFile(import.meta.url);

const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
// Reuse WORLDMONITOR_VALID_KEYS when a dedicated WORLDMONITOR_API_KEY isn't set.
// See seed-resilience-scores.mjs for the rationale.
const WM_KEY = process.env.WORLDMONITOR_API_KEY
  || (process.env.WORLDMONITOR_VALID_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)[0]
  || '';
const SEED_UA = 'Mozilla/5.0 (compatible; WorldMonitor-Seed/1.0)';

const INTERVAL_TTL_SECONDS = 7 * 24 * 60 * 60;
const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v19:';
export { computeIntervals };

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

async function fetchRanking() {
  const headers = { 'User-Agent': SEED_UA, Accept: 'application/json' };
  if (WM_KEY) headers['X-WorldMonitor-Key'] = WM_KEY;
  const resp = await fetch(`${API_BASE}/api/resilience/v1/get-resilience-ranking`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Ranking endpoint returned HTTP ${resp.status}`);
  return resp.json();
}

async function seedResilienceIntervals() {
  const { url, token } = getRedisCredentials();

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lockResult = await acquireLockSafely('resilience:intervals', runId, 600_000);
  if (!lockResult.locked) return { skipped: true, reason: 'concurrent_run' };

  try {
    console.log('[resilience-intervals] Fetching ranking...');
    const ranking = await fetchRanking();
    const allItems = [...(ranking.items ?? []), ...(ranking.greyedOut ?? [])];
    console.log(`[resilience-intervals] ${allItems.length} countries in ranking`);

    if (allItems.length === 0) {
      return { skipped: true, reason: 'empty_ranking' };
    }

    let computed = 0;
    let cachedScores = 0;
    const commands = [];
    const diagnostics = createIntervalDiagnostics();
    const countryCodes = allItems
      .map((item) => String(item?.countryCode || '').trim().toUpperCase())
      .filter((countryCode) => /^[A-Z]{2}$/.test(countryCode));
    const scoreResults = await redisPipeline(
      url,
      token,
      countryCodes.map((countryCode) => ['GET', `${RESILIENCE_SCORE_CACHE_PREFIX}${countryCode}`]),
    );

    for (let i = 0; i < countryCodes.length; i++) {
      const raw = scoreResults[i]?.result ?? null;
      if (!raw || raw === 'null') continue;
      try {
        const scoreData = unwrapEnvelope(JSON.parse(raw)).data;
        cachedScores++;
        const payload = buildScoreIntervalPayload(scoreData, {
          draws: DRAWS,
          diagnostics,
        });
        if (!payload) continue;

        const key = `${INTERVAL_KEY_PREFIX}${countryCodes[i]}`;
        commands.push(['SET', key, JSON.stringify(payload), 'EX', INTERVAL_TTL_SECONDS]);
        computed++;
      } catch {
        // Ignore malformed cache entries; they will be rewritten by the score warmer.
      }
    }

    if (commands.length > 0) {
      const PIPE_BATCH = 50;
      for (let i = 0; i < commands.length; i += PIPE_BATCH) {
        await redisPipeline(url, token, commands.slice(i, i + PIPE_BATCH));
      }
    }

    if (diagnostics.activeScoreClampCount > 0) {
      console.warn(
        `[resilience-intervals] Clamped ${diagnostics.activeScoreClampCount} interval bands to contain the active score ` +
        `(maxDelta=${diagnostics.activeScoreClampMaxDelta}; samples=${JSON.stringify(diagnostics.activeScoreClampSamples)})`,
      );
    }
    if (diagnostics.formulaSkipCount > 0) {
      console.warn(
        `[resilience-intervals] Skipped ${diagnostics.formulaSkipCount} interval payloads with missing/ambiguous formula tags ` +
        `(samples=${JSON.stringify(diagnostics.formulaSkipSamples)})`,
      );
    }

    console.log(`[resilience-intervals] Wrote ${computed}/${allItems.length} intervals (${cachedScores} cached score payloads read)`);
    return {
      skipped: false,
      recordCount: computed,
      total: allItems.length,
      intervalClampCount: diagnostics.activeScoreClampCount,
      intervalClampMaxDelta: diagnostics.activeScoreClampMaxDelta,
    };
  } finally {
    await releaseLock('resilience:intervals', runId);
  }
}

async function main() {
  const startedAt = Date.now();
  const result = await seedResilienceIntervals();
  logSeedResult('resilience:intervals', result.recordCount ?? 0, Date.now() - startedAt, {
    skipped: Boolean(result.skipped),
    ...(result.total != null && { total: result.total }),
    ...(result.reason != null && { reason: result.reason }),
    ...(result.intervalClampCount != null && { intervalClampCount: result.intervalClampCount }),
    ...(result.intervalClampMaxDelta != null && { intervalClampMaxDelta: result.intervalClampMaxDelta }),
  });
  if (!result.skipped) {
    await writeFreshnessMetadata('resilience', 'intervals', result.recordCount ?? 0, '', 7 * 24 * 3600);
  }
}

if (process.argv[1]?.endsWith('seed-resilience-intervals.mjs')) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
