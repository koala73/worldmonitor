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

import { pathToFileURL } from 'node:url';
import { getRedisCredentials, loadEnvFile, withRetry } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const QUEUE_KEY = 'scenario-queue:pending';
const PROCESSING_KEY = 'scenario-queue:processing';
const RESULT_TTL_SECONDS = 86_400; // 24 h
const BLMOVE_TIMEOUT_SECONDS = 30;  // block for up to 30s waiting for a job

// Keys per exposure pipeline request. A full-scope run reads
// len(countryIds) x len(hs2Codes) keys (197 x 17 = 3,349 today), so this sets how many
// sequential Upstash round-trips the job costs: 3,349 / 350 = 10 rather than 34.
// tests/scenario-worker.test.mjs derives its expected batch sizes from this constant.
export const EXPOSURE_BATCH_SIZE = 350;
// Wall-clock budget for computeScenario. The panel polls 60 x 1s before giving up
// (src/components/SupplyChainPanel.ts), so a job that outlives that window only stalls
// the single-threaded queue for jobs behind it. Landing inside it keeps the result useful.
const COMPUTE_BUDGET_MS = 45_000;

/** @typedef {{ jobId: string; scenarioId: string; iso2: string | null; disruptionPct?: number; enqueuedAt: number }} ScenarioJob */

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
 * Returns parsed records, null for absent keys, and an invalid object for malformed JSON.
 * @param {string[]} keys
 * @param {number} deadline
 * @returns {Promise<Array<unknown | null>>}
 */
async function redisPipelineGet(keys, deadline) {
  if (keys.length === 0) return [];
  // Retried: this pipeline is now fail-closed (a short array or any per-entry error
  // aborts the whole job), and a full-scope run makes several sequential requests, so
  // one transient blip would otherwise fail the entire scenario with no recourse.
  return withRetry(async () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw Object.assign(new Error('Scenario computation budget exhausted'), { nonRetryable: true });
    }
    const { url, token } = getCredentials();
    const pipeline = keys.map(k => ['GET', k]);
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(Math.min(30_000, remainingMs)),
    }).catch(err => {
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('Scenario computation budget exhausted'), { nonRetryable: true });
      }
      throw err;
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Redis pipeline HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const results = /** @type {Array<{ result: string | null }>} */ (await resp.json());
    if (!Array.isArray(results) || results.length !== keys.length || results.some(r => r?.error)) {
      throw new Error('Incomplete Redis exposure pipeline');
    }
    return results.map(r => {
      if (r.result === null) return null;
      try { return JSON.parse(r.result) ?? {}; }
      catch { return {}; }
    });
  }, 2, 250);
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario computation
// ────────────────────────────────────────────────────────────────────────────

/** @param {number} score @param {number} severity @param {number} multiplier */
export function physicalImpact(score, severity, multiplier) {
  return score * (severity / 100) * multiplier;
}

/**
 * @param {string} scenarioId
 * @param {string | null} iso2
 * @param {number | undefined} [disruptionPct]
 */
export async function computeScenario(scenarioId, iso2, disruptionPct) {
  const template = SCENARIO_TEMPLATES.find(t => t.id === scenarioId);
  if (!template) throw new Error(`Unknown scenario: ${scenarioId}`);
  const isTariffShock = template.affectedChokepointIds.length === 0;
  if (iso2 !== null && (typeof iso2 !== 'string' || !/^[A-Z]{2}$/.test(iso2))) {
    throw new Error('Invalid country');
  }
  if (disruptionPct !== undefined && (isTariffShock || !Number.isInteger(disruptionPct) || disruptionPct < 0 || disruptionPct > 100)) {
    throw new Error('Invalid disruption override');
  }
  const severity = disruptionPct ?? template.disruptionPct;
  const manifest = await redisGet('seed-meta:supply_chain:chokepoint-exposure').catch(() => null);
  const validIds = (values, pattern, limit) => Array.isArray(values) && values.length > 0
    && values.length <= limit && values.every(v => typeof v === 'string' && pattern.test(v))
    && new Set(values).size === values.length;
  // Deliberately NOT gated on `manifest.status === 'ok'`. The manifest's country/sector
  // arrays describe the seeder's static universe, not the outcome of its last run — a
  // failed run leaves them true while invalidating per-key freshness, which the per-record
  // `missing` state already reports. Requiring 'ok' here turned any single seeder failure
  // into a total feature blackout even though the exposure keys stay TTL-extended.
  const manifestKnown = manifest?.manifestVersion === 1
    && validIds(manifest.countryIds, /^[A-Z]{2}$/, 250)
    && validIds(manifest.hs2Codes, /^(0[1-9]|[1-9][0-9])$/, 99);
  const countryIds = iso2 ? [iso2] : manifestKnown ? manifest.countryIds : [];
  const hs2Codes = template.affectedHs2 ?? (manifestKnown ? manifest.hs2Codes : []);
  const records = [];
  const pending = [];
  if (manifestKnown) {
    // Set lookups: the double loop runs len(countryIds) x len(hs2Codes) times
    // (197 x 17 = 3,349 at current cardinality) and Array.includes is O(n).
    const seededCountries = new Set(manifest.countryIds);
    const seededHs2 = new Set(manifest.hs2Codes);
    for (const country of countryIds) {
      for (const hs2 of hs2Codes) {
        const seeded = seededCountries.has(country) && seededHs2.has(hs2);
        const record = { iso2: country, hs2, state: seeded ? 'missing' : 'not_seeded', basis: '', fetchedAt: '' };
        records.push(record);
        if (seeded) pending.push(record);
      }
    }
  }
  const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  const byCountry = new Map();
  // Per-country evidence tally, so an aggregate built from incomplete evidence is not
  // presented as that country's impact. Keyed by iso2 -> { evaluated, requested }.
  const byCountryEvidence = new Map();
  for (const record of records) {
    const tally = byCountryEvidence.get(record.iso2) ?? { evaluated: 0, requested: 0 };
    tally.requested++;
    byCountryEvidence.set(record.iso2, tally);
  }
  const deadline = Date.now() + COMPUTE_BUDGET_MS;
  for (let offset = 0; offset < pending.length; offset += EXPOSURE_BATCH_SIZE) {
    // Unread records keep their pre-set 'missing' state, so an exhausted budget
    // reports partial coverage truthfully rather than silently returning fewer countries.
    if (Date.now() >= deadline) break;
    const batch = pending.slice(offset, offset + EXPOSURE_BATCH_SIZE);
    let values;
    try {
      values = await redisPipelineGet(batch.map(r => `supply-chain:exposure:${r.iso2}:${r.hs2}:v1`), deadline);
    } catch (err) {
      if (Date.now() >= deadline) break;
      throw err;
    }
    for (let i = 0; i < batch.length; i++) {
      const record = batch[i];
      const data = values[i];
      if (data === null) continue;
      record.state = 'malformed';
      if (!data || data.iso2 !== record.iso2 || data.hs2 !== record.hs2
        || !['flow_weighted', 'country_route_fallback'].includes(data.coverage)
        || !Array.isArray(data.exposures) || data.exposures.length === 0
        || data.exposures.some(e => !e || typeof e.chokepointId !== 'string' || !validScore(e.exposureScore))
        || new Set(data.exposures.map(e => e.chokepointId)).size !== data.exposures.length) continue;
      const affected = data.exposures.filter(e => template.affectedChokepointIds.includes(e.chokepointId));
      if (isTariffShock && !validScore(data.vulnerabilityIndex)) continue;
      // A shortfall here is NOT corrupt cache: both seeder builders emit one entry per
      // registry chokepoint, so a missing entry means the seeder's chokepoint registry and
      // this file's SCENARIO_TEMPLATES have drifted. Report that as its own state instead
      // of blaming the cache.
      if (!isTariffShock && affected.length !== template.affectedChokepointIds.length) {
        record.state = 'incomplete_routes';
        continue;
      }
      const rawImpact = isTariffShock
        ? data.vulnerabilityIndex * template.costShockMultiplier
        : affected.reduce((sum, e) => sum + physicalImpact(e.exposureScore, severity, template.costShockMultiplier), 0);
      Object.assign(record, {
        state: 'evaluated', basis: data.coverage, rawImpact,
        fetchedAt: typeof data.fetchedAt === 'string' && Number.isFinite(Date.parse(data.fetchedAt)) ? data.fetchedAt : '',
      });
      byCountry.set(record.iso2, (byCountry.get(record.iso2) ?? 0) + rawImpact);
      const tally = byCountryEvidence.get(record.iso2);
      if (tally) tally.evaluated++;
    }
  }
  const sorted = [...byCountry.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20);
  const maxImpact = Math.max(sorted[0]?.[1] ?? 0, 1);
  return {
    scenarioId,
    template: {
      name: template.affectedChokepointIds.join('+') || 'tariff_shock',
      disruptionPct: severity,
      durationDays: template.durationDays,
      costShockMultiplier: template.costShockMultiplier,
    },
    affectedChokepointIds: template.affectedChokepointIds,
    topImpactCountries: sorted.map(([countryIso2, totalImpact]) => {
      const tally = byCountryEvidence.get(countryIso2) ?? { evaluated: 0, requested: 0 };
      return {
        iso2: countryIso2, totalImpact,
        impactPct: Math.min(Math.round((totalImpact / maxImpact) * 100), 100),
        // A total built from part of the requested evidence is a lower-bound subtotal,
        // not the country's impact. Consumers must not read it as low exposure.
        evaluatedRecords: tally.evaluated,
        requestedRecords: tally.requested,
        partialEvidence: tally.evaluated < tally.requested,
      };
    }),
    scopedIso2: iso2 ?? '',
    computedAt: new Date().toISOString(),
    coverage: {
      // `records.length > 0` guard: every() is vacuously true on an empty array, which
      // would report "complete" for a run that evaluated nothing.
      status: !manifestKnown ? 'unknown'
        : records.length > 0 && records.every(r => r.state === 'evaluated') ? 'complete'
        : 'partial',
      countryIds, hs2Codes, records,
      manifestFetchedAt: manifestKnown && typeof manifest.fetchedAt === 'number' && Number.isFinite(manifest.fetchedAt)
        && Math.abs(manifest.fetchedAt) <= 8.64e15 ? new Date(manifest.fetchedAt).toISOString() : '',
    },
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

    const { jobId, scenarioId, iso2, disruptionPct } = job;

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
      const result = await computeScenario(scenarioId, iso2, disruptionPct);
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runWorker().catch(err => {
    console.error('[scenario-worker] fatal:', err);
    process.exit(1);
  });
}
