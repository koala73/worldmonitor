#!/usr/bin/env node
/**
 * Shipping v2 event webhook delivery — always-on Railway service.
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
 *   - `chokepoint.disruption` (threshold): compares each subscribed
 *     chokepoint's disruptionScore with the record's alertThreshold (and its
 *     live-signal floor, minLiveSignal) and POSTs one signed event per upward
 *     crossing.
 *   - `country.risk_surge` (threshold): fires once per country when the
 *     Country Instability Index rose by riseThreshold within 24 h above the
 *     floor, with a 24 h cooldown per country.
 *   - `news.breaking`, `market.move` (occurrence): drains the API fan-out list
 *     `wm:events:api:v1` that scripts/ais-relay.cjs tees its rss_alert and
 *     market_alert queue messages onto (oldest 200 per tick), matches each
 *     message against every subscriber's stored `scope`, and delivers one
 *     POST per (subscriber, eventId). A failed delivery stays pending under
 *     the same delivery id until retry.pendingTtlSeconds; per-subscription
 *     caps (volume.maxDeliveriesPerHour/Day) count the events POSTed in each
 *     UTC hour and day, retries included, and drop and count new overflow.
 *     Each subscriber's `occ:<eventId>` field (pending, then a delivered or
 *     expired tombstone for a day) is what stops a replayed, multi-variant or
 *     republished copy from firing twice; `webhook:seen:<event>:v1` (sorted
 *     set scored by first-seen ms) only counts those copies for the summary.
 *   - `natural.hazard` (occurrence): reads seismology:earthquakes:v1 and
 *     natural:events:v1 and diffs their ids against `webhook:seen:natural.hazard:v1`
 *     (scored by when each id was last in a feed). An unseen, open hazard
 *     inside the registry's new window is delivered through the same pending,
 *     cap and tombstone pipeline; the first-ever read of a feed is marked
 *     seen without delivering (bootstrap, remembered in
 *     `webhook:seen:natural.hazard:init:v1`), and another agency's copy of a seen quake
 *     or storm is not a new hazard. Countries come from lib/point-to-iso2.mjs.
 * Delivery state per (subscriber, entity) lives in `webhook:state:<id>:v1`
 * (chokepoint ids, `cii:<CC>`, `occ:<eventId>` and `occ-cap` fields share the
 * hash); delivery counters live on the subscriber record. Delivery is
 * at-least-once.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  CHROME_UA,
  acquireLockSafely,
  allSettledWithConcurrency,
  loadEnvFile,
  releaseLock,
} from './_seed-utils.mjs';
import { CII_RISK_SCORE_CACHE_KEYS } from './_cii-risk-cache-keys.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { hazardCountryCodes } from './lib/point-to-iso2.mjs';
import {
  ALL_INDEX_KEY,
  DELIVERY_FAILURE_CEILING,
  deliverShippingWebhook,
  makeDeliveryId,
  webhookKey,
} from './lib/shipping-webhook-delivery.mjs';

const require = createRequire(import.meta.url);
// CJS so the relay publisher shares the exact id functions (and the list key).
const {
  API_FANOUT_LIST_KEY,
  RELAY_EVENT_TO_OCCURRENCE,
  occurrenceEventIdFor,
} = require('./lib/occurrence-events.cjs');

// Railway runs this file with rootDirectory=scripts, so the registry is read
// from the scripts/shared mirror (tests/scripts-shared-mirror.test.mjs pins it
// to shared/event-triggers.json).
export const EVENT_REGISTRY = JSON.parse(
  readFileSync(new URL('./shared/event-triggers.json', import.meta.url), 'utf8'),
);
export const CHOKEPOINT_EVENT = 'chokepoint.disruption';
export const RISK_SURGE_EVENT = 'country.risk_surge';
export const NEWS_EVENT = 'news.breaking';
export const MARKET_EVENT = 'market.move';
/** Per occurrence event: the caps, retry TTL and seen window the registry declares. */
export const OCCURRENCE_RULES = Object.freeze(Object.fromEntries(
  Object.entries(EVENT_REGISTRY.events)
    .filter(([, event]) => event.kind === 'occurrence')
    .map(([key, event]) => [key, Object.freeze({
      maxPerHour: event.volume.maxDeliveriesPerHour,
      maxPerDay: event.volume.maxDeliveriesPerDay,
      pendingTtlMs: event.retry.pendingTtlSeconds * 1000,
      seenWindowMs: event.dedupe.seenWindowSeconds * 1000,
    })]),
));
export const FANOUT_LIST_KEY = API_FANOUT_LIST_KEY;
/** Oldest messages drained per tick; the relay caps the list at 2,000. */
export const FANOUT_DRAIN_MAX = 200;
export const OCCURRENCE_STATE_PREFIX = 'occ:';
export const OCCURRENCE_CAP_FIELD = 'occ-cap';
/** A delivered occurrence stays in the state hash this long so a replay is a no-op. */
export const DELIVERED_TOMBSTONE_MS = 24 * 3_600_000;
export const HAZARD_EVENT = 'natural.hazard';
const HAZARD = EVENT_REGISTRY.events[HAZARD_EVENT];
export const EARTHQUAKES_KEY = HAZARD.source.redisKeys[0];
export const NATURAL_EVENTS_KEY = HAZARD.source.redisKeys[1];
/** When an unseen hazard id still counts as new, and how long a seen id outlives its last appearance. */
export const HAZARD_RULE = Object.freeze({
  quakeNewWithinMs: HAZARD.dedupe.newWithinSeconds.earthquakes * 1000,
  otherNewWithinMs: HAZARD.dedupe.newWithinSeconds.other * 1000,
  seenWindowMs: HAZARD.dedupe.seenWindowSeconds * 1000,
});
/**
 * Hash of the hazard feeds the worker has read at least once (field `eq` or
 * `nat`, value the first-read ms). No TTL and never pruned: a feed bootstraps
 * once, ever, so a quiet feed whose seen ids were all pruned (NHC off-season)
 * or a lost seen set does not swallow the next real event.
 */
export const HAZARD_INIT_KEY = `webhook:seen:${HAZARD_EVENT}:init:v1`;
/** Cross-agency earthquake match (registry dedupe.crossSource). */
export const QUAKE_MATCH = Object.freeze({ seconds: 120, km: 150, magnitude: 0.6 });
const OCCURRENCE_REASONS = Object.freeze({ [NEWS_EVENT]: 'breaking_news', [MARKET_EVENT]: 'large_move', [HAZARD_EVENT]: 'new_hazard' });
const MARKET_ASSET_CLASSES = new Set(['equity', 'commodity', 'crypto']);
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

// Occurrence bookkeeping, all fenced like the writes above.
// Removes expired pendings and old delivered tombstones from a state hash.
export const STATE_HDEL_SCRIPT = `${FENCE}return redis.call('HDEL', KEYS[2], unpack(ARGV, 2))`;
// Drops the ARGV[2] oldest fan-out messages (the tail; LPUSH adds at the head,
// so the tail positions this tick read stay stable under concurrent pushes).
export const FANOUT_TRIM_SCRIPT = `${FENCE}redis.call('LTRIM', KEYS[2], 0, -(tonumber(ARGV[2]) + 1)) return 1`;
// Marks event ids seen (ZADD NX, score = first-seen ms), prunes ids older than
// the cutoff ARGV[2], keeps the set alive for ARGV[3] seconds. ARGV[4..] are
// score, member pairs.
export const SEEN_ADD_SCRIPT = `${FENCE}redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2]) local added = 0 for i = 4, #ARGV - 1, 2 do added = added + redis.call('ZADD', KEYS[2], 'NX', ARGV[i], ARGV[i + 1]) end redis.call('EXPIRE', KEYS[2], ARGV[3]) return added`;
// The natural.hazard seen set: same arguments, but ZADD without NX, so the
// score is when the id was last in a feed and an id still in a feed is never
// pruned.
// Marks hazard feeds initialized (HSETNX feed firstReadMs pairs from ARGV[2]); no TTL.
export const HAZARD_INIT_SCRIPT = `${FENCE}for i = 2, #ARGV - 1, 2 do redis.call('HSETNX', KEYS[2], ARGV[i], ARGV[i + 1]) end return 1`;
export const HAZARD_SEEN_SCRIPT = `${FENCE}redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2]) local added = 0 for i = 4, #ARGV - 1, 2 do added = added + redis.call('ZADD', KEYS[2], ARGV[i], ARGV[i + 1]) end redis.call('EXPIRE', KEYS[2], ARGV[3]) return added`;

export function stateKey(subscriberId) {
  return `webhook:state:${subscriberId}:v1`;
}

export function seenKey(event) {
  return `webhook:seen:${event}:v1`;
}

/** State hash field for one occurrence event id. */
export function occurrenceStateField(eventId) {
  return `${OCCURRENCE_STATE_PREFIX}${eventId}`;
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
    const field = flat[i];
    try {
      const value = JSON.parse(flat[i + 1]);
      if (!value || typeof value !== 'object') continue;
      if (typeof value.armed === 'boolean') state[field] = value;
      else if (value.kind === 'occurrence' && typeof field === 'string' && field.startsWith(OCCURRENCE_STATE_PREFIX)) state[field] = value;
      else if (field === OCCURRENCE_CAP_FIELD) state[field] = value;
    } catch { /* an unreadable field is treated as missing, which is armed */ }
  }
  return state;
}

function finiteNumber(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

/**
 * Pure. One teed queue message ({eventType, payload, severity, variant?,
 * publishedAt}) becomes an occurrence event with the delivery payload minus
 * the per-subscription fields (subscriberId, matchedKeywords, triggeredAt,
 * reason). Null for anything that is not a well-formed rss_alert or
 * market_alert message. A pre-upgrade rss_alert without payload.eventId gets
 * the same link-based id the relay now stamps; a market_alert without the
 * quote fields is rejected (the relay added them in the same change as the tee).
 */
export function normalizeTeeMessage(raw, now = Date.now()) {
  let msg = raw;
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== 'object') return null;
  const event = RELAY_EVENT_TO_OCCURRENCE[msg.eventType];
  const payload = msg.payload;
  if (!event || !payload || typeof payload !== 'object') return null;
  const severity = msg.severity === 'critical' || msg.severity === 'high' ? msg.severity : null;
  if (!severity) return null;
  const publishedAt = finiteNumber(msg.publishedAt) ?? now;

  if (event === NEWS_EVENT) {
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title) return null;
    const eventId = typeof payload.eventId === 'string' && payload.eventId
      ? payload.eventId
      : occurrenceEventIdFor('rss_alert', payload, publishedAt);
    const occurredMs = finiteNumber(payload.publishedAt) > 0 ? finiteNumber(payload.publishedAt) : publishedAt;
    const corroboration = finiteNumber(payload.corroborationCount);
    return {
      event,
      eventId,
      publishedAt,
      payload: {
        eventId,
        title,
        source: typeof payload.source === 'string' ? payload.source : '',
        link: typeof payload.link === 'string' && payload.link.trim() ? payload.link.trim() : null,
        publishedAt: isoFromMs(occurredMs),
        severity,
        importanceScore: finiteNumber(payload.importanceScore) ?? 0,
        corroborationCount: corroboration !== null && corroboration >= 1 ? Math.round(corroboration) : 1,
        category: typeof payload.category === 'string' && payload.category ? payload.category : null,
        countryCodes: Array.isArray(payload.countryCodes)
          ? [...new Set(payload.countryCodes.filter((code) => typeof code === 'string').map((code) => code.toUpperCase()))]
          : [],
        variant: typeof msg.variant === 'string' && msg.variant ? msg.variant : null,
      },
    };
  }

  const changePct = finiteNumber(payload.changePct);
  if (!MARKET_ASSET_CLASSES.has(payload.assetClass) || typeof payload.symbol !== 'string' || !payload.symbol.trim() || changePct === null) {
    return null;
  }
  const eventId = typeof payload.eventId === 'string' && payload.eventId
    ? payload.eventId
    : occurrenceEventIdFor('market_alert', payload, publishedAt);
  if (!eventId) return null;
  const symbol = payload.symbol.trim().toUpperCase();
  return {
    event,
    eventId,
    publishedAt,
    payload: {
      eventId,
      assetClass: payload.assetClass,
      symbol,
      name: typeof payload.name === 'string' && payload.name ? payload.name : symbol,
      price: finiteNumber(payload.price),
      changePct,
      direction: payload.direction === 'down' || payload.direction === 'up' ? payload.direction : (changePct < 0 ? 'down' : 'up'),
      severity,
      source: typeof payload.source === 'string' ? payload.source : '',
      publishedAt: isoFromMs(publishedAt),
    },
  };
}

// natural.hazard: rows of the two seeded feeds become occurrences.

const GDACS_ALERT_EMOJI = /^\s*(\u{1F534}|\u{1F7E0})\s*/u;
const NHC_ADVISORY_ID = /^(nhc-[A-Z]{2}\d{2})-[^-]+$/;
const STORM_CLASSIFICATION = /^(?:super typhoon|typhoon|hurricane|major hurricane|tropical storm|tropical depression|tropical cyclone|severe tropical storm|severe cyclonic storm|very severe cyclonic storm|cyclonic storm|cyclone|subtropical storm|subtropical depression|post-tropical cyclone|potential tropical cyclone|remnants of|storm|depression)\s+/i;

/**
 * NHC row ids embed the advisory number (nhc-AL09-12, seed-natural-events.mjs),
 * so a new advisory would read as a new storm. Basin and storm number are the
 * storm's identity for the season.
 */
export function stableHazardId(id) {
  const match = NHC_ADVISORY_ID.exec(id);
  return match ? match[1] : id;
}

/** The storm name with its classification and GDACS season suffix stripped, lower-cased: "Super Typhoon Champi" and "CHAMPI-26" are both "champi". */
export function stormKey(name) {
  const bare = String(name ?? '').trim().replace(STORM_CLASSIFICATION, '').replace(/-\d{2}$/, '');
  return bare.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function naturalSource(row) {
  const id = String(row.id);
  if (id.startsWith('EONET_')) return 'eonet';
  if (id.startsWith('nhc-')) return 'nhc';
  if (id.startsWith('gdacs-')) return 'gdacs';
  const named = typeof row.sourceName === 'string' ? row.sourceName.trim().toLowerCase() : '';
  return named || (id.startsWith('cyclone:') ? 'gdacs' : 'eonet');
}

function hazardTimeMs(value) {
  const ms = finiteNumber(value);
  return ms !== null && ms > 0 ? ms : null;
}

/**
 * Pure. One earthquake row of seismology:earthquakes:v1 as a candidate:
 * its event id, seen-set fingerprint, event time and delivery payload (minus
 * the per-subscription fields). Null for a row the worker cannot place.
 */
export function earthquakeCandidate(row) {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  const lat = finiteNumber(row.location?.latitude);
  const lon = finiteNumber(row.location?.longitude);
  const magnitude = finiteNumber(row.magnitude);
  if (lat === null || lon === null || magnitude === null) return null;
  const occurredMs = hazardTimeMs(row.occurredAt);
  const place = typeof row.place === 'string' ? row.place.trim() : '';
  const eventId = `eq:${row.id}`;
  const quake = occurredMs === null ? null : { t: occurredMs, lat, lon, mag: magnitude };
  return {
    eventId,
    family: eventId,
    alsoRecord: [],
    windowExempt: false,
    feed: 'eq',
    priority: row.source === 'nrcan' ? 1 : 0,
    timeMs: occurredMs,
    closed: false,
    quake,
    storm: null,
    payload: {
      eventId,
      hazardType: 'earthquakes',
      title: place ? `M${magnitude.toFixed(1)} - ${place}` : `M${magnitude.toFixed(1)} earthquake`,
      source: row.source === 'nrcan' ? 'nrcan' : 'usgs',
      sourceUrl: typeof row.sourceUrl === 'string' && row.sourceUrl ? row.sourceUrl : null,
      lat,
      lon,
      countryCodes: hazardCountryCodes({ lat, lon, text: place }),
      occurredAt: occurredMs === null ? null : isoFromMs(occurredMs),
      magnitude,
      depthKm: finiteNumber(row.depthKm),
      nearTestSite: row.nearTestSite === true,
      alertLevel: null,
      stormName: null,
      stormCategory: null,
      windKt: null,
    },
  };
}

const NATURAL_PRIORITY = Object.freeze({ nhc: 0, gdacs: 1, eonet: 2 });

// EONET titles planned burns from the US incident feeds "Prescribed Fire …
// RX"; in a 30-day sample they were 18 of 32 wildfires. A planned burn is not
// a wildfire alert.
const PRESCRIBED_BURN = /^prescribed (?:fire|burn)\b|\brx\b/i;

export function isPrescribedBurn(row) {
  return row?.category === 'wildfires' && typeof row.title === 'string' && PRESCRIBED_BURN.test(row.title);
}

/**
 * Pure. One row of natural:events:v1 as a candidate. Earthquake rows (GDACS
 * EQ) are skipped: the earthquake feed carries the same quakes with a
 * magnitude. GDACS rows carry alertLevel (older rows only the title emoji,
 * which is read as a fallback and stripped from the title).
 */
export function naturalEventCandidate(row) {
  if (!row || typeof row.id !== 'string' || !row.id || row.category === 'earthquakes') return null;
  // A Hong Kong Observatory signal's id names the signal (hko-warning:TC8NE),
  // not the storm, so a later storm's same signal would read as seen; the
  // storm itself arrives through the cyclone feeds.
  if (row.id.startsWith('hko-warning:')) return null;
  if (isPrescribedBurn(row)) return null;
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  if (lat === null || lon === null || typeof row.category !== 'string' || !row.category) return null;
  const source = naturalSource(row);
  const rawTitle = typeof row.title === 'string' ? row.title : '';
  const emoji = GDACS_ALERT_EMOJI.exec(rawTitle)?.[1];
  const title = rawTitle.replace(GDACS_ALERT_EMOJI, '').trim();
  let alertLevel = null;
  if (row.id.startsWith('gdacs-')) {
    alertLevel = row.alertLevel === 'Red' || row.alertLevel === 'Orange'
      ? row.alertLevel
      : emoji === '\u{1F534}' ? 'Red' : emoji === '\u{1F7E0}' ? 'Orange' : null;
  }
  const storm = row.category === 'severeStorms';
  const stormName = typeof row.stormName === 'string' && row.stormName.trim()
    ? row.stormName.trim()
    : storm && STORM_CLASSIFICATION.test(title) ? title.replace(STORM_CLASSIFICATION, '').trim() || null : null;
  const unit = typeof row.magnitudeUnit === 'string' ? row.magnitudeUnit.trim().toLowerCase() : '';
  const windKt = finiteNumber(row.windKt) > 0
    ? finiteNumber(row.windKt)
    : storm && (unit === 'kt' || unit === 'kts') && finiteNumber(row.magnitude) > 0 ? finiteNumber(row.magnitude) : null;
  const timeMs = hazardTimeMs(row.date);
  const family = `nat:${stableHazardId(row.id)}`;
  // GDACS: an escalation to Red is a second event (`:red`), so a Red scope
  // hears of it; a Red event that falls back to Orange is not new. A GDACS
  // row's date is when GDACS opened the event, often while it was Green and
  // not stored, so GDACS rows are new when first seen at Orange or Red,
  // however old that date is (the bootstrap keeps a first read silent).
  const gdacs = row.id.startsWith('gdacs-');
  const red = gdacs && alertLevel === 'Red';
  const eventId = red ? `${family}:red` : family;
  return {
    eventId,
    family,
    alsoRecord: red ? [family] : [],
    windowExempt: gdacs,
    feed: 'nat',
    priority: NATURAL_PRIORITY[source] ?? (row.id.startsWith('cyclone:') ? 1 : 2),
    timeMs,
    closed: row.closed === true,
    quake: null,
    storm: storm && stormName ? stormKey(stormName) || null : null,
    payload: {
      eventId,
      hazardType: row.category,
      title: title || row.categoryTitle || row.category,
      source,
      sourceUrl: typeof row.sourceUrl === 'string' && row.sourceUrl ? row.sourceUrl : null,
      lat,
      lon,
      countryCodes: hazardCountryCodes({ lat, lon, text: title }),
      occurredAt: timeMs === null ? null : isoFromMs(timeMs),
      magnitude: null,
      depthKm: null,
      nearTestSite: null,
      alertLevel,
      stormName: storm ? stormName : null,
      stormCategory: Number.isInteger(row.stormCategory) ? row.stormCategory : null,
      windKt,
    },
  };
}

/** Seen-set member: the event id, plus the fingerprint cross-source matching needs. */
function hazardMember(candidate, eventId = candidate.eventId) {
  if (candidate.quake) {
    const { t, lat, lon, mag } = candidate.quake;
    return `${eventId}|q:${t},${lat.toFixed(2)},${lon.toFixed(2)},${mag}`;
  }
  return candidate.storm ? `${eventId}|s:${candidate.storm}` : eventId;
}

/**
 * Pure. ZRANGE output of the hazard seen set -> Map(eventId -> {members,
 * quake, storms}). A storm renamed after it was first seen (Tropical
 * Depression Nineteen, then Melissa) keeps one member per name, so another
 * agency's copy under either name is recognized.
 */
export function parseHazardSeen(members) {
  const seen = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    if (typeof member !== 'string' || !member) continue;
    const bar = member.indexOf('|');
    const eventId = bar === -1 ? member : member.slice(0, bar);
    const tag = bar === -1 ? '' : member.slice(bar + 1);
    if (!seen.has(eventId)) seen.set(eventId, { eventId, members: [], quake: null, storms: new Set() });
    const entry = seen.get(eventId);
    entry.members.push(member);
    if (tag.startsWith('q:')) {
      const [t, lat, lon, mag] = tag.slice(2).split(',').map(Number);
      if ([t, lat, lon, mag].every(Number.isFinite) && !entry.quake) entry.quake = { t, lat, lon, mag };
    } else if (tag.startsWith('s:') && tag.length > 2) {
      entry.storms.add(tag.slice(2));
    }
  }
  return seen;
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function quakeAgency(eventId) {
  return eventId.startsWith('eq:nrcan:') ? 'nrcan' : 'usgs';
}

function sameQuake(a, b) {
  return Math.abs(a.t - b.t) <= QUAKE_MATCH.seconds * 1000
    && Math.abs(a.mag - b.mag) <= QUAKE_MATCH.magnitude + 1e-9
    && distanceKm(a, b) <= QUAKE_MATCH.km;
}

export function emptyHazardCounters() {
  return { feedIds: 0, new: 0, bootstrapped: 0, stale: 0, closed: 0, crossSource: 0 };
}

/**
 * Pure. Diffs the two feeds against the seen set. `feeds.earthquakes` or
 * `feeds.naturalEvents` is null when that key was unreadable: its ids are
 * neither diffed nor refreshed. For each readable feed:
 *   - an id already seen is refreshed (its score becomes `now`);
 *   - a feed read for the first time ever (absent from `feeds.initialized`,
 *     the HAZARD_INIT_KEY fields, and with no seen id) bootstraps: every id
 *     is marked seen and nothing is delivered, so a first deploy never
 *     floods; once initialized a feed never bootstraps again, even with
 *     every seen id pruned or the seen set lost;
 *   - otherwise an unseen id is delivered when its event time is within the
 *     registry's new window and it is not closed, unless it is another
 *     agency's copy of a seen quake or storm (registry dedupe.crossSource).
 * Within a tick the higher-priority row of one hazard goes first (USGS over
 * Earthquakes Canada; NHC, then GDACS and western-Pacific cyclones, then
 * EONET), so the richer record is the one delivered.
 * Returns the occurrences, the [score, member] seen writes, the feeds to
 * mark initialized and counters.
 */
export function diffHazards(feeds, seen, now, rule = HAZARD_RULE) {
  const counters = emptyHazardCounters();
  const occurrences = [];
  const writes = [];
  const initWrites = [];
  const initialized = new Set(feeds.initialized ?? []);
  const known = new Map([...seen].map(([eventId, entry]) => [eventId, { ...entry, members: [...entry.members], storms: new Set(entry.storms) }]));
  const feedRows = [
    ['eq', feeds.earthquakes, earthquakeCandidate, rule.quakeNewWithinMs],
    ['nat', feeds.naturalEvents, naturalEventCandidate, rule.otherNewWithinMs],
  ];
  for (const [feed, rows, toCandidate, newWithinMs] of feedRows) {
    if (!Array.isArray(rows)) continue;
    const prefix = `${feed}:`;
    // The persistent marker decides; seen ids also count, for a seen set
    // written before the marker existed.
    const bootstrap = !initialized.has(feed) && ![...seen.keys()].some((eventId) => eventId.startsWith(prefix));
    if (!initialized.has(feed)) initWrites.push(feed);
    const candidates = rows.map(toCandidate).filter(Boolean)
      .sort((a, b) => a.priority - b.priority || (a.timeMs ?? 0) - (b.timeMs ?? 0));
    const feedIds = new Set(candidates.map((candidate) => candidate.eventId));
    const tickIds = new Set();
    for (const candidate of candidates) {
      if (tickIds.has(candidate.eventId)) continue;
      tickIds.add(candidate.eventId);
      counters.feedIds += 1;
      // A Red GDACS row also keeps its Orange id seen, so falling back to
      // Orange is not new (alsoRecord); the Orange id alone does not make the
      // Red id seen, so an escalation is.
      if (known.has(candidate.eventId)) {
        const seenAs = [candidate.eventId, ...candidate.alsoRecord].filter((eventId) => known.has(eventId));
        for (const eventId of seenAs) for (const member of known.get(eventId).members) writes.push([now, member]);
        for (const eventId of candidate.alsoRecord.filter((id) => !known.has(id))) writes.push([now, hazardMember(candidate, eventId)]);
        const existing = known.get(seenAs[0]);
        if (candidate.storm && !existing.storms.has(candidate.storm)) {
          writes.push([now, hazardMember(candidate, existing.eventId)]);
          existing.storms.add(candidate.storm);
        }
        continue;
      }
      // Another agency's copy of a seen hazard; never the same event's own
      // lower alert level (a GDACS escalation shares its storm name).
      // A matching quake is a copy only when it came from the other agency or
      // its id has left the feed (replaced): two quakes the feed still lists
      // side by side are a doublet, not one event.
      const duplicate = [...known.values()].some((other) => !(other.eventId === candidate.family || other.eventId.startsWith(`${candidate.family}:`))
        && ((candidate.quake && other.quake && sameQuake(candidate.quake, other.quake)
            && (!feedIds.has(other.eventId) || quakeAgency(other.eventId) !== quakeAgency(candidate.eventId)))
          || (candidate.storm && other.storms.has(candidate.storm))));
      for (const eventId of [candidate.eventId, ...candidate.alsoRecord]) {
        const member = hazardMember(candidate, eventId);
        writes.push([now, member]);
        known.set(eventId, { eventId, members: [member], quake: candidate.quake, storms: new Set(candidate.storm ? [candidate.storm] : []) });
      }
      if (bootstrap) counters.bootstrapped += 1;
      else if (candidate.closed) counters.closed += 1;
      else if (!candidate.windowExempt && (candidate.timeMs === null || now - candidate.timeMs > newWithinMs)) counters.stale += 1;
      else if (duplicate) counters.crossSource += 1;
      else {
        counters.new += 1;
        occurrences.push({ event: HAZARD_EVENT, eventId: candidate.eventId, publishedAt: now, payload: candidate.payload });
      }
    }
  }
  return { occurrences, writes, initWrites, counters };
}

function scopeList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive; a keyword may contain spaces ("strait of hormuz"). */
export function keywordMatches(text, keyword) {
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(keyword)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  return pattern.test(String(text ?? ''));
}

/**
 * Pure. Does an occurrence event fall inside a subscription's stored scope?
 * Returns null when it does not, otherwise the per-subscription payload extras
 * (matchedKeywords for news). The scope was normalized at registration with
 * the registry defaults; a record with no scope at all filters nothing.
 * Country scopes are strict: an event the relay could not attribute to a
 * country never matches a country-scoped subscription (the in-app relay is
 * deliberately permissive there; an automation that asked for Iran must not
 * receive Brazil).
 */
export function matchOccurrence(record, occurrence) {
  if (recordEventType(record) !== occurrence?.event) return null;
  const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
  const payload = occurrence.payload;
  if (occurrence.event === NEWS_EVENT) {
    const floor = finiteNumber(scope.importanceFloor) ?? 0;
    if (payload.importanceScore < floor) return null;
    if (scope.severityFloor === 'critical' && payload.severity !== 'critical') return null;
    const categories = scopeList(scope.categories);
    if (categories.length && !(payload.category && categories.includes(payload.category))) return null;
    const countries = scopeList(scope.countries);
    if (countries.length && !payload.countryCodes.some((code) => countries.includes(code))) return null;
    const keywords = scopeList(scope.keywords);
    const matchedKeywords = keywords.filter((keyword) => keywordMatches(payload.title, keyword));
    if (keywords.length && !matchedKeywords.length) return null;
    return { matchedKeywords };
  }
  if (occurrence.event === MARKET_EVENT) {
    const assetClasses = scopeList(scope.assetClasses);
    if (assetClasses.length && !assetClasses.includes(payload.assetClass)) return null;
    const symbols = scopeList(scope.symbols);
    if (symbols.length && !symbols.includes(payload.symbol)) return null;
    const minAbsPct = finiteNumber(scope.minAbsPct) ?? 0;
    if (Math.abs(payload.changePct) < minAbsPct) return null;
    if ((scope.direction === 'up' || scope.direction === 'down') && payload.direction !== scope.direction) return null;
    return {};
  }
  if (occurrence.event === HAZARD_EVENT) {
    const hazardTypes = scopeList(scope.hazardTypes);
    if (hazardTypes.length && !hazardTypes.includes(payload.hazardType)) return null;
    const minMagnitude = finiteNumber(scope.minMagnitude);
    if (payload.hazardType === 'earthquakes' && minMagnitude !== null && !(payload.magnitude >= minMagnitude)) return null;
    // Every GDACS event WorldMonitor stores is Orange or Red (the seeder drops
    // Green), so an unknown level (a western-Pacific cyclone) passes Orange only.
    if (scope.minAlertLevel === 'Red' && payload.source === 'gdacs' && payload.alertLevel !== 'Red') return null;
    const countries = scopeList(scope.countries);
    if (countries.length && !payload.countryCodes.some((code) => countries.includes(code))) return null;
    return {};
  }
  return null;
}

/** Hour and day buckets of the per-subscription delivery counters, reset on the UTC boundary. */
export function nextCapState(previous, now) {
  const hour = isoFromMs(now).slice(0, 13);
  const day = hour.slice(0, 10);
  const prior = previous && typeof previous === 'object' ? previous : {};
  return {
    hour,
    hourCount: prior.hour === hour && Number.isSafeInteger(prior.hourCount) ? prior.hourCount : 0,
    day,
    dayCount: prior.day === day && Number.isSafeInteger(prior.dayCount) ? prior.dayCount : 0,
    suppressed: Number.isSafeInteger(prior.suppressed) ? prior.suppressed : 0,
  };
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
 * One subscriber on an occurrence event. Pending deliveries from earlier ticks
 * are re-queued first (oldest first, same delivery id, stored payload); those
 * past the event's pendingTtl are dropped and counted. Then each new
 * occurrence that matches the scope and is not already known to this
 * subscriber is queued under a fresh id, as long as the hour and day caps
 * leave room; the overflow is counted as suppressed and never stored, so it is
 * gone for good rather than delivered late. Delivered tombstones older than a
 * day are pruned. `prune` collects the hash fields to HDEL.
 */
function planOccurrenceRecord({ record, previous, next, prune, occurrences, now, triggeredAt, makeId, deliveries, counters }) {
  const event = recordEventType(record);
  const rule = OCCURRENCE_RULES[event];
  const pendingRetries = [];
  for (const [field, state] of Object.entries(previous)) {
    if (!field.startsWith(OCCURRENCE_STATE_PREFIX) || state?.kind !== 'occurrence') continue;
    if (state.pending) {
      const age = now - Date.parse(state.pending.triggeredAt);
      if (!(age < rule.pendingTtlMs) || !state.payload) {
        // Never sent, and never sent later: the tombstone keeps a republish
        // of the same event from starting over under a new delivery id.
        next[field] = { kind: 'occurrence', event: state.event, eventId: state.eventId, firstSeenAt: state.firstSeenAt, expiredAt: isoFromMs(now) };
        counters.expired += 1;
        continue;
      }
      pendingRetries.push([field, state]);
    } else if (now - Date.parse(state.deliveredAt ?? state.expiredAt) < DELIVERED_TOMBSTONE_MS) {
      continue;
    } else {
      prune.push(field);
      counters.pruned += 1;
    }
  }

  // The caps count events POSTed in each UTC hour and day. A pending retry
  // holds the slot of the bucket it was admitted (or last counted) in; carried
  // into a new bucket it needs a slot there, and waits, still pending, when
  // that bucket is full. Retries go first, oldest first, so the backlog drains
  // before new events take the room.
  const cap = nextCapState(previous[OCCURRENCE_CAP_FIELD], now);
  const capBefore = JSON.stringify(cap);
  pendingRetries.sort((a, b) => Date.parse(a[1].pending.triggeredAt) - Date.parse(b[1].pending.triggeredAt));
  for (const [field, state] of pendingRetries) {
    const admitted = isoFromMs(Date.parse(state.pending.triggeredAt));
    const countedHour = state.pending.countedHour ?? admitted.slice(0, 13);
    const countedDay = state.pending.countedDay ?? admitted.slice(0, 10);
    const needsHour = countedHour !== cap.hour;
    const needsDay = countedDay !== cap.day;
    if ((needsHour && cap.hourCount >= rule.maxPerHour) || (needsDay && cap.dayCount >= rule.maxPerDay)) {
      next[field] = state;
      counters.deferred += 1;
      continue;
    }
    if (needsHour) cap.hourCount += 1;
    if (needsDay) cap.dayCount += 1;
    const pending = { ...state.pending, countedHour: cap.hour, countedDay: cap.day };
    next[field] = { ...state, pending, attempts: (Number.isSafeInteger(state.attempts) ? state.attempts : 0) + 1 };
    deliveries.push({ record, event, stateField: field, sources: {}, deliveryId: pending.deliveryId, payload: state.payload });
  }

  for (const occurrence of occurrences) {
    if (occurrence.event !== event) continue;
    const field = occurrenceStateField(occurrence.eventId);
    if (previous[field] || next[field]) continue;
    const match = matchOccurrence(record, occurrence);
    if (!match) continue;
    counters.matched += 1;
    if (cap.hourCount >= rule.maxPerHour || cap.dayCount >= rule.maxPerDay) {
      cap.suppressed += 1;
      counters.suppressed += 1;
      continue;
    }
    cap.hourCount += 1;
    cap.dayCount += 1;
    const pending = { deliveryId: makeId(), triggeredAt };
    const payload = {
      subscriberId: record.subscriberId,
      ...occurrence.payload,
      ...(event === NEWS_EVENT ? { matchedKeywords: match.matchedKeywords } : {}),
      triggeredAt,
      reason: OCCURRENCE_REASONS[event],
    };
    next[field] = { kind: 'occurrence', event, eventId: occurrence.eventId, firstSeenAt: triggeredAt, attempts: 1, pending, payload };
    deliveries.push({ record, event, stateField: field, sources: {}, deliveryId: pending.deliveryId, payload });
  }
  if (JSON.stringify(cap) !== capBefore || (previous[OCCURRENCE_CAP_FIELD] && previous[OCCURRENCE_CAP_FIELD].hour !== cap.hour)) {
    next[OCCURRENCE_CAP_FIELD] = cap;
  }
}

export function emptyOccurrenceCounters() {
  return { drained: 0, unreadable: 0, duplicates: 0, matched: 0, suppressed: 0, deferred: 0, expired: 0, pruned: 0 };
}

/**
 * Pure. `records` are active, parsed subscriber records; `states` maps
 * subscriberId to its stored per-entity state. `chokepoints`, `riskScores` or
 * `occurrences` may be null when that source was unreadable this tick:
 * records on that event are then left untouched (no state write, nothing
 * fired, pendings not retried) while records on the other events proceed.
 * `occurrences` are the fan-out messages drained this tick, oldest first,
 * copies included: a subscriber takes the first copy of an eventId that
 * matches its scope and skips the rest through its `occ:` field; `prunes`
 * maps a subscriberId to the state fields to HDEL. `hazards` are the
 * natural.hazard occurrences diffHazards found new this tick (null when
 * neither hazard feed was readable), handled the same way.
 */
export function planTick({ chokepoints, riskScores = null, occurrences = null, hazards = null, records, states, now, scoresFetchedAt, riskFetchedAt = null, makeId = makeDeliveryId }) {
  const byId = new Map((chokepoints ?? [])
    .filter((cp) => typeof cp?.id === 'string' && Number.isFinite(cp.disruptionScore))
    .map((cp) => [cp.id, cp]));
  const ciiByCountry = new Map((riskScores?.ciiScores ?? [])
    .filter((cii) => typeof cii?.region === 'string' && Number.isFinite(cii.combinedScore) && Number.isFinite(cii.dynamicScore))
    .map((cii) => [cii.region, cii]));
  const triggeredAt = new Date(now).toISOString();
  const deliveries = [];
  const nextStates = new Map();
  const prunes = new Map();
  const counters = emptyOccurrenceCounters();
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
    } else if (OCCURRENCE_RULES[eventType]) {
      const source = eventType === HAZARD_EVENT ? hazards : occurrences;
      if (!source) continue;
      const prune = [];
      planOccurrenceRecord({ record, previous, next, prune, occurrences: source, now, triggeredAt, makeId, deliveries, counters });
      if (prune.length) prunes.set(record.subscriberId, prune);
    } else {
      continue;
    }
    nextStates.set(record.subscriberId, next);
  }
  return { deliveries, nextStates, prunes, counters };
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

/**
 * Drains the oldest FANOUT_DRAIN_MAX fan-out messages (the list tail; the relay
 * LPUSHes at the head) and normalizes them, oldest first. Null when the list
 * is unreadable, so occurrence records are skipped this tick the way a
 * missing feed skips its event. The messages are trimmed only after the tick
 * persisted its pending state (FANOUT_TRIM_SCRIPT), so a crash in between
 * replays them, which the per-subscriber `occ:` fields make a no-op. If the relay's own cap trimmed the tail between the read and the
 * trim, the trim can drop as many unread messages as were lost; that only
 * happens after the worker has been away long enough to fill 2,000 messages.
 */
export async function readFanout({ redis, now = Date.now() }) {
  let rows;
  try {
    rows = await redis([['LRANGE', FANOUT_LIST_KEY, String(-FANOUT_DRAIN_MAX), '-1']]);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || rows[0].error) return null;
  const messages = Array.isArray(rows[0].result) ? [...rows[0].result].reverse() : [];
  const occurrences = [];
  let unreadable = 0;
  for (const raw of messages) {
    const occurrence = normalizeTeeMessage(raw, now);
    if (occurrence) occurrences.push(occurrence);
    else unreadable += 1;
  }
  return { count: messages.length, occurrences, unreadable };
}

function seededArray(row, field) {
  if (!row || row.error || typeof row.result !== 'string') return null;
  const { data } = unwrapEnvelope(row.result);
  return Array.isArray(data?.[field]) ? data[field] : null;
}

/**
 * Reads both hazard feeds (seed envelopes), the hazard seen set and the
 * initialized-feeds marker in one round trip. A missing or malformed key comes
 * back as a null feed, which diffHazards leaves alone; null overall when the
 * round trip, the seen-set or the marker read fails, since diffing without
 * them would re-deliver everything or bootstrap wrongly.
 */
export async function readHazardFeeds({ redis }) {
  let rows;
  try {
    rows = await redis([
      ['GET', EARTHQUAKES_KEY],
      ['GET', NATURAL_EVENTS_KEY],
      ['ZRANGE', seenKey(HAZARD_EVENT), '0', '-1'],
      ['HGETALL', HAZARD_INIT_KEY],
    ]);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length !== 4 || [rows[2], rows[3]].some((row) => !row || row.error)) return null;
  const init = Array.isArray(rows[3].result) ? rows[3].result : [];
  return {
    initialized: init.filter((_, index) => index % 2 === 0),
    earthquakes: seededArray(rows[0], 'earthquakes'),
    naturalEvents: seededArray(rows[1], 'events'),
    seen: parseHazardSeen(Array.isArray(rows[2].result) ? rows[2].result : []),
  };
}

/**
 * Counts the drained copies whose eventId was already seen, in an earlier
 * tick (the global seen set) or earlier in this drain (the relay publishes one
 * copy per site variant, and republishes a sustained market move hourly).
 * Nothing is dropped here: whether a subscriber already has an eventId is
 * settled by its own `occ:` field, so a later copy that newly clears one
 * subscriber's scope (a bigger move, a reworded headline) still reaches it,
 * while subscribers that already have the event skip it. Informational only.
 */
async function countSeen(redis, occurrences) {
  const unique = new Map();
  let duplicates = 0;
  for (const occurrence of occurrences) {
    const key = `${occurrence.event}\u0000${occurrence.eventId}`;
    if (unique.has(key)) duplicates += 1;
    else unique.set(key, occurrence);
  }
  const candidates = [...unique.values()];
  const scores = await runBatched(redis, candidates, (occurrence) => ['ZSCORE', seenKey(occurrence.event), occurrence.eventId], 'seen read');
  return duplicates + scores.filter((score) => score !== null && score !== undefined).length;
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
    fanoutState: summary.fanoutState,
    hazardSourceState: summary.hazardSourceState,
    deliveries: summary.deliveries,
    failures: summary.failures,
    deactivated: summary.deactivated,
    pruned: summary.pruned,
    occurrences: summary.occurrences,
    hazards: summary.hazards,
    scoresFetchedAt: summary.scoresFetchedAt,
    riskFetchedAt: summary.riskFetchedAt,
  };
  const status = {
    lastRunAt: fetchedAt,
    subscribers: summary.subscribers,
    deliveries: summary.deliveries,
    failures: summary.failures,
    occurrences: summary.occurrences,
    hazards: summary.hazards,
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
  const fanout = await readFanout({ redis, now: now() });
  const hazardFeeds = await readHazardFeeds({ redis });
  const hazardsReadable = Boolean(hazardFeeds && (hazardFeeds.earthquakes || hazardFeeds.naturalEvents));
  const summary = {
    sourceState: 'ok',
    riskSourceState: riskScores ? 'ok' : 'error',
    fanoutState: fanout ? 'ok' : 'error',
    hazardSourceState: !hazardsReadable ? 'error' : hazardFeeds.earthquakes && hazardFeeds.naturalEvents ? 'ok' : 'partial',
    hazards: emptyHazardCounters(),
    subscribers: 0,
    deliveries: 0,
    failures: 0,
    deactivated: 0,
    pruned: 0,
    backfilled: 0,
    occurrences: emptyOccurrenceCounters(),
    scoresFetchedAt: status?.fetchedAt || null,
    riskFetchedAt: riskScores?.fetchedAt || null,
    source: status?.source ?? null,
    riskSource: riskScores?.source ?? null,
  };
  // Each event is evaluated against its own source: a chokepoint outage must
  // not hold back a country.risk_surge or a breaking-news delivery. Only when
  // no source is readable is there nothing to do this tick.
  if (!status) summary.sourceState = 'error';
  if (!status && !riskScores && !fanout && !hazardsReadable) {
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

  let occurrences = null;
  if (fanout) {
    occurrences = fanout.occurrences;
    summary.occurrences.drained = fanout.count;
    summary.occurrences.unreadable = fanout.unreadable;
    summary.occurrences.duplicates = await countSeen(redis, fanout.occurrences);
  }
  const hazardDiff = hazardsReadable ? diffHazards(hazardFeeds, hazardFeeds.seen, now()) : null;
  if (hazardDiff) summary.hazards = hazardDiff.counters;

  const { deliveries, nextStates, prunes, counters } = planTick({
    chokepoints: status?.chokepoints ?? null,
    riskScores,
    occurrences,
    hazards: hazardDiff ? hazardDiff.occurrences : null,
    records,
    states,
    now: now(),
    scoresFetchedAt: summary.scoresFetchedAt,
    riskFetchedAt: summary.riskFetchedAt,
  });
  for (const key of ['matched', 'suppressed', 'deferred', 'expired', 'pruned']) summary.occurrences[key] = counters[key];

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
        const current = next[stateField];
        if (current?.kind === 'occurrence') {
          // Delivered: keep a tombstone (no payload) so a replayed message is
          // a no-op for this subscriber until it is pruned a day later.
          next[stateField] = { kind: 'occurrence', event: current.event, eventId: current.eventId, firstSeenAt: current.firstSeenAt, deliveredAt: new Date(at).toISOString() };
        } else {
          const { pending: _pending, ...delivered } = current;
          next[stateField] = { ...delivered, armed: false, lastDeliveredAt: new Date(at).toISOString(), sources };
        }
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
  assertFenced(await runBatched(redis, [...prunes], ([subscriberId, fields]) => [
    'EVAL', STATE_HDEL_SCRIPT, '2', fence.key, stateKey(subscriberId), fence.token, ...fields,
  ], 'state prune'));

  // Every drained id is marked seen, matched or not, and only after the pending
  // state above is durable; the list is trimmed last. A tick that dies before
  // this point replays the same messages next tick.
  if (fanout) {
    const byEvent = new Map();
    for (const occurrence of fanout.occurrences) {
      if (!byEvent.has(occurrence.event)) byEvent.set(occurrence.event, new Map());
      byEvent.get(occurrence.event).set(occurrence.eventId, occurrence.publishedAt);
    }
    const seenWrites = [...byEvent].map(([event, ids]) => {
      const rule = OCCURRENCE_RULES[event];
      const tickMs = now();
      return [
        'EVAL', SEEN_ADD_SCRIPT, '2', fence.key, seenKey(event),
        fence.token, String(tickMs - rule.seenWindowMs), String(Math.ceil((rule.seenWindowMs * 2) / 1000)),
        ...[...ids.keys()].flatMap((eventId) => [String(tickMs), eventId]),
      ];
    });
    assertFenced(await runBatched(redis, seenWrites, (command) => command, 'seen write'));
    if (fanout.count > 0) {
      const [trimmed] = assertRows(await redis([[
        'EVAL', FANOUT_TRIM_SCRIPT, '2', fence.key, FANOUT_LIST_KEY, fence.token, String(fanout.count),
      ]]), 1, 'fan-out trim');
      assertFenced([trimmed.result]);
    }
  }
  // The hazard seen set is written after the pending state too: a tick that
  // dies first re-diffs the same rows, and each subscriber's occ: field makes
  // the second pass a no-op. Every id in a readable feed is refreshed, so the
  // prune only drops ids gone from both feeds for the whole seen window.
  if (hazardDiff?.writes.length) {
    const tickMs = now();
    const [written] = assertRows(await redis([[
      'EVAL', HAZARD_SEEN_SCRIPT, '2', fence.key, seenKey(HAZARD_EVENT),
      fence.token, String(tickMs - HAZARD_RULE.seenWindowMs), String(Math.ceil((HAZARD_RULE.seenWindowMs * 2) / 1000)),
      ...hazardDiff.writes.flatMap(([score, member]) => [String(score), member]),
    ]]), 1, 'hazard seen write');
    assertFenced([written.result]);
  }
  // After the seen ids: a tick that dies in between re-reads ids, which keep
  // the feed from bootstrapping anyway.
  if (hazardDiff?.initWrites.length) {
    const tickMs = now();
    const [marked] = assertRows(await redis([[
      'EVAL', HAZARD_INIT_SCRIPT, '2', fence.key, HAZARD_INIT_KEY,
      fence.token, ...hazardDiff.initWrites.flatMap((feed) => [feed, String(tickMs)]),
    ]]), 1, 'hazard init write');
    assertFenced([marked.result]);
  }
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
        const occ = result.occurrences ?? emptyOccurrenceCounters();
        console.log(
          `[shipping-webhook-worker] tick source=${result.source ?? 'none'} state=${result.sourceState} `
          + `risk=${result.riskSourceState} fanout=${result.fanoutState} `
          + `subscribers=${result.subscribers} deliveries=${result.deliveries} failures=${result.failures} `
          + `deactivated=${result.deactivated} pruned=${result.pruned} backfilled=${result.backfilled} `
          + `occ.drained=${occ.drained} occ.duplicates=${occ.duplicates} occ.matched=${occ.matched} `
          + `occ.suppressed=${occ.suppressed} occ.expired=${occ.expired} `
          + `hazard=${result.hazardSourceState} haz.new=${result.hazards?.new ?? 0} `
          + `haz.bootstrapped=${result.hazards?.bootstrapped ?? 0} haz.crossSource=${result.hazards?.crossSource ?? 0}`,
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
