#!/usr/bin/env node
import {
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  writeFreshnessMetadata,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { isInRankableUniverse } from './shared/rankable-universe.mjs';

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

// Bumped v13 → v14 in lockstep with server/worldmonitor/resilience/v1/
// _shared.ts for plan 2026-04-25-004 Phase 2 (Ship 2) — adds the new
// `financialSystemExposure` dim to the headline score; v13 entries lack
// the new dim's contribution so caching them post-deploy would surface
// stale partial-shape payloads.
// Earlier: v12 → v13 for plan 2026-04-25-004 Phase 1 (tradeSanctions →
// tradePolicy rename + dropped OFAC component + reweighted formula).
// Earlier: v11 → v12 for PR 3A §net-imports denominator (plan
// 2026-04-24-002). Seeder and server MUST agree on the prefix or the
// seeder writes scores the handler will never read.
export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v16:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v16';
// Must match the server-side RESILIENCE_RANKING_CACHE_TTL_SECONDS. Extended
// to 12h (2x the cron interval) so a missed/slow cron can't create an
// EMPTY_ON_DEMAND gap before the next successful rebuild.
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 12 * 60 * 60;
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';

const INTERVAL_KEY_PREFIX = 'resilience:intervals:v2:';
const INTERVAL_TTL_SECONDS = 7 * 24 * 60 * 60;
const DRAWS = 100;

// Plan 2026-04-26-002 review fix: 6-domain weights (recovery added) in
// lockstep with server/worldmonitor/resilience/v1/_dimension-scorers.ts
// `RESILIENCE_DOMAIN_WEIGHTS`. Bumped INTERVAL_KEY_PREFIX v1 → v2 in
// lockstep so old 5-domain bands don't feed scoreInterval/rankStable
// after the v15→v16 score-prefix bump.
const DOMAIN_WEIGHTS = {
  economic: 0.17,
  infrastructure: 0.15,
  energy: 0.11,
  'social-governance': 0.19,
  'health-food': 0.13,
  recovery: 0.25,
};

const DOMAIN_ORDER = [
  'economic',
  'infrastructure',
  'energy',
  'social-governance',
  'health-food',
  'recovery',
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
  // Plan 2026-04-26-002 §U2 (PR 1): defense-in-depth — filter to the
  // rankable universe (193 UN members + 3 SARs) here too, in case the
  // static index was seeded by an older version of seed-resilience-static
  // that hadn't yet applied the same filter. Both seeders consume the
  // same `isInRankableUniverse` helper to ensure their universes match;
  // this defensive filter prevents transient mismatch during deploys.
  const allCountries = (index?.countries ?? [])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const countryCodes = allCountries.filter(isInRankableUniverse);
  const droppedCount = allCountries.length - countryCodes.length;
  if (droppedCount > 0) {
    console.log(`[resilience-scores] Filtered ${droppedCount} non-rankable territories from static index (transitional — seed-resilience-static will catch up on next cron tick)`);
  }

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
      // ?refresh=1 MUST be set here. The ranking aggregate (12h TTL) routinely
      // outlives the per-country score keys (6h TTL), so in the post-6h /
      // pre-12h window the handler's cache-hit early-return would fire and
      // skip the whole warm path — scores would stay missing, coverage would
      // degrade, and only the per-country laggard fallback (or nothing, if
      // WM_KEY is absent) would recover. Forcing a recompute routes the call
      // through warmMissingResilienceScores and its chunked pipeline SET.
      const headers = { 'User-Agent': SEED_UA, 'Accept': 'application/json' };
      if (WM_KEY) headers['X-WorldMonitor-Key'] = WM_KEY;
      const resp = await fetch(`${API_BASE}/api/resilience/v1/get-resilience-ranking?refresh=1`, {
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

    const finalResults = await redisPipeline(url, token, getCommands);
    const finalWarmed = countCachedFromPipeline(finalResults);
    console.log(`[resilience-scores] Final: ${finalWarmed}/${countryCodes.length} cached`);

    const intervalsWritten = await computeAndWriteIntervals(url, token, countryCodes, finalResults);
    const rankingPresent = await refreshRankingAggregate({ url, token, laggardsWarmed });
    return { skipped: false, recordCount: finalWarmed, total: countryCodes.length, intervalsWritten, rankingPresent };
  }

  const intervalsWritten = await computeAndWriteIntervals(url, token, countryCodes, preResults);
  // Refresh the ranking aggregate on every cron, even when per-country
  // scores are still warm from the previous tick. Ranking has a 12h TTL vs
  // a 6h cron cadence — skipping the refresh when the key is still alive
  // would let it drift toward expiry without a rebuild, and a single missed
  // cron would then produce an EMPTY_ON_DEMAND gap before the next one runs.
  const rankingPresent = await refreshRankingAggregate({ url, token, laggardsWarmed: 0 });
  return { skipped: false, recordCount: preWarmed, total: countryCodes.length, intervalsWritten, rankingPresent };
}

// Trigger a ranking rebuild via the public endpoint EVERY cron, regardless of
// whether resilience:ranking:v9 is still live at probe time. Short-circuiting
// on "key present" left a timing hole: if the key was written late in a prior
// run and the next cron fires early, the key is still alive at probe time →
// rebuild skipped → key expires a short while later and stays absent until a
// cron eventually runs when it's missing. One cheap HTTP per cron keeps both
// the ranking AND its sibling seed-meta rolling forward, and self-heals the
// partial-pipeline case where ranking was written but meta wasn't — handler
// retries the atomic pair on every cron.
//
// Returns whether the ranking key is present in Redis after the rebuild
// attempt (observability only — no caller gates on this).
async function refreshRankingAggregate({ url, token, laggardsWarmed }) {
  const reason = laggardsWarmed > 0 ? `${laggardsWarmed} laggard warms` : 'scheduled cron refresh';
  try {
    // ?refresh=1 tells the handler to skip its cache-hit early-return and
    // recompute-then-SET atomically. Avoids the earlier "DEL then rebuild"
    // flow where a failed rebuild would leave the ranking absent instead of
    // stale-but-present.
    const rebuildHeaders = { 'User-Agent': SEED_UA, 'Accept': 'application/json' };
    if (WM_KEY) rebuildHeaders['X-WorldMonitor-Key'] = WM_KEY;
    const rebuildResp = await fetch(`${API_BASE}/api/resilience/v1/get-resilience-ranking?refresh=1`, {
      headers: rebuildHeaders,
      signal: AbortSignal.timeout(60_000),
    });
    if (rebuildResp.ok) {
      const rebuilt = await rebuildResp.json();
      const total = (rebuilt.items?.length ?? 0) + (rebuilt.greyedOut?.length ?? 0);
      console.log(`[resilience-scores] Refreshed ${RESILIENCE_RANKING_CACHE_KEY} with ${total} countries (${reason})`);
    } else {
      console.warn(`[resilience-scores] Refresh ranking HTTP ${rebuildResp.status} — ranking cache stays at its prior state until next cron`);
    }
  } catch (err) {
    console.warn(`[resilience-scores] Failed to refresh ranking cache: ${err.message}`);
  }

  // Verify BOTH the ranking data key AND the seed-meta key. Upstash REST
  // pipeline is non-transactional: the handler's atomic SET could land the
  // ranking but miss the meta, leaving /api/health reading stale meta over a
  // fresh ranking. If the meta didn't land within ~5 minutes, log a warning
  // so ops can grep for it — next cron will retry (ranking SET is
  // idempotent).
  const [rankingLen, metaFresh] = await Promise.all([
    fetch(`${url}/strlen/${encodeURIComponent(RESILIENCE_RANKING_CACHE_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.ok ? r.json() : null).then((d) => Number(d?.result || 0)).catch(() => 0),
    fetch(`${url}/get/seed-meta:resilience:ranking`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (!d?.result) return false;
      try {
        const meta = JSON.parse(d.result);
        return typeof meta?.fetchedAt === 'number' && (Date.now() - meta.fetchedAt) < 5 * 60 * 1000;
      } catch { return false; }
    }).catch(() => false),
  ]);
  const rankingPresent = rankingLen > 0;
  if (rankingPresent && !metaFresh) {
    console.warn(`[resilience-scores] Partial publish: ranking:v9 present but seed-meta not fresh — next cron will retry (handler SET is idempotent)`);
  }
  return rankingPresent;
}

// The seeder does NOT write seed-meta:resilience:ranking. Previously it did,
// as a "heartbeat" when Pro traffic was quiet — but it could only attest to
// "recordCount of per-country scores", not to whether `resilience:ranking:v9`
// was actually published this cron. The ranking handler gates its SET on a
// 75% coverage threshold and skips both the ranking and its meta when the
// gate fails; a stale-but-present ranking key combined with a fresh seeder
// meta write was exactly the "meta says fresh, data is stale" failure mode
// this PR exists to eliminate. The handler is now the sole writer of meta,
// and it writes both keys atomically via the same pipeline only when coverage
// passes. refreshRankingAggregate() triggers the handler every cron so meta
// never goes silently stale during quiet Pro usage — which was the original
// reason the seeder meta write existed.

async function main() {
  const startedAt = Date.now();
  const result = await seedResilienceScores();
  logSeedResult('resilience:scores', result.recordCount ?? 0, Date.now() - startedAt, {
    skipped: Boolean(result.skipped),
    ...(result.total != null && { total: result.total }),
    ...(result.reason != null && { reason: result.reason }),
    ...(result.intervalsWritten != null && { intervalsWritten: result.intervalsWritten }),
  });
  if (!result.skipped && (result.recordCount ?? 0) > 0 && !result.rankingPresent) {
    // Observability only — seeder never writes seed-meta. Health will flag the
    // stale meta on its own if this persists across multiple cron ticks.
    console.warn(`[resilience-scores] ${RESILIENCE_RANKING_CACHE_KEY} absent after rebuild attempt; handler-side coverage gate likely tripped. Next cron will retry.`);
  }
}

if (process.argv[1]?.endsWith('seed-resilience-scores.mjs')) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
