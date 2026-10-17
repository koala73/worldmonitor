#!/usr/bin/env node
/**
 * Shipping v2 chokepoint disruption webhook delivery — always-on Railway service.
 *
 * Railway config:
 *   - Service name: shipping-webhook-worker
 *   rootDirectory: scripts
 *   startCommand: node shipping-webhook-worker.mjs
 *   cronSchedule: <none> (always-on long-running process)
 *
 * Every tick reads the chokepoint status feed, compares each subscriber's
 * chokepoints with its alertThreshold, and POSTs a signed
 * `chokepoint.disruption` event once per upward crossing. Delivery state per
 * (subscriber, chokepoint) lives in `webhook:state:<id>:v1`; delivery counters
 * live on the subscriber record. Delivery is at-least-once.
 */

import { randomUUID } from 'node:crypto';

import {
  CHROME_UA,
  acquireLockSafely,
  allSettledWithConcurrency,
  loadEnvFile,
  releaseLock,
} from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';
import {
  ALL_INDEX_KEY,
  DELIVERY_FAILURE_CEILING,
  deliverShippingWebhook,
  webhookKey,
} from './lib/shipping-webhook-delivery.mjs';

export const CHOKEPOINT_STATUS_KEY = 'supply_chain:chokepoints:v4';
export const CHOKEPOINT_STATUS_RPC_URL = 'https://api.worldmonitor.app/api/supply-chain/v1/get-chokepoint-status';
export const WORKER_STATUS_KEY = 'shipping:webhook-worker:v1';
export const WORKER_META_KEY = 'seed-meta:shipping:webhook-worker';
export const WORKER_ACTIVATION_KEY = 'seed-activated:shipping:webhook-worker';
export const BACKFILL_CURSOR_KEY = `${ALL_INDEX_KEY}:backfill`;
export const LOCK_DOMAIN = 'shipping-webhook-worker';
export const TRANSIT_DROP_WOW_PCT = -25;

const DEFAULT_TICK_MS = 5 * 60_000;
const LOCK_TTL_MS = 270_000;
const BATCH_SIZE = 100;
const DELIVERY_CONCURRENCY = 4;
const BACKFILL_SCAN_COUNT = 1000;
const BACKFILL_PAGE_CAP = 200;
const META_TTL_SECONDS = 7 * 86_400;
const STATUS_TTL_SECONDS = 3_600;
const STATE_TTL_SECONDS = 30 * 86_400;
const REDIS_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 30_000;

// Compare-and-set: a rotate-secret or reactivate that lands mid-tick wins, and
// this tick's counter update is dropped rather than resurrecting the old record.
const RECORD_CAS_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL') return 1 end return 0";

export function stateKey(subscriberId) {
  return `webhook:state:${subscriberId}:v1`;
}

/** First match wins. */
export const REASON_RULES = Object.freeze([
  { reason: 'ais_congestion_spike', matches: (cp) => Number(cp.aisDisruptions) > 0 },
  { reason: 'navigational_warning', matches: (cp) => Number(cp.activeWarnings) > 0 },
  {
    reason: 'transit_drop',
    matches: (cp) => cp.transitSummary?.todayCountsAvailable === true
      && Number.isFinite(cp.transitSummary?.wowChangePct)
      && cp.transitSummary.wowChangePct <= TRANSIT_DROP_WOW_PCT,
  },
  { reason: 'score_threshold', matches: () => true },
]);

export function reasonFor(chokepoint) {
  return REASON_RULES.find((rule) => rule.matches(chokepoint)).reason;
}

/**
 * armed --(score >= threshold)--> deliver; a successful delivery disarms.
 * disarmed --(score < threshold)--> armed. Missing state is armed.
 */
export function nextChokepointState(previous, score, threshold) {
  const armed = previous?.armed ?? true;
  const lastDeliveredAt = previous?.lastDeliveredAt;
  const state = { armed: score < threshold ? true : armed, lastScore: score };
  if (lastDeliveredAt) state.lastDeliveredAt = lastDeliveredAt;
  return { fire: armed && score >= threshold, state };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.subscriberId === 'string'
    && typeof value.callbackUrl === 'string'
    && typeof value.secret === 'string'
    && Array.isArray(value.chokepointIds)
    && Number.isFinite(value.alertThreshold);
}

export function parseRecord(raw) {
  try {
    const record = JSON.parse(raw);
    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

export function parseStateHash(flat) {
  const state = {};
  if (!Array.isArray(flat)) return state;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try {
      const value = JSON.parse(flat[i + 1]);
      if (value && typeof value.armed === 'boolean') state[flat[i]] = value;
    } catch { /* an unreadable field is treated as missing, which is armed */ }
  }
  return state;
}

/**
 * Pure. `records` are active, parsed subscriber records; `states` maps
 * subscriberId to its stored per-chokepoint state.
 */
export function planTick({ chokepoints, records, states, now, scoresFetchedAt }) {
  const byId = new Map(chokepoints
    .filter((cp) => typeof cp?.id === 'string' && Number.isFinite(cp.disruptionScore))
    .map((cp) => [cp.id, cp]));
  const triggeredAt = new Date(now).toISOString();
  const deliveries = [];
  const nextStates = new Map();
  for (const record of records) {
    const previous = states.get(record.subscriberId) ?? {};
    const next = {};
    for (const chokepointId of record.chokepointIds) {
      const chokepoint = byId.get(chokepointId);
      if (!chokepoint) continue;
      const score = chokepoint.disruptionScore;
      const { fire, state } = nextChokepointState(previous[chokepointId], score, record.alertThreshold);
      next[chokepointId] = state;
      if (!fire) continue;
      deliveries.push({
        record,
        chokepoint,
        payload: {
          subscriberId: record.subscriberId,
          chokepointId,
          score,
          alertThreshold: record.alertThreshold,
          triggeredAt,
          reason: reasonFor(chokepoint),
          details: {
            name: chokepoint.name ?? chokepointId,
            status: chokepoint.status ?? null,
            activeWarnings: chokepoint.activeWarnings ?? 0,
            aisDisruptions: chokepoint.aisDisruptions ?? 0,
            congestionLevel: chokepoint.congestionLevel ?? null,
            warRiskTier: chokepoint.warRiskTier ?? null,
            wowChangePct: chokepoint.transitSummary?.todayCountsAvailable === true
              && Number.isFinite(chokepoint.transitSummary?.wowChangePct)
              ? chokepoint.transitSummary.wowChangePct
              : null,
            previousScore: previous[chokepointId]?.lastScore ?? null,
            scoresFetchedAt: scoresFetchedAt ?? null,
          },
        },
      });
    }
    nextStates.set(record.subscriberId, next);
  }
  return { deliveries, nextStates };
}

/** Pure. Applies one delivery outcome to the subscriber record. */
export function settleRecord(record, outcome, now) {
  const at = new Date(now).toISOString();
  if (outcome.ok) {
    const { lastDeliveryError: _lastDeliveryError, ...rest } = record;
    return { ...rest, failureCount: 0, lastDeliveryAt: at, lastDeliveryStatus: outcome.status };
  }
  const failureCount = (Number.isSafeInteger(record.failureCount) ? record.failureCount : 0) + 1;
  const settled = {
    ...record,
    failureCount,
    lastDeliveryAt: at,
    lastDeliveryStatus: outcome.status > 0 ? outcome.status : null,
    lastDeliveryError: outcome.error ?? 'unknown',
  };
  if (failureCount >= DELIVERY_FAILURE_CEILING) {
    settled.active = false;
    settled.deactivatedAt = at;
  }
  return settled;
}

function isChokepointResponse(value) {
  return Boolean(value) && typeof value === 'object'
    && Array.isArray(value.chokepoints) && value.chokepoints.length > 0;
}

function parseChokepointResponse(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return isChokepointResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The RPC caches the feed in Redis for 5 minutes only, so the key is often
 * absent between dashboard reads. On a miss, call the RPC the way the AIS
 * relay's warm-ping does and use its response directly.
 */
export async function readChokepointStatus({ redis, fetchImpl, env }) {
  const [row] = await redis([['GET', CHOKEPOINT_STATUS_KEY]]);
  const cached = parseChokepointResponse(row?.result);
  if (cached) return { ...cached, source: 'redis' };
  if (!env.WORLDMONITOR_RELAY_KEY) return null;
  try {
    const response = await fetchImpl(CHOKEPOINT_STATUS_RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CHROME_UA,
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': env.WORLDMONITOR_RELAY_KEY,
      },
      body: '{}',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const fetched = parseChokepointResponse(await response.text());
    return fetched ? { ...fetched, source: 'rpc' } : null;
  } catch {
    return null;
  }
}

function assertRows(rows, expected, label) {
  if (!Array.isArray(rows) || rows.length !== expected) {
    throw new Error(`${label}: expected ${expected} Redis results, got ${Array.isArray(rows) ? rows.length : typeof rows}`);
  }
  const failed = rows.find((row) => !row || row.error);
  if (failed) throw new Error(`${label}: ${failed?.error ?? 'missing result'}`);
  return rows;
}

async function runBatched(redis, items, toCommand, label) {
  const results = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const rows = assertRows(await redis(batch.map(toCommand)), batch.length, label);
    results.push(...rows.map((row) => row.result));
  }
  return results;
}

/**
 * Records registered before the global index existed are found once by a
 * resumable SCAN. The cursor key, not the index's existence, gates this: the
 * API can SADD a new subscriber before the worker's first tick.
 */
async function backfillIndex(redis) {
  const [progress] = assertRows(await redis([['GET', BACKFILL_CURSOR_KEY]]), 1, 'backfill cursor');
  if (progress.result === 'done') return 0;
  let cursor = typeof progress.result === 'string' && /^\d+$/.test(progress.result) ? progress.result : '0';
  let found = 0;
  for (let page = 0; page < BACKFILL_PAGE_CAP; page += 1) {
    const [scan] = assertRows(
      await redis([['SCAN', cursor, 'MATCH', 'webhook:sub:*:v1', 'COUNT', String(BACKFILL_SCAN_COUNT)]]),
      1,
      'backfill scan',
    );
    const [nextCursor, keys] = Array.isArray(scan.result) ? scan.result : ['0', []];
    const ids = (Array.isArray(keys) ? keys : [])
      .map((key) => /^webhook:sub:(.+):v1$/.exec(String(key))?.[1])
      .filter(Boolean);
    if (ids.length) {
      assertRows(await redis([['SADD', ALL_INDEX_KEY, ...ids]]), 1, 'backfill index');
      found += ids.length;
    }
    cursor = String(nextCursor);
    if (cursor === '0') break;
  }
  assertRows(await redis([['SET', BACKFILL_CURSOR_KEY, cursor === '0' ? 'done' : cursor]]), 1, 'backfill progress');
  return found;
}

async function deliverForRecord(group, deliver, now) {
  let { record } = group;
  const outcomes = [];
  for (const delivery of group.deliveries) {
    if (record.active === false) break;
    const outcome = await deliver(record, delivery.payload);
    const at = now();
    outcomes.push({ chokepointId: delivery.payload.chokepointId, outcome, at });
    record = settleRecord(record, outcome, at);
  }
  return { record, outcomes };
}

function groupBySubscriber(deliveries) {
  const groups = new Map();
  for (const delivery of deliveries) {
    const id = delivery.record.subscriberId;
    if (!groups.has(id)) groups.set(id, { record: delivery.record, deliveries: [] });
    groups.get(id).deliveries.push(delivery);
  }
  return [...groups.values()];
}

async function writeWorkerStatus(redis, summary, now) {
  const fetchedAt = now();
  const meta = {
    fetchedAt,
    recordCount: summary.subscribers,
    sourceState: summary.sourceState,
    deliveries: summary.deliveries,
    failures: summary.failures,
    deactivated: summary.deactivated,
    pruned: summary.pruned,
    scoresFetchedAt: summary.scoresFetchedAt,
  };
  const status = {
    lastRunAt: fetchedAt,
    subscribers: summary.subscribers,
    deliveries: summary.deliveries,
    failures: summary.failures,
    scoresFetchedAt: summary.scoresFetchedAt,
  };
  const commands = [
    ['SET', WORKER_STATUS_KEY, JSON.stringify(status), 'EX', String(STATUS_TTL_SECONDS)],
    ['SET', WORKER_META_KEY, JSON.stringify(meta), 'EX', String(META_TTL_SECONDS)],
  ];
  if (summary.sourceState === 'ok') commands.push(['SET', WORKER_ACTIVATION_KEY, '1', 'NX']);
  // SET NX answers null when the marker already exists; that is not a failure.
  const rows = await redis(commands);
  if (!Array.isArray(rows) || rows.length !== commands.length || rows.some((row) => !row || row.error)) {
    throw new Error('worker status write failed');
  }
}

async function evaluate({ redis, deliver, fetchImpl, env, now }) {
  const status = await readChokepointStatus({ redis, fetchImpl, env });
  const summary = {
    sourceState: 'ok',
    subscribers: 0,
    deliveries: 0,
    failures: 0,
    deactivated: 0,
    pruned: 0,
    backfilled: 0,
    scoresFetchedAt: status?.fetchedAt || null,
    source: status?.source ?? null,
  };
  if (!status) {
    summary.sourceState = 'error';
    await writeWorkerStatus(redis, summary, now);
    return summary;
  }

  summary.backfilled = await backfillIndex(redis);
  const [members] = assertRows(await redis([['SMEMBERS', ALL_INDEX_KEY]]), 1, 'index read');
  const ids = Array.isArray(members.result) ? members.result.filter((id) => typeof id === 'string') : [];
  const raws = await runBatched(redis, ids, (id) => ['GET', webhookKey(id)], 'record read');

  const expired = ids.filter((_, index) => raws[index] === null);
  if (expired.length) {
    await runBatched(redis, expired, (id) => ['SREM', ALL_INDEX_KEY, id], 'index prune');
    await runBatched(redis, expired, (id) => ['DEL', stateKey(id)], 'state prune');
  }
  summary.pruned = expired.length;

  const rawById = new Map();
  const records = [];
  ids.forEach((id, index) => {
    const record = typeof raws[index] === 'string' ? parseRecord(raws[index]) : null;
    if (!record || record.subscriberId !== id || record.active === false) return;
    rawById.set(id, raws[index]);
    records.push(record);
  });
  summary.subscribers = records.length;

  const stateRows = await runBatched(redis, records, (record) => ['HGETALL', stateKey(record.subscriberId)], 'state read');
  const states = new Map(records.map((record, index) => [record.subscriberId, parseStateHash(stateRows[index])]));

  const { deliveries, nextStates } = planTick({
    chokepoints: status.chokepoints,
    records,
    states,
    now: now(),
    scoresFetchedAt: summary.scoresFetchedAt,
  });

  const settled = await allSettledWithConcurrency(
    groupBySubscriber(deliveries),
    DELIVERY_CONCURRENCY,
    (group) => deliverForRecord(group, deliver, now),
  );

  const settledRecords = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value.outcomes.length) continue;
    const { record, outcomes } = result.value;
    const next = nextStates.get(record.subscriberId);
    for (const { chokepointId, outcome, at } of outcomes) {
      summary.deliveries += 1;
      if (outcome.ok) {
        next[chokepointId] = { ...next[chokepointId], armed: false, lastDeliveredAt: new Date(at).toISOString() };
      } else {
        summary.failures += 1;
      }
    }
    settledRecords.push(record);
  }

  const stateWrites = [];
  for (const [subscriberId, next] of nextStates) {
    const fields = Object.entries(next).flatMap(([chokepointId, state]) => [chokepointId, JSON.stringify(state)]);
    if (!fields.length) continue;
    stateWrites.push(['HSET', stateKey(subscriberId), ...fields]);
    stateWrites.push(['EXPIRE', stateKey(subscriberId), String(STATE_TTL_SECONDS)]);
  }
  for (let i = 0; i < stateWrites.length; i += BATCH_SIZE) {
    const batch = stateWrites.slice(i, i + BATCH_SIZE);
    assertRows(await redis(batch), batch.length, 'state write');
  }
  const swapped = await runBatched(redis, settledRecords, (record) => [
    'EVAL', RECORD_CAS_SCRIPT, '1', webhookKey(record.subscriberId),
    rawById.get(record.subscriberId), JSON.stringify(record),
  ], 'record write');
  summary.deactivated = settledRecords
    .filter((record, index) => record.active === false && Number(swapped[index]) === 1).length;

  await writeWorkerStatus(redis, summary, now);
  return summary;
}

/**
 * One delivery pass. Every dependency is injected so tests run without
 * Redis or network.
 */
export async function runTick({
  redis,
  lock,
  deliver = (record, payload) => deliverShippingWebhook(record, payload),
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
}) {
  if (!(await lock.acquire())) return { skipped: true };
  try {
    return await evaluate({ redis, deliver, fetchImpl, env, now });
  } finally {
    await lock.release();
  }
}

export function createUpstashPipeline({ url, token, fetchImpl = globalThis.fetch }) {
  const endpoint = `${url.replace(/\/+$/, '')}/pipeline`;
  return async (commands) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-shipping-webhook-worker/1.0',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Redis pipeline HTTP ${response.status}`);
    return response.json();
  };
}

function createTickLock() {
  let runId = '';
  return {
    async acquire() {
      runId = randomUUID();
      const { locked } = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS);
      return locked;
    },
    release: () => releaseLock(LOCK_DOMAIN, runId),
  };
}

async function main() {
  loadEnvFile(import.meta.url, {
    only: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WORLDMONITOR_RELAY_KEY', 'SHIPPING_WEBHOOK_TICK_MS'],
  });
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  const tickMs = Number(process.env.SHIPPING_WEBHOOK_TICK_MS) > 0
    ? Number(process.env.SHIPPING_WEBHOOK_TICK_MS)
    : DEFAULT_TICK_MS;
  const redis = createUpstashPipeline({ url, token });
  const lock = createTickLock();

  let stopping = false;
  let timer;
  let wake = () => {};
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shipping-webhook-worker] ${signal} received, stopping after the current tick`);
    clearTimeout(timer);
    wake();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  console.log(`[shipping-webhook-worker] started (tick ${Math.round(tickMs / 1000)}s)`);
  while (!stopping) {
    try {
      const result = await runTick({ redis, lock });
      if (result.skipped) {
        console.log('[shipping-webhook-worker] tick skipped: lock held elsewhere');
      } else {
        console.log(
          `[shipping-webhook-worker] tick source=${result.source ?? 'none'} state=${result.sourceState} `
          + `subscribers=${result.subscribers} deliveries=${result.deliveries} failures=${result.failures} `
          + `deactivated=${result.deactivated} pruned=${result.pruned} backfilled=${result.backfilled}`,
        );
      }
    } catch (error) {
      console.error('[shipping-webhook-worker] tick failed:', error?.message ?? String(error));
    }
    if (stopping) break;
    await new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, tickMs);
    });
  }
  console.log('[shipping-webhook-worker] shutdown complete');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('[shipping-webhook-worker] fatal:', error?.message ?? String(error));
    process.exitCode = 1;
  });
}
