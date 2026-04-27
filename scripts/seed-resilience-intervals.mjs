#!/usr/bin/env node
import {
  acquireLockSafely,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  writeFreshnessMetadata,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
// Reuse WORLDMONITOR_VALID_KEYS when a dedicated WORLDMONITOR_API_KEY isn't set.
// See seed-resilience-scores.mjs for the rationale.
const WM_KEY = process.env.WORLDMONITOR_API_KEY
  || (process.env.WORLDMONITOR_VALID_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)[0]
  || '';
const SEED_UA = 'Mozilla/5.0 (compatible; WorldMonitor-Seed/1.0)';

const INTERVAL_KEY_PREFIX = 'resilience:intervals:v2:';
const INTERVAL_TTL_SECONDS = 7 * 24 * 60 * 60;
const DRAWS = 100;

// Plan 2026-04-26-002 review fix: 6-domain weights (recovery added) in
// lockstep with server/worldmonitor/resilience/v1/_dimension-scorers.ts
// `RESILIENCE_DOMAIN_WEIGHTS`. The pre-PR 5-domain weights here mixed
// recovery into nothing, then computed a 5-domain score-band band that
// the server's 6-domain coverage-weighted overall score never matched.
// Bumped INTERVAL_KEY_PREFIX v1 → v2 in lockstep so post-bump readers
// see only post-fix bands.
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

async function fetchScore(countryCode) {
  const headers = { 'User-Agent': SEED_UA, Accept: 'application/json' };
  if (WM_KEY) headers['X-WorldMonitor-Key'] = WM_KEY;
  const url = `${API_BASE}/api/resilience/v1/get-resilience-score?countryCode=${countryCode}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Score endpoint returned HTTP ${resp.status} for ${countryCode}`);
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

    const BATCH = 10;
    let computed = 0;
    const commands = [];

    for (let i = 0; i < allItems.length; i += BATCH) {
      const batch = allItems.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((item) => fetchScore(item.countryCode)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status !== 'fulfilled') {
          console.warn(`[resilience-intervals] Failed ${batch[j].countryCode}: ${result.reason?.message}`);
          continue;
        }
        const scoreData = result.value;
        if (!scoreData?.domains?.length) continue;

        const domainScores = DOMAIN_ORDER.map((id) => {
          const d = scoreData.domains.find((dom) => dom.id === id);
          return d?.score ?? 0;
        });
        const weights = DOMAIN_ORDER.map((id) => DOMAIN_WEIGHTS[id]);

        const interval = computeIntervals(domainScores, weights, DRAWS);
        const payload = {
          p05: interval.p05,
          p95: interval.p95,
          draws: DRAWS,
          computedAt: new Date().toISOString(),
        };

        const key = `${INTERVAL_KEY_PREFIX}${scoreData.countryCode}`;
        commands.push(['SET', key, JSON.stringify(payload), 'EX', INTERVAL_TTL_SECONDS]);
        computed++;
      }
    }

    if (commands.length > 0) {
      const PIPE_BATCH = 50;
      for (let i = 0; i < commands.length; i += PIPE_BATCH) {
        await redisPipeline(url, token, commands.slice(i, i + PIPE_BATCH));
      }
    }

    console.log(`[resilience-intervals] Wrote ${computed}/${allItems.length} intervals`);
    return { skipped: false, recordCount: computed, total: allItems.length };
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
