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
 * Every tick reads the event feeds and, for each subscriber record, evaluates
 * the event it registered for (shared/event-triggers.json, mirrored at
 * scripts/shared/event-triggers.json):
 *   - `chokepoint.disruption`: compares each subscribed chokepoint's
 *     disruptionScore with the record's alertThreshold (and its live-signal
 *     floor, minLiveSignal) and POSTs one signed event per upward crossing.
 *   - `country.risk_surge`: fires once per country when the Country
 *     Instability Index rose by riseThreshold within 24 h above the floor,
 *     with a 24 h cooldown per country.
 * Delivery state per (subscriber, entity) lives in `webhook:state:<id>:v1`
 * (chokepoint ids and `cii:<CC>` fields share the hash); delivery counters
 * live on the subscriber record. Delivery is at-least-once.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  CHROME_UA,
  acquireLockSafely,
  allSettledWithConcurrency,
  loadEnvFile,
  releaseLock,
} from './_seed-utils.mjs';
import { CII_RISK_SCORE_CACHE_KEYS } from './_cii-risk-cache-keys.mjs';
import { isMainModule } from './lib/main-module.mjs';
import {
  ALL_INDEX_KEY,
  DELIVERY_FAILURE_CEILING,
  deliverShippingWebhook,
  makeDeliveryId,
  webhookKey,
} from './lib/shipping-webhook-delivery.mjs';

// Railway runs this file with rootDirectory=scripts, so the registry is read
// from the scripts/shared mirror (tests/scripts-shared-mirror.test.mjs pins it
// to shared/event-triggers.json).
export const EVENT_REGISTRY = JSON.parse(
  readFileSync(new URL('./shared/event-triggers.json', import.meta.url), 'utf8'),
);
export const CHOKEPOINT_EVENT = 'chokepoint.disruption';
export const RISK_SURGE_EVENT = 'country.risk_surge';
const RISK_SURGE = EVENT_REGISTRY.events[RISK_SURGE_EVENT];
export const RISK_SURGE_RULE = Object.freeze({
  rise: RISK_SURGE.threshold.riseThreshold,
  floor: RISK_SURGE.threshold.floor,
  rearmBelow: RISK_SURGE.cooldown.rearmBelow,
  cooldownMs: RISK_SURGE.cooldown.minimumSeconds * 1000,
});
const CHOKEPOINT_LIVE_COOLDOWN = EVENT_REGISTRY.events[CHOKEPOINT_EVENT].cooldown.withLiveSignal;
export const CHOKEPOINT_LIVE_RULE = Object.freeze({
  rearmScoreMargin: CHOKEPOINT_LIVE_COOLDOWN.rearmScoreMargin,
  rearmLiveBelow: CHOKEPOINT_LIVE_COOLDOWN.rearmLiveBelow,
  cooldownMs: CHOKEPOINT_LIVE_COOLDOWN.minimumSeconds * 1000,
});
export const RISK_SURGE_COUNTRY_NAMES = Object.freeze({ ...RISK_SURGE.countries });

export const CHOKEPOINT_STATUS_KEY = 'supply_chain:chokepoints:v4';
export const CHOKEPOINT_STATUS_RPC_URL = 'https://api.worldmonitor.app/api/supply-chain/v1/get-chokepoint-status';
export const RISK_SCORES_KEY = CII_RISK_SCORE_CACHE_KEYS.live;
export const RISK_SCORES_STALE_KEY = CII_RISK_SCORE_CACHE_KEYS.stale;
export const RISK_SCORES_RPC_URL = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
export const WORKER_STATUS_KEY = 'shipping:webhook-worker:v1';
export const WORKER_META_KEY = 'seed-meta:shipping:webhook-worker';
export const WORKER_ACTIVATION_KEY = 'seed-activated:shipping:webhook-worker';
export const BACKFILL_CURSOR_KEY = `${ALL_INDEX_KEY}:backfill`;
export const LOCK_DOMAIN = 'shipping-webhook-worker';
export const LOCK_KEY = `seed-lock:${LOCK_DOMAIN}`;
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

// Every worker write is fenced by the tick lock (KEYS[1] == ARGV[1]) and
// answers -1 when this process no longer owns it, so a worker that outlived
// its lease cannot overwrite the state or records of the one that replaced it.
const FENCE = "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end ";

// Compare-and-set: a rotate-secret or reactivate that lands mid-tick wins, and
// this tick's counter update is dropped rather than resurrecting the old record.
export const RECORD_CAS_SCRIPT = `${FENCE}if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('SET', KEYS[2], ARGV[3], 'KEEPTTL') return 1 end return 0`;

// The index entry goes only if the record is still gone: a rotate-secret or
// reactivate can restore it between this tick's GET and the prune.
export const PRUNE_SCRIPT = `${FENCE}if redis.call('EXISTS', KEYS[2]) == 0 then redis.call('SREM', KEYS[3], ARGV[2]) redis.call('DEL', KEYS[4]) return 1 end return 0`;

// State is written only while the record exists, so a write racing the prune
// cannot recreate a state hash nothing indexes.
export const STATE_WRITE_SCRIPT = `${FENCE}if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end redis.call('HSET', KEYS[3], unpack(ARGV, 3)) redis.call('EXPIRE', KEYS[3], ARGV[2]) return 1`;

export const STATUS_WRITE_SCRIPT = `${FENCE}redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]) redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5]) if ARGV[6] == '1' then redis.call('SET', KEYS[4], '1', 'NX') end return 1`;

export const LOCK_RENEW_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0";

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
 * The most each score input adds to disruptionScore: warningComponent and
 * aisComponent in server/worldmonitor/supply-chain/v1/_scoring.mjs, and the
 * transit anomaly bonus in get-chokepoint-status.ts. Pinned by a test.
 */
export const SCORE_SOURCE_MAX_POINTS = Object.freeze({ navigationalWarnings: 15, ais: 15, transit: 10 });

/**
 * THREAT_LEVEL in _scoring.mjs keyed by the warRiskTier the feed carries; the
 * standing part of a score that never changes without a config edit. Pinned
 * by a test. Live signal = score minus this standing level.
 */
export const THREAT_POINTS_BY_TIER = Object.freeze({
  WAR_RISK_TIER_WAR_ZONE: 70,
  WAR_RISK_TIER_CRITICAL: 40,
  WAR_RISK_TIER_HIGH: 30,
  WAR_RISK_TIER_ELEVATED: 15,
  WAR_RISK_TIER_NORMAL: 0,
});

export function liveSignal(chokepoint) {
  const standing = THREAT_POINTS_BY_TIER[chokepoint?.warRiskTier] ?? 0;
  return Math.max(0, Number(chokepoint?.disruptionScore) - standing);
}

export function recordEventType(record) {
  return typeof record?.eventType === 'string' && record.eventType ? record.eventType : CHOKEPOINT_EVENT;
}

/** State hash field for a country.risk_surge entity; chokepoints use their id. */
export function countryStateField(countryCode) {
  return `cii:${countryCode}`;
}

/** Which score inputs the feed had for a chokepoint. A missing input scores 0. */
export function scoreSources(chokepoint) {
  return {
    navigationalWarnings: chokepoint.navigationalWarningsAvailable === true,
    ais: chokepoint.aisSnapshotAvailable === true,
    transit: chokepoint.transitSummary?.dataAvailable === true,
  };
}

/**
 * armed --(score >= threshold)--> deliver; a successful delivery disarms and
 * records the score sources it saw. disarmed --(score < threshold)--> armed,
 * unless the sources present at delivery but missing now could add back
 * enough points to reach the threshold: the drop may then be the outage, not
 * the disruption ending. Missing state is armed.
 * A crossing keeps its `pending` delivery id and triggeredAt until it is
 * delivered or re-armed, so a retry is the same event to the receiver.
 *
 * With a live-signal floor (`minLive` > 0, the record's minLiveSignal) the
 * score must also sit `minLive` points above the chokepoint's standing threat
 * level to fire, so a war zone that stands at 70 does not fire once at
 * subscription and go silent. Live signals move in 5-point steps (one
 * navigational warning), so the pair re-arms only once they have clearly
 * subsided (CHOKEPOINT_LIVE_RULE, the in-app chokepoint_disruption rule's
 * hysteresis) and refires at most once per cooldown.
 */
export function nextChokepointState(previous, score, threshold, sources = {}, { live = null, minLive = 0, nowMs = Date.now(), rule = CHOKEPOINT_LIVE_RULE } = {}) {
  const withLive = minLive > 0;
  const armed = previous?.armed ?? true;
  const liveOk = !withLive || (Number.isFinite(live) && live >= minLive);
  const lastDeliveredMs = previous?.lastDeliveredAt ? Date.parse(previous.lastDeliveredAt) : NaN;
  const cooled = !withLive || !Number.isFinite(lastDeliveredMs) || nowMs - lastDeliveredMs >= rule.cooldownMs;
  const fire = armed && score >= threshold && liveOk && cooled;
  const missingPoints = Object.entries(previous?.sources ?? {})
    .filter(([name, present]) => present && !sources[name])
    .reduce((sum, [name]) => sum + (SCORE_SOURCE_MAX_POINTS[name] ?? 0), 0);
  const subsided = withLive
    ? score + missingPoints < threshold - rule.rearmScoreMargin
      || (Number.isFinite(live) && live + missingPoints < Math.min(rule.rearmLiveBelow, minLive))
    : score + missingPoints < threshold;
  const state = { armed: armed || subsided, lastScore: score };
  if (minLive > 0 && Number.isFinite(live)) state.lastLive = live;
  if (previous?.lastDeliveredAt) state.lastDeliveredAt = previous.lastDeliveredAt;
  if (!state.armed && previous?.sources) state.sources = previous.sources;
  if (fire && previous?.pending) state.pending = previous.pending;
  return { fire, state };
}

/**
 * country.risk_surge edge state. `dynamicScore` is the feed's own 24 h
 * movement, so one reading carries the rise. armed --(rise >= RULE.rise and
 * score >= RULE.floor, outside the cooldown)--> deliver; a delivery disarms;
 * disarmed --(rise < RULE.rearmBelow)--> armed. The cooldown is measured from
 * the last successful delivery, so a surge that lasts past it is reported
 * again at most once per cooldown. Missing state is armed.
 */
export function nextCountryState(previous, cii, nowMs, rule = RISK_SURGE_RULE) {
  const rise = Number(cii?.dynamicScore);
  const score = Number(cii?.combinedScore);
  if (!Number.isFinite(rise) || !Number.isFinite(score)) return { fire: false, state: previous ?? { armed: true } };
  // deriveCiiTrendDelta reports 0 with TREND_DIRECTION_UNSPECIFIED when it has
  // no prior snapshot. That is unknown movement, not a settled surge: it must
  // neither fire nor re-arm, or a delivered surge could be reported again once
  // history returns.
  if (rise === 0 && cii?.trend === 'TREND_DIRECTION_UNSPECIFIED') return { fire: false, state: previous ?? { armed: true } };
  const baseline = Number.isFinite(cii?.staticBaseline) ? cii.staticBaseline : null;
  // A changed static baseline is a methodology or baseline edit, not an event
  // (Brazil and Mexico stepped 50 to 70 in one tick in the backtest). It
  // consumes the surge: disarm until the 24 h movement settles.
  const baselineEdited = baseline !== null && Number.isFinite(previous?.lastBaseline) && previous.lastBaseline !== baseline;
  const armed = !baselineEdited && (previous?.armed ?? true);
  const lastDeliveredMs = previous?.lastDeliveredAt ? Date.parse(previous.lastDeliveredAt) : NaN;
  const cooled = !Number.isFinite(lastDeliveredMs) || nowMs - lastDeliveredMs >= rule.cooldownMs;
  const fire = armed && rise >= rule.rise && score >= rule.floor && cooled;
  const state = { armed: armed || rise < rule.rearmBelow, lastScore: score, lastDelta: rise };
  if (baseline !== null) state.lastBaseline = baseline;
  if (previous?.lastDeliveredAt) state.lastDeliveredAt = previous.lastDeliveredAt;
  if (fire && previous?.pending) state.pending = previous.pending;
  return { fire, state };
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

function planChokepointRecord({ record, previous, next, byId, now, triggeredAt, scoresFetchedAt, makeId, deliveries }) {
  const minLive = Number.isFinite(record.minLiveSignal) && record.minLiveSignal > 0 ? record.minLiveSignal : 0;
  for (const chokepointId of new Set(record.chokepointIds)) {
    const chokepoint = byId.get(chokepointId);
    if (!chokepoint) continue;
    const score = chokepoint.disruptionScore;
    const sources = scoreSources(chokepoint);
    const live = liveSignal(chokepoint);
    const { fire, state } = nextChokepointState(previous[chokepointId], score, record.alertThreshold, sources, { live, minLive, nowMs: now });
    next[chokepointId] = state;
    if (!fire) continue;
    state.pending ??= { deliveryId: makeId(), triggeredAt };
    deliveries.push({
      record,
      event: CHOKEPOINT_EVENT,
      stateField: chokepointId,
      chokepoint,
      sources,
      deliveryId: state.pending.deliveryId,
      payload: {
        subscriberId: record.subscriberId,
        chokepointId,
        score,
        alertThreshold: record.alertThreshold,
        triggeredAt: state.pending.triggeredAt,
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
}

function planRiskSurgeRecord({ record, previous, next, ciiByCountry, now, triggeredAt, riskFetchedAt, makeId, deliveries }) {
  const scope = Array.isArray(record.countries) && record.countries.length
    ? new Set(record.countries)
    : new Set(ciiByCountry.keys());
  for (const countryCode of scope) {
    const cii = ciiByCountry.get(countryCode);
    if (!cii) continue;
    const field = countryStateField(countryCode);
    const { fire, state } = nextCountryState(previous[field], cii, now);
    next[field] = state;
    if (!fire) continue;
    state.pending ??= { deliveryId: makeId(), triggeredAt };
    const delta = Number(cii.dynamicScore);
    const score = Number(cii.combinedScore);
    deliveries.push({
      record,
      event: RISK_SURGE_EVENT,
      stateField: field,
      sources: {},
      deliveryId: state.pending.deliveryId,
      payload: {
        subscriberId: record.subscriberId,
        countryCode,
        countryName: RISK_SURGE_COUNTRY_NAMES[countryCode] ?? countryCode,
        score,
        // The index about 24 h earlier, as the registry documents; the previous
        // tick's score is 5 minutes old and would read as a 1-point movement.
        previousScore: score - delta,
        delta24h: delta,
        trend: typeof cii.trend === 'string' ? cii.trend : 'TREND_DIRECTION_UNSPECIFIED',
        advisoryLevel: typeof cii.advisoryLevel === 'string' ? cii.advisoryLevel : null,
        triggeredAt: state.pending.triggeredAt,
        reason: 'risk_surge',
        details: {
          riseThreshold: RISK_SURGE_RULE.rise,
          floor: RISK_SURGE_RULE.floor,
          staticBaseline: Number.isFinite(cii.staticBaseline) ? cii.staticBaseline : null,
          components: cii.components && typeof cii.components === 'object' ? cii.components : {},
          methodologyVersion: typeof cii.methodologyVersion === 'string' ? cii.methodologyVersion : '',
          computedAt: Number.isFinite(cii.computedAt) ? cii.computedAt : null,
          scoresFetchedAt: riskFetchedAt ?? null,
        },
      },
    });
  }
}

/**
 * Pure. `records` are active, parsed subscriber records; `states` maps
 * subscriberId to its stored per-entity state. `chokepoints` or `riskScores`
 * may be null when that feed was unreadable this tick: records on that event
 * are then left untouched (no state write, nothing fired) while records on
 * the other event proceed.
 */
export function planTick({ chokepoints, riskScores = null, records, states, now, scoresFetchedAt, riskFetchedAt = null, makeId = makeDeliveryId }) {
  const byId = new Map((chokepoints ?? [])
    .filter((cp) => typeof cp?.id === 'string' && Number.isFinite(cp.disruptionScore))
    .map((cp) => [cp.id, cp]));
  const ciiByCountry = new Map((riskScores?.ciiScores ?? [])
    .filter((cii) => typeof cii?.region === 'string' && Number.isFinite(cii.combinedScore) && Number.isFinite(cii.dynamicScore))
    .map((cii) => [cii.region, cii]));
  const triggeredAt = new Date(now).toISOString();
  const deliveries = [];
  const nextStates = new Map();
  for (const record of records) {
    const previous = states.get(record.subscriberId) ?? {};
    const next = {};
    const eventType = recordEventType(record);
    if (eventType === CHOKEPOINT_EVENT) {
      if (!chokepoints) continue;
      planChokepointRecord({ record, previous, next, byId, now, triggeredAt, scoresFetchedAt, makeId, deliveries });
    } else if (eventType === RISK_SURGE_EVENT) {
      if (!riskScores) continue;
      planRiskSurgeRecord({ record, previous, next, ciiByCountry, now, triggeredAt, riskFetchedAt, makeId, deliveries });
    } else {
      continue;
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

function isRiskScoresResponse(value) {
  return Boolean(value) && typeof value === 'object'
    && Array.isArray(value.ciiScores) && value.ciiScores.length > 0;
}

function parseFeed(raw, accept) {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return accept(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const parseChokepointResponse = (raw) => parseFeed(raw, isChokepointResponse);
const parseRiskScoresResponse = (raw) => parseFeed(raw, isRiskScoresResponse);

async function fetchRpcFeed({ fetchImpl, env, url, accept }) {
  if (!env.WORLDMONITOR_RELAY_KEY) return null;
  try {
    const response = await fetchImpl(url, {
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
    return parseFeed(await response.text(), accept);
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
  const fetched = await fetchRpcFeed({ fetchImpl, env, url: CHOKEPOINT_STATUS_RPC_URL, accept: isChokepointResponse });
  return fetched ? { ...fetched, source: 'rpc' } : null;
}

/**
 * The CII feed is cached live for 10 minutes and as a 1 h stale copy; the AIS
 * relay warm-pings the RPC every 8 minutes. Read live, then stale, then the
 * RPC. `fetchedAt` is derived from the newest computedAt the feed carries.
 */
export async function readRiskScores({ redis, fetchImpl, env }) {
  const [live, stale] = await redis([['GET', RISK_SCORES_KEY], ['GET', RISK_SCORES_STALE_KEY]]);
  let feed = parseRiskScoresResponse(live?.result);
  let source = 'redis';
  if (!feed) {
    feed = parseRiskScoresResponse(stale?.result);
    source = 'redis-stale';
  }
  if (!feed) {
    feed = await fetchRpcFeed({ fetchImpl, env, url: RISK_SCORES_RPC_URL, accept: isRiskScoresResponse });
    source = 'rpc';
  }
  if (!feed) return null;
  const computedAt = Math.max(0, ...feed.ciiScores.map((cii) => Number(cii?.computedAt) || 0));
  return { ...feed, source, fetchedAt: computedAt > 0 ? new Date(computedAt).toISOString() : null };
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

/**
 * Sends one subscriber's crossings in order. It stops at the first failure, so
 * failureCount grows by at most 1 per tick and the ceiling means consecutive
 * failed ticks; the rest stay pending for the next tick. It also stops when the
 * record changed since the tick read it (rotated, reactivated, expired), so no
 * send uses a stale secret or a deleted subscription.
 */
async function deliverForRecord(group, deliver, now, beforeSend) {
  let { record } = group;
  const outcomes = [];
  for (const delivery of group.deliveries) {
    if (record.active === false || !(await beforeSend(group))) break;
    const outcome = await deliver(record, delivery.payload, delivery.deliveryId, delivery.event);
    const at = now();
    outcomes.push({ stateField: delivery.stateField, sources: delivery.sources, outcome, at });
    record = settleRecord(record, outcome, at);
    if (!outcome.ok) break;
  }
  return { record, outcomes };
}

function groupBySubscriber(deliveries, rawById) {
  const groups = new Map();
  for (const delivery of deliveries) {
    const id = delivery.record.subscriberId;
    if (!groups.has(id)) groups.set(id, { record: delivery.record, raw: rawById.get(id), deliveries: [] });
    groups.get(id).deliveries.push(delivery);
  }
  return [...groups.values()];
}

class LockLostError extends Error {
  constructor() {
    super('lock lost during the tick');
  }
}

/** Throws when a fenced write reports that another worker owns the tick. */
function assertFenced(results) {
  if (results.some((result) => Number(result) === -1)) throw new LockLostError();
  return results;
}

function stateWrite(fence, subscriberId, fields) {
  return [
    'EVAL', STATE_WRITE_SCRIPT, '3', fence.key, webhookKey(subscriberId), stateKey(subscriberId),
    fence.token, String(STATE_TTL_SECONDS), ...fields,
  ];
}

async function writeWorkerStatus(redis, fence, summary, now) {
  const fetchedAt = now();
  const meta = {
    fetchedAt,
    recordCount: summary.subscribers,
    sourceState: summary.sourceState,
    riskSourceState: summary.riskSourceState,
    deliveries: summary.deliveries,
    failures: summary.failures,
    deactivated: summary.deactivated,
    pruned: summary.pruned,
    scoresFetchedAt: summary.scoresFetchedAt,
    riskFetchedAt: summary.riskFetchedAt,
  };
  const status = {
    lastRunAt: fetchedAt,
    subscribers: summary.subscribers,
    deliveries: summary.deliveries,
    failures: summary.failures,
    scoresFetchedAt: summary.scoresFetchedAt,
    riskFetchedAt: summary.riskFetchedAt,
  };
  const [written] = assertRows(await redis([[
    'EVAL', STATUS_WRITE_SCRIPT, '4', fence.key, WORKER_STATUS_KEY, WORKER_META_KEY, WORKER_ACTIVATION_KEY,
    fence.token, JSON.stringify(status), String(STATUS_TTL_SECONDS), JSON.stringify(meta), String(META_TTL_SECONDS),
    summary.sourceState === 'ok' ? '1' : '0',
  ]]), 1, 'worker status write');
  assertFenced([written.result]);
}

async function evaluate({ redis, lock, deliver, fetchImpl, env, now }) {
  const fence = lock.fence();
  let lockLost = false;
  // One round trip renews the lease and re-reads the record. A transport error
  // is retried once; only a confirmed loss or a changed record stops sending.
  const beforeSend = async (group) => {
    if (lockLost) return false;
    const commands = [
      ['EVAL', LOCK_RENEW_SCRIPT, '1', fence.key, fence.token, String(LOCK_TTL_MS)],
      ['GET', webhookKey(group.record.subscriberId)],
    ];
    let rows;
    for (let attempt = 0; attempt < 2 && !rows; attempt += 1) {
      rows = await redis(commands).catch(() => null);
      if (!Array.isArray(rows) || rows.length !== 2 || rows.some((row) => !row || row.error)) rows = null;
    }
    if (!rows || Number(rows[0].result) !== 1) {
      lockLost = true;
      return false;
    }
    return rows[1].result === group.raw;
  };
  const status = await readChokepointStatus({ redis, fetchImpl, env });
  const riskScores = await readRiskScores({ redis, fetchImpl, env });
  const summary = {
    sourceState: 'ok',
    riskSourceState: riskScores ? 'ok' : 'error',
    subscribers: 0,
    deliveries: 0,
    failures: 0,
    deactivated: 0,
    pruned: 0,
    backfilled: 0,
    scoresFetchedAt: status?.fetchedAt || null,
    riskFetchedAt: riskScores?.fetchedAt || null,
    source: status?.source ?? null,
    riskSource: riskScores?.source ?? null,
  };
  // Each event is evaluated against its own feed: a chokepoint outage must not
  // hold back a country.risk_surge that could settle before the feed returns.
  // Only when neither feed is readable is there nothing to do this tick.
  if (!status) summary.sourceState = 'error';
  if (!status && !riskScores) {
    await writeWorkerStatus(redis, fence, summary, now);
    return summary;
  }

  summary.backfilled = await backfillIndex(redis);
  const [members] = assertRows(await redis([['SMEMBERS', ALL_INDEX_KEY]]), 1, 'index read');
  const ids = Array.isArray(members.result) ? members.result.filter((id) => typeof id === 'string') : [];
  const raws = await runBatched(redis, ids, (id) => ['GET', webhookKey(id)], 'record read');

  const expired = ids.filter((_, index) => raws[index] === null);
  const pruned = assertFenced(await runBatched(redis, expired, (id) => [
    'EVAL', PRUNE_SCRIPT, '4', fence.key, webhookKey(id), ALL_INDEX_KEY, stateKey(id), fence.token, id,
  ], 'index prune'));
  summary.pruned = pruned.filter((result) => Number(result) === 1).length;

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
    chokepoints: status?.chokepoints ?? null,
    riskScores,
    records,
    states,
    now: now(),
    scoresFetchedAt: summary.scoresFetchedAt,
    riskFetchedAt: summary.riskFetchedAt,
  });

  // Persist each crossing's delivery id before sending, so a tick that dies
  // after a send still retries under the same id.
  const groups = groupBySubscriber(deliveries, rawById);
  const pendingStored = assertFenced(await runBatched(redis, groups, (group) => stateWrite(
    fence,
    group.record.subscriberId,
    group.deliveries.flatMap(({ stateField }) => [
      stateField,
      JSON.stringify(nextStates.get(group.record.subscriberId)[stateField]),
    ]),
  ), 'pending write'));

  const settled = await allSettledWithConcurrency(
    groups.filter((_, index) => Number(pendingStored[index]) === 1),
    DELIVERY_CONCURRENCY,
    (group) => deliverForRecord(group, deliver, now, beforeSend),
  );
  // Another worker owns the tick now; its state and record writes win.
  if (lockLost) throw new LockLostError();

  const settledRecords = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value.outcomes.length) continue;
    const { record, outcomes } = result.value;
    const next = nextStates.get(record.subscriberId);
    for (const { stateField, sources, outcome, at } of outcomes) {
      summary.deliveries += 1;
      if (outcome.ok) {
        const { pending: _pending, ...delivered } = next[stateField];
        next[stateField] = { ...delivered, armed: false, lastDeliveredAt: new Date(at).toISOString(), sources };
      } else {
        summary.failures += 1;
      }
    }
    settledRecords.push(record);
  }

  const stateWrites = [];
  for (const [subscriberId, next] of nextStates) {
    const fields = Object.entries(next).flatMap(([chokepointId, state]) => [chokepointId, JSON.stringify(state)]);
    if (fields.length) stateWrites.push(stateWrite(fence, subscriberId, fields));
  }
  assertFenced(await runBatched(redis, stateWrites, (command) => command, 'state write'));
  const swapped = assertFenced(await runBatched(redis, settledRecords, (record) => [
    'EVAL', RECORD_CAS_SCRIPT, '2', fence.key, webhookKey(record.subscriberId),
    fence.token, rawById.get(record.subscriberId), JSON.stringify(record),
  ], 'record write'));
  summary.deactivated = settledRecords
    .filter((record, index) => record.active === false && Number(swapped[index]) === 1).length;

  await writeWorkerStatus(redis, fence, summary, now);
  return summary;
}

/**
 * One delivery pass. Every dependency is injected so tests run without
 * Redis or network.
 */
export async function runTick({
  redis,
  lock,
  deliver = (record, payload, deliveryId, event) => deliverShippingWebhook(record, payload, { deliveryId, event }),
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
}) {
  if (!(await lock.acquire())) return { skipped: true };
  try {
    return await evaluate({ redis, lock, deliver, fetchImpl, env, now });
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
    fence: () => ({ key: LOCK_KEY, token: runId }),
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
