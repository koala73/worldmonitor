#!/usr/bin/env node
// @ts-check
/**
 * Scenario Engine Worker — always-on Railway service
 *
 * Atomically dequeues scenario jobs from Redis using BLMOVE (Redis 6.2 / Upstash),
 * runs computeScenario(), and writes results back to Redis with a 24-hour TTL.
 *
 * Railway config:
 *   rootDirectory: scripts
 *   startCommand:  node scenario-worker.mjs
 *   vCPUs: 1 / memoryGB: 1
 *   cronSchedule:  <none> (always-on long-running process)
 */

import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const QUEUE_KEY = 'scenario-queue:pending';
const PROCESSING_KEY = 'scenario-queue:processing';
const RESULT_TTL_SECONDS = 86_400; // 24 h
const BLMOVE_TIMEOUT_SECONDS = 30;  // block for up to 30s waiting for a job

/** @typedef {{ jobId: string; scenarioId: string; iso2: string | null; enqueuedAt: number }} ScenarioJob */

/**
 * Inline copy of SCENARIO_TEMPLATES (no TypeScript import).
 * Keep in sync with server/worldmonitor/supply-chain/v1/scenario-templates.ts.
 * Worker only needs: id, affectedChokepointIds, disruptionPct, durationDays, affectedHs2, costShockMultiplier.
 *
 * @type {Array<{ id: string; affectedChokepointIds: string[]; disruptionPct: number; durationDays: number; affectedHs2: string[] | null; costShockMultiplier: number }>}
 */
const SCENARIO_TEMPLATES = [
  {
    id: 'taiwan-strait-full-closure',
    affectedChokepointIds: ['taiwan_strait'],
    disruptionPct: 100,
    durationDays: 30,
    affectedHs2: ['84', '85', '87'],
    costShockMultiplier: 1.45,
  },
  {
    id: 'suez-bab-simultaneous',
    affectedChokepointIds: ['suez', 'bab_el_mandeb'],
    disruptionPct: 80,
    durationDays: 60,
    affectedHs2: null,
    costShockMultiplier: 1.35,
  },
  {
    id: 'panama-drought-50pct',
    affectedChokepointIds: ['panama'],
    disruptionPct: 50,
    durationDays: 90,
    affectedHs2: null,
    costShockMultiplier: 1.22,
  },
  {
    id: 'hormuz-tanker-blockade',
    affectedChokepointIds: ['hormuz_strait'],
    disruptionPct: 100,
    durationDays: 14,
    affectedHs2: ['27', '29'],
    costShockMultiplier: 2.10,
  },
  {
    id: 'russia-baltic-grain-suspension',
    affectedChokepointIds: ['bosphorus', 'dover_strait'],
    disruptionPct: 100,
    durationDays: 180,
    affectedHs2: ['10', '12'],
    costShockMultiplier: 1.55,
  },
  {
    id: 'us-tariff-escalation-electronics',
    affectedChokepointIds: [],
    disruptionPct: 0,
    durationDays: 365,
    affectedHs2: ['85'],
    costShockMultiplier: 1.50,
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Redis helpers (Upstash REST API)
// ────────────────────────────────────────────────────────────────────────────

/** @returns {{ url: string; token: string }} */
function getCredentials() {
  return getRedisCredentials();
}

/**
 * Execute a raw Redis command via Upstash REST API.
 * Uses the base-URL POST format (command as first body element) which is the only
 * format Upstash supports reliably — POST /{cmd} with args-only body is broken.
 * @param {string} cmd  e.g. "BLMOVE"
 * @param {unknown[]} args
 */
async function redisCmd(cmd, args) {
  const { url, token } = getCredentials();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([cmd.toUpperCase(), ...args]),
    signal: AbortSignal.timeout(40_000), // > BLMOVE_TIMEOUT_SECONDS
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis ${cmd} HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = /** @type {{ result: unknown }} */ (await resp.json());
  return body.result;
}

/**
 * GET a key — returns parsed JSON or null.
 * @param {string} key
 */
async function redisGet(key) {
  const { url, token } = getCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const body = /** @type {{ result?: string }} */ (await resp.json());
  return body.result ? JSON.parse(body.result) : null;
}

/**
 * SET a key with TTL (SETEX equivalent).
 * @param {string} key
 * @param {number} ttl  seconds
 * @param {string} value  serialised JSON string
 */
async function redisSetex(key, ttl, value) {
  await redisCmd('setex', [key, ttl, value]);
}

/**
 * Remove the first occurrence of `value` from list `key`.
 * @param {string} key
 * @param {string} value
 */
async function redisLrem(key, value) {
  await redisCmd('lrem', [key, 1, value]);
}

/**
 * Batch-GET multiple keys via a single Upstash pipeline request.
 * Returns an array of parsed JSON values (null for missing/unparseable keys).
 * @param {string[]} keys
 * @returns {Promise<Array<unknown | null>>}
 */
async function redisPipelineGet(keys) {
  if (keys.length === 0) return [];
  const { url, token } = getCredentials();
  const pipeline = keys.map(k => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const results = /** @type {Array<{ result: string | null }>} */ (await resp.json());
  return results.map(r => {
    if (!r?.result) return null;
    try { return JSON.parse(r.result); }
    catch { return null; }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario computation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the impact of a scenario across countries and HS2 sectors.
 *
 * Algorithm:
 * 1. Resolve the scenario template.
 * 2. Read live chokepoint statuses from Redis (supply_chain:chokepoints:v4).
 * 3. For each affected chokepoint, scan cached exposure keys for the
 *    specified iso2 (or all seeded reporters if iso2 is null).
 * 4. Compute adjusted impact: exposureScore × (disruptionPct / 100) × costShockMultiplier.
 * 5. Return top-20 countries by impact + per-chokepoint metadata.
 *
 * @param {string} scenarioId
 * @param {string | null} iso2  scope to one country, or null = all reporters
 * @returns {Promise<object>}
 */
async function computeScenario(scenarioId, iso2) {
  const template = SCENARIO_TEMPLATES.find(t => t.id === scenarioId);
  if (!template) throw new Error(`Unknown scenario: ${scenarioId}`);

  // Read live chokepoint data for context (best-effort).
  // Cache shape: { chokepoints: ChokepointInfo[], fetchedAt, upstreamUnavailable }
  const cpData = await redisGet('supply_chain:chokepoints:v4').catch(() => null);

  /** @type {Map<string, number>} chokepointId → current disruptionScore */
  const currentScores = new Map();
  const cpArray = Array.isArray(cpData?.chokepoints) ? cpData.chokepoints : [];
  for (const cp of cpArray) {
    if (cp?.id && typeof cp.disruptionScore === 'number') {
      currentScores.set(cp.id, cp.disruptionScore);
    }
  }

  // The reporters seeded in v1 (US, China, Russia, Iran, India, Taiwan)
  const SEEDED_REPORTERS = ['US', 'CN', 'RU', 'IR', 'IN', 'TW'];
  const reportersToCheck = iso2 ? [iso2] : SEEDED_REPORTERS;

  /** @type {Array<{ iso2: string; hs2: string; exposureScore: number; adjustedImpact: number; chokepointId: string }>} */
  const impacts = [];

  // Tariff-shock scenarios have no physical chokepoint closure (affectedChokepointIds: []).
  // They affect all countries that trade the targeted HS2 sectors regardless of route.
  const isTariffShock = template.affectedChokepointIds.length === 0;

  // Hoist hs2Chapters outside the reporter loop — depends only on template, not reporter.
  const hs2Chapters = template.affectedHs2 ?? Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0'));

  // Build all keys upfront for a single pipeline GET (avoids N×M sequential requests).
  /** @type {string[]} */
  const allKeys = [];
  for (const reporter of reportersToCheck) {
    for (const hs2 of hs2Chapters) {
      allKeys.push(`supply-chain:exposure:${reporter}:${hs2}:v1`);
    }
  }

  // Single pipeline call replaces the nested sequential redisGet() calls.
  const pipelineResults = await redisPipelineGet(allKeys);

  // Process results with the same tariff-shock vs regular logic.
  let idx = 0;
  for (const reporter of reportersToCheck) {
    for (const hs2 of hs2Chapters) {
      const data = /** @type {{ iso2?: string; hs2?: string; exposures?: Array<{ chokepointId: string; exposureScore: number }>; vulnerabilityIndex?: number } | null} */ (pipelineResults[idx++]);
      if (!data || !Array.isArray(data.exposures)) continue;

      if (isTariffShock) {
        // Tariff shock: all reporters trading this HS2 sector are impacted.
        // Use vulnerabilityIndex as a proxy for overall trade exposure.
        const vulnScore = typeof data.vulnerabilityIndex === 'number' ? data.vulnerabilityIndex : 0;
        if (vulnScore > 0) {
          const adjustedImpact = vulnScore * template.costShockMultiplier;
          impacts.push({ iso2: reporter, hs2, exposureScore: vulnScore, adjustedImpact, chokepointId: 'tariff' });
        }
        continue;
      }

      for (const entry of data.exposures) {
        if (!entry?.chokepointId || typeof entry.exposureScore !== 'number') continue;
        // Only count chokepoints that this scenario actually disrupts
        if (!template.affectedChokepointIds.includes(entry.chokepointId)) continue;

        const exposureScore = entry.exposureScore;
        // adjustedImpact: exposureScore × disruptionPct% × costShockMultiplier
        // (No importValue in cache — relative ranking by score is sufficient for v1)
        const adjustedImpact = exposureScore * (template.disruptionPct / 100) * template.costShockMultiplier;

        if (exposureScore > 0) {
          impacts.push({ iso2: reporter, hs2, exposureScore, adjustedImpact, chokepointId: entry.chokepointId });
        }
      }
    }
  }

  // Aggregate by country
  /** @type {Map<string, number>} iso2 → total adjusted impact */
  const byCountry = new Map();
  for (const item of impacts) {
    byCountry.set(item.iso2, (byCountry.get(item.iso2) ?? 0) + item.adjustedImpact);
  }

  const sorted = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const maxImpact = Math.max(sorted[0]?.[1] ?? 0, 1);
  const topImpactCountries = sorted.map(([countryIso2, totalImpact]) => ({
    iso2: countryIso2,
    totalImpact,
    // Relative share of the worst-hit country, capped at 100
    impactPct: Math.min(Math.round((totalImpact / maxImpact) * 100), 100),
  }));

  return {
    scenarioId,
    template: {
      name: template.affectedChokepointIds.join('+') || 'tariff_shock',
      disruptionPct: template.disruptionPct,
      durationDays: template.durationDays,
      costShockMultiplier: template.costShockMultiplier,
    },
    affectedChokepointIds: template.affectedChokepointIds,
    currentDisruptionScores: Object.fromEntries(
      template.affectedChokepointIds.map(id => [id, currentScores.get(id) ?? null]),
    ),
    topImpactCountries,
    affectedHs2: template.affectedHs2,
    scopedIso2: iso2,
    computedAt: Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Orphan drain + SIGTERM handling
// ────────────────────────────────────────────────────────────────────────────

let shuttingDown = false;

process.on('SIGTERM', () => {
  shuttingDown = true;
});

/**
 * At startup, requeue any jobs left in the processing list from a previous crash.
 */
async function requeueOrphanedJobs() {
  let moved;
  let count = 0;
  do {
    moved = await redisCmd('lmove', [PROCESSING_KEY, QUEUE_KEY, 'RIGHT', 'LEFT']).catch(() => null);
    if (moved) count++;
  } while (moved);
  if (count > 0) console.log(`[scenario-worker] requeued ${count} orphaned jobs`);
}

// ────────────────────────────────────────────────────────────────────────────
// Job payload validation
// ────────────────────────────────────────────────────────────────────────────

const JOB_ID_RE = /^scenario:\d{13}:[a-z0-9]{8}$/;

// ────────────────────────────────────────────────────────────────────────────
// Main worker loop
// ────────────────────────────────────────────────────────────────────────────

async function runWorker() {
  console.log('[scenario-worker] starting — listening on scenario-queue:pending');

  await requeueOrphanedJobs();

  while (!shuttingDown) {
    let raw;
    try {
      // Atomic FIFO dequeue+claim: moves item from pending → processing.
      // Note: Upstash REST API does not honour the BLMOVE blocking timeout —
      // it returns null immediately for empty queues. The 5s sleep below prevents
      // busy-looping when the queue is idle.
      raw = await redisCmd('blmove', [QUEUE_KEY, PROCESSING_KEY, 'LEFT', 'RIGHT', BLMOVE_TIMEOUT_SECONDS]);
    } catch (err) {
      console.error('[scenario-worker] BLMOVE error:', err.message);
      // Brief pause before retrying to avoid hot-loop on connectivity issues
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    if (!raw) {
      // Upstash REST returns null immediately for empty queue (no true HTTP blocking).
      // Sleep before retrying to avoid busy-loop burning CPU.
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    /** @type {ScenarioJob | null} */
    let job = null;
    try {
      job = JSON.parse(String(raw));
    } catch {
      console.error('[scenario-worker] Unparseable job payload, discarding:', String(raw).slice(0, 100));
      await redisLrem(PROCESSING_KEY, String(raw)).catch(() => null);
      continue;
    }

    const { jobId, scenarioId, iso2 } = job;

    // Validate payload fields before using any as Redis key fragments.
    if (
      typeof jobId !== 'string' || !JOB_ID_RE.test(jobId) ||
      typeof scenarioId !== 'string' ||
      (iso2 !== null && (typeof iso2 !== 'string' || !/^[A-Z]{2}$/.test(iso2)))
    ) {
      console.error('[scenario-worker] Job failed field validation, discarding:', String(raw).slice(0, 100));
      await redisLrem(PROCESSING_KEY, String(raw)).catch(() => null);
      continue;
    }

    console.log(`[scenario-worker] processing ${jobId} (${scenarioId}, iso2=${iso2 ?? 'all'})`);

    // Idempotency: skip if result already written
    const resultKey = `scenario-result:${jobId}`;
    const existing = await redisGet(resultKey).catch(() => null);
    if (existing) {
      console.log(`[scenario-worker] ${jobId} already processed, skipping`);
      await redisLrem(PROCESSING_KEY, String(raw)).catch(() => null);
      continue;
    }

    // Write processing state immediately so status.ts can reflect in-flight work.
    await redisSetex(resultKey, RESULT_TTL_SECONDS,
      JSON.stringify({ status: 'processing', startedAt: Date.now() }),
    ).catch(() => null);

    try {
      const result = await computeScenario(scenarioId, iso2);
      await redisSetex(
        resultKey,
        RESULT_TTL_SECONDS,
        JSON.stringify({ status: 'done', result, completedAt: Date.now() }),
      );
      console.log(`[scenario-worker] ${jobId} done — ${result.topImpactCountries.length} countries impacted`);
    } catch (err) {
      console.error(`[scenario-worker] ${jobId} failed:`, err.message);
      await redisSetex(
        resultKey,
        RESULT_TTL_SECONDS,
        JSON.stringify({ status: 'failed', error: 'computation_error', failedAt: Date.now() }),
      ).catch(() => null);
    } finally {
      // Always remove from processing list so the queue doesn't stall
      await redisLrem(PROCESSING_KEY, String(raw)).catch(() => null);
    }
  }

  console.log('[scenario-worker] shutdown complete (SIGTERM received)');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  runWorker().catch(err => {
    console.error('[scenario-worker] fatal:', err);
    process.exit(1);
  });
}
