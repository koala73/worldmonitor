#!/usr/bin/env node
import {
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  writeFreshnessMetadata,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
// Reuse WORLDMONITOR_VALID_KEYS when a dedicated WORLDMONITOR_API_KEY isn't set —
// any entry in that comma-separated list is accepted by the API (same
// validation list that server/_shared/premium-check.ts and validateApiKey read).
// Avoids duplicating the same secret under a second env-var name per service.
const WM_KEY = process.env.WORLDMONITOR_API_KEY
  || (process.env.WORLDMONITOR_VALID_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)[0]
  || '';
const SEED_UA = 'Mozilla/5.0 (compatible; WorldMonitor-Seed/1.0)';

export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v9:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v9';
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';

const INTERVAL_KEY_PREFIX = 'resilience:intervals:v1:';
const INTERVAL_TTL_SECONDS = 7 * 24 * 60 * 60;
const DRAWS = 100;

const DOMAIN_WEIGHTS = {
  economic: 0.22,
  infrastructure: 0.20,
  energy: 0.15,
  'social-governance': 0.25,
  'health-food': 0.18,
};

const DOMAIN_ORDER = [
  'economic',
  'infrastructure',
  'energy',
  'social-governance',
  'health-food',
];

export function computeIntervals(domainScores, domainWeights, draws = DRAWS) {
  const samples = [];
  for (let i = 0; i < draws; i++) {
    const jittered = domainWeights.map((w) => w * (0.9 + Math.random() * 0.2));
    const sum = jittered.reduce((s, w) => s + w, 0);
    const normalized = jittered.map((w) => w / sum);
    const score = domainScores.reduce((s, d, idx) => s + d * normalized[idx], 0);
    samples.push(score);
  }
  samples.sort((a, b) => a - b);
  return {
    p05: Math.round(samples[Math.max(0, Math.ceil(draws * 0.05) - 1)] * 10) / 10,
    p95: Math.round(samples[Math.min(draws - 1, Math.ceil(draws * 0.95) - 1)] * 10) / 10,
  };
}

async function redisGetJson(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try { return unwrapEnvelope(JSON.parse(data.result)).data; } catch { return null; }
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

async function computeAndWriteIntervals(url, token, countryCodes, pipelineResults) {
  const weights = DOMAIN_ORDER.map((id) => DOMAIN_WEIGHTS[id]);
  const commands = [];

  for (let i = 0; i < countryCodes.length; i++) {
    const raw = pipelineResults[i]?.result ?? null;
    if (!raw || raw === 'null') continue;
    try {
      const score = JSON.parse(raw);
      if (!score.domains?.length) continue;

      const domainScores = DOMAIN_ORDER.map((id) => {
        const d = score.domains.find((dom) => dom.id === id);
        return d?.score ?? 0;
      });

      const interval = computeIntervals(domainScores, weights, DRAWS);
      const payload = {
        p05: interval.p05,
        p95: interval.p95,
        draws: DRAWS,
        computedAt: new Date().toISOString(),
      };
      commands.push(['SET', `${INTERVAL_KEY_PREFIX}${countryCodes[i]}`, JSON.stringify(payload), 'EX', INTERVAL_TTL_SECONDS]);
    } catch { /* skip malformed */ }
  }

  if (commands.length === 0) {
    console.log('[resilience-scores] No domain data available for intervals');
    return 0;
  }

  const PIPE_BATCH = 50;
  for (let i = 0; i < commands.length; i += PIPE_BATCH) {
    await redisPipeline(url, token, commands.slice(i, i + PIPE_BATCH));
  }
  console.log(`[resilience-scores] Wrote ${commands.length} interval keys`);

  await writeFreshnessMetadata('resilience', 'intervals', commands.length, '', INTERVAL_TTL_SECONDS);
  return commands.length;
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
      console.warn(`[resilience-scores] ${stillMissing.length} laggards found but neither WORLDMONITOR_API_KEY nor WORLDMONITOR_VALID_KEYS is set — skipping individual warmup`);
    }
    let laggardsWarmed = 0;
    if (stillMissing.length > 0 && WM_KEY) {
      console.log(`[resilience-scores] Warming ${stillMissing.length} laggards individually...`);
      const BATCH = 5;
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
        laggardsWarmed += results.filter(r => r.status === 'fulfilled').length;
      }
      console.log(`[resilience-scores] Laggards warmed: ${laggardsWarmed}/${stillMissing.length}`);
    }

    // The ranking cache (resilience:ranking:v9) needs to reflect the
    // freshly-warmed per-country scores. Two failure modes have to be handled:
    //
    //   1. Laggards were warmed individually after the bulk RPC. The ranking
    //      cache (written earlier) froze those countries as coverage-0
    //      greyedOut entries. Rebuild needed.
    //
    //   2. The bulk RPC's handler hit a read-after-write race: it called
    //      warmMissingResilienceScores() (writing 222 per-country keys), then
    //      its own re-read of those same keys returned an empty Map (Upstash
    //      pipeline visibility lag in the same Vercel invocation). Result:
    //      cachedScores.size = 0, every item built with `undefined` payload =
    //      coverage 0 = all 222 in greyedOut, coverage gate (cachedScores.size
    //      / countryCodes.length) = 0% < 75% → handler skips the SET → ranking
    //      cache stays null.
    //
    //      stillMissing is computed from the seeder's OWN pipeline GET (which
    //      sees the writes), so it correctly reports 0 laggards. The original
    //      `if (laggardsWarmed > 0)` gate would skip the rebuild — and we'd
    //      end up with all per-country scores cached but no ranking key.
    //
    // Fix: rebuild whenever (a) we warmed laggards OR (b) the ranking key is
    // null in Redis after the bulk call. Path (b) catches the race; the
    // second RPC call sees warm per-country scores in cache and the handler's
    // re-read succeeds.
    // Inline GET so we can distinguish "key absent" (rebuild needed) from
    // "GET failed" (rebuild as a precaution but log it for incident triage).
    // The shared redisGetJson() collapses both into null, which would silently
    // mask transient Upstash hiccups in the rebuild trigger reason.
    let rankingExists = null;
    let rankingProbeFailed = false;
    try {
      const probeResp = await fetch(`${url}/get/${encodeURIComponent(RESILIENCE_RANKING_CACHE_KEY)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!probeResp.ok) {
        rankingProbeFailed = true;
        console.warn(`[resilience-scores] Ranking probe HTTP ${probeResp.status}; rebuilding as a precaution`);
      } else {
        const data = await probeResp.json();
        rankingExists = data?.result || null;
      }
    } catch (err) {
      rankingProbeFailed = true;
      console.warn(`[resilience-scores] Ranking probe failed (${err.message}); rebuilding as a precaution`);
    }
    if (laggardsWarmed > 0 || rankingExists == null) {
      const reason = laggardsWarmed > 0
        ? `${laggardsWarmed} laggard warms`
        : (rankingProbeFailed ? 'ranking probe failed (precautionary)' : 'bulk-call race left ranking:v9 null');
      try {
        if (laggardsWarmed > 0) {
          await redisPipeline(url, token, [['DEL', RESILIENCE_RANKING_CACHE_KEY]]);
        }
        const rebuildHeaders = { 'User-Agent': SEED_UA, 'Accept': 'application/json' };
        if (WM_KEY) rebuildHeaders['X-WorldMonitor-Key'] = WM_KEY;
        const rebuildResp = await fetch(`${API_BASE}/api/resilience/v1/get-resilience-ranking`, {
          headers: rebuildHeaders,
          signal: AbortSignal.timeout(60_000),
        });
        if (rebuildResp.ok) {
          const rebuilt = await rebuildResp.json();
          const total = (rebuilt.items?.length ?? 0) + (rebuilt.greyedOut?.length ?? 0);
          console.log(`[resilience-scores] Rebuilt ${RESILIENCE_RANKING_CACHE_KEY} with ${total} countries (${reason})`);
        } else {
          console.warn(`[resilience-scores] Rebuild ranking HTTP ${rebuildResp.status} — ranking cache is null until next RPC call`);
        }
      } catch (err) {
        console.warn(`[resilience-scores] Failed to rebuild ranking cache: ${err.message}`);
      }
    }

    const finalResults = await redisPipeline(url, token, getCommands);
    const finalWarmed = countCachedFromPipeline(finalResults);
    console.log(`[resilience-scores] Final: ${finalWarmed}/${countryCodes.length} cached`);

    const intervalsWritten = await computeAndWriteIntervals(url, token, countryCodes, finalResults);
    return { skipped: false, recordCount: finalWarmed, total: countryCodes.length, intervalsWritten };
  }

  const intervalsWritten = await computeAndWriteIntervals(url, token, countryCodes, preResults);
  return { skipped: false, recordCount: preWarmed, total: countryCodes.length, intervalsWritten };
}

// Write seed-meta:resilience:ranking so api/health.js can track data freshness.
// Without this, the meta key is only written by the get-resilience-ranking RPC
// handler when a user hits it, and goes silently stale during quiet Pro usage —
// firing a misleading "7× stale" alarm in the health endpoint even while the
// underlying scores are fresh. Non-fatal on Redis failure; seed itself still
// completed successfully.
async function writeRankingSeedMeta(recordCount) {
  try {
    const { url, token } = getRedisCredentials();
    const meta = { fetchedAt: Date.now(), recordCount };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', 'seed-meta:resilience:ranking', JSON.stringify(meta), 'EX', 86400 * 7]),
      signal: AbortSignal.timeout(5_000),
    });
    // fetch() doesn't throw on non-2xx — we must check resp.ok explicitly.
    // Otherwise a 401/429/500 from Upstash silently looks like success, the
    // seed-meta stays stale, and /api/health keeps alerting without ops
    // knowing the write ever failed.
    if (!resp.ok) {
      const body = await resp.text().catch(() => '<unreadable>');
      console.warn(`[resilience-scores] seed-meta:resilience:ranking write failed: HTTP ${resp.status} — ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn('[resilience-scores] seed-meta:resilience:ranking write failed:', err?.message || err);
  }
}

async function main() {
  const startedAt = Date.now();
  const result = await seedResilienceScores();
  logSeedResult('resilience:scores', result.recordCount ?? 0, Date.now() - startedAt, {
    skipped: Boolean(result.skipped),
    ...(result.total != null && { total: result.total }),
    ...(result.reason != null && { reason: result.reason }),
    ...(result.intervalsWritten != null && { intervalsWritten: result.intervalsWritten }),
  });
  if (!result.skipped && (result.recordCount ?? 0) > 0) {
    await writeRankingSeedMeta(result.recordCount);
  }
}

if (process.argv[1]?.endsWith('seed-resilience-scores.mjs')) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
