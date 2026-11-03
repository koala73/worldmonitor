'use strict';

/**
 * @notification-source: domain
 *   payload.title is built from structured chokepoint status fields (name,
 *   disruptionScore). Not RSS-origin; MUST NOT set payload.description.
 *   Enforced by tests/notification-relay-payload-audit.test.mjs.
 */

// Publishes `chokepoint_disruption` notification events (#9217 item 6). Alert
// rules opt in to the event and may narrow it to chosen chokepoints;
// scripts/notification-relay.cjs does the per-rule matching.
//
// disruptionScore (server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts)
// is a standing threat level set per chokepoint (war zone 70 ... normal 0)
// plus live signals: navigational warnings, AIS disruption, a transit drop.
// The score alone cannot drive an alert: Hormuz and Kerch sit at 70 with no
// live signal and would fire once and never again, while Bab el-Mandeb (40)
// would flap on one warning. So an alert needs both the red band and live
// signals well above the standing level.

const EVENT_TYPE = 'chokepoint_disruption';
const RED_THRESHOLD = 50; // scoreToStatus() in _scoring.mjs
const LIVE_FIRE_POINTS = 15;
// Hysteresis: re-arm only once the score or the live signals have clearly
// subsided, so a reading that wobbles around the threshold fires once.
const REARM_SCORE = 40;
const REARM_LIVE_POINTS = 5;
const REFIRE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const STATE_KEY = 'notify:chokepoint-disruption:state:v1';
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
// Publisher dedup window for one crossing's coalesceKey. Well past the
// 30-minute tick, so a retried publish of the same crossing is suppressed.
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

// THREAT_LEVEL in _scoring.mjs, keyed by the warRiskTier the response carries.
const THREAT_POINTS_BY_TIER = {
  WAR_RISK_TIER_WAR_ZONE: 70,
  WAR_RISK_TIER_CRITICAL: 40,
  WAR_RISK_TIER_HIGH: 30,
  WAR_RISK_TIER_ELEVATED: 15,
  WAR_RISK_TIER_NORMAL: 0,
};
const AIS_POINTS_BY_CONGESTION = { high: 15, elevated: 10, low: 5 };

/** Splits a score into its standing threat level and live signals. */
function breakdown(chokepoint) {
  // Number(null) is 0, which would read as a fully subsided score.
  const raw = chokepoint?.disruptionScore;
  const score = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
  const baseline = THREAT_POINTS_BY_TIER[chokepoint?.warRiskTier] ?? 0;
  const live = Math.max(0, score - baseline);
  const warnings = Math.min(15, Math.max(0, Number(chokepoint?.activeWarnings) || 0) * 5);
  const ais = AIS_POINTS_BY_CONGESTION[chokepoint?.congestionLevel] ?? 0;
  return { score, live, transitDrop: live - warnings - ais > 0 };
}

/**
 * One chokepoint's edge state: armed → pending (crossing recorded, publish
 * owed) → fired. A pending crossing keeps its crossingAt, so every retry
 * publishes the same coalesceKey. Re-arming needs a reading with the warning
 * and AIS sources available, and transit data too when the crossing carried a
 * transit drop: a missing source can only lower the score.
 */
function advance(previous, chokepoint, nowMs) {
  const { score, live, transitDrop } = breakdown(chokepoint);
  if (!Number.isFinite(score)) return { next: previous, publish: null };

  const subsided = score < REARM_SCORE || live < REARM_LIVE_POINTS;
  if (subsided) {
    const complete = chokepoint.navigationalWarningsAvailable === true
      && chokepoint.aisSnapshotAvailable === true
      && (previous?.transitDrop !== true || chokepoint.transitSummary?.dataAvailable === true);
    if (!complete || !previous || previous.phase === 'armed') return { next: previous, publish: null };
    return { next: { phase: 'armed', ...(previous.firedAt ? { firedAt: previous.firedAt } : {}) }, publish: null };
  }

  if (previous?.phase === 'pending') return { next: previous, publish: previous.crossingAt };
  if (previous?.phase === 'fired') return { next: previous, publish: null };
  if (score < RED_THRESHOLD || live < LIVE_FIRE_POINTS) return { next: previous, publish: null };
  if (Number.isFinite(previous?.firedAt) && nowMs - previous.firedAt < REFIRE_COOLDOWN_MS) {
    return { next: previous, publish: null };
  }
  const crossingAt = new Date(nowMs).toISOString();
  return {
    next: { phase: 'pending', crossingAt, ...(transitDrop ? { transitDrop: true } : {}) },
    publish: crossingAt,
  };
}

function buildEvent(chokepoint, crossingAt) {
  const name = typeof chokepoint.name === 'string' && chokepoint.name ? chokepoint.name : chokepoint.id;
  const score = Number(chokepoint.disruptionScore);
  return {
    eventType: EVENT_TYPE,
    // Realtime rules deliver critical events only (notification-relay
    // shouldNotify).
    severity: 'critical',
    dedupTtl: DEDUP_TTL_SECONDS,
    payload: {
      title: `${name}: disruption score ${score}/100`,
      // Not a first-party name: sanitizeNotificationSource rewrites those to
      // "Community alert".
      source: 'Chokepoint Monitor',
      chokepointId: chokepoint.id,
      chokepointName: name,
      disruptionScore: score,
      status: 'red',
      activeWarnings: Number(chokepoint.activeWarnings) || 0,
      congestionLevel: typeof chokepoint.congestionLevel === 'string' ? chokepoint.congestionLevel : '',
      triggeredAt: crossingAt,
      coalesceKey: `chokepoint_disruption:${chokepoint.id}:${crossingAt}`,
    },
  };
}

/**
 * Advances every chokepoint in a get-chokepoint-status response. New
 * crossings are persisted as pending BEFORE any publish, so a lost write
 * after a publish cannot mint a second crossing id; then each pending
 * crossing is published and, once `publish` resolves true (queued or already
 * queued), marked fired. Returns a summary, or null when the state could not
 * be read or the pending write failed (nothing is published then).
 */
async function publishChokepointDisruptionAlerts(status, { now, readState, writeState, publish, log = () => {} }) {
  const chokepoints = Array.isArray(status?.chokepoints) ? status.chokepoints : [];
  if (chokepoints.length === 0) return { published: 0, failed: 0, stateWritten: false, skipped: 'no_chokepoints' };

  let readFailed = false;
  const stored = await readState(STATE_KEY, (reason) => {
    // A corrupt stored value would otherwise stall alerts until its TTL
    // lapses. A malformed Upstash response body ("JSON response parse
    // failed") is a transport error: starting fresh then would overwrite the
    // saved fired state and re-alert every red chokepoint.
    if (/JSON result parse failed/.test(String(reason))) log(`[Chokepoints] Disruption alert state unparseable (${reason}); starting fresh`);
    else readFailed = true;
  });
  if (readFailed) return null;
  const state = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};

  const nowMs = now();
  const owed = [];
  for (const chokepoint of chokepoints) {
    if (typeof chokepoint?.id !== 'string' || !chokepoint.id) continue;
    const { next, publish: crossingAt } = advance(state[chokepoint.id], chokepoint, nowMs);
    if (next) state[chokepoint.id] = next;
    if (crossingAt) owed.push({ chokepoint, crossingAt });
  }
  if (owed.length && (await writeState(STATE_KEY, state, STATE_TTL_SECONDS)) === false) return null;

  let published = 0;
  let failed = 0;
  for (const { chokepoint, crossingAt } of owed) {
    if (await publish(buildEvent(chokepoint, crossingAt))) {
      state[chokepoint.id] = { ...state[chokepoint.id], phase: 'fired', firedAt: nowMs };
      published += 1;
    } else {
      failed += 1;
    }
  }
  // A lost write leaves fired crossings pending; the next tick re-publishes
  // them with the same coalesceKey, which the publisher dedups.
  const stateWritten = (await writeState(STATE_KEY, state, STATE_TTL_SECONDS)) !== false;
  return { published, failed, stateWritten, skipped: null };
}

module.exports = {
  EVENT_TYPE,
  RED_THRESHOLD,
  LIVE_FIRE_POINTS,
  REARM_SCORE,
  REARM_LIVE_POINTS,
  REFIRE_COOLDOWN_MS,
  DEDUP_TTL_SECONDS,
  THREAT_POINTS_BY_TIER,
  STATE_KEY,
  STATE_TTL_SECONDS,
  advance,
  breakdown,
  buildEvent,
  publishChokepointDisruptionAlerts,
};
