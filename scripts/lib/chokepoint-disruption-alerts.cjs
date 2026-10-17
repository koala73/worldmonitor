'use strict';

// Publishes `chokepoint_disruption` notification events (#9217 item 6) when a
// chokepoint's disruptionScore enters the red band that
// server/worldmonitor/supply-chain/v1/_scoring.mjs scoreToStatus() draws at 50.
// Alert rules opt in to the event and may narrow it to chosen chokepoints;
// scripts/notification-relay.cjs does the per-rule matching.

const EVENT_TYPE = 'chokepoint_disruption';
const RED_THRESHOLD = 50;
const STATE_KEY = 'notify:chokepoint-disruption:state:v1';
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * One chokepoint's edge state. A reading at or above the threshold publishes
 * once, then holds until a reading below it re-arms. A below-threshold reading
 * taken while the warning or AIS source was unavailable does not re-arm: a
 * missing source can only lower the score.
 */
function advance(previous, chokepoint) {
  const score = Number(chokepoint?.disruptionScore);
  if (!Number.isFinite(score)) return { next: previous, fire: false };
  if (score < RED_THRESHOLD) {
    const complete = chokepoint.navigationalWarningsAvailable === true && chokepoint.aisSnapshotAvailable === true;
    return { next: complete ? { phase: 'armed' } : previous, fire: false };
  }
  if (previous?.phase === 'fired') return { next: previous, fire: false };
  return { next: { phase: 'fired' }, fire: true };
}

function buildEvent(chokepoint, triggeredAt) {
  const name = typeof chokepoint.name === 'string' && chokepoint.name ? chokepoint.name : chokepoint.id;
  const score = Number(chokepoint.disruptionScore);
  return {
    eventType: EVENT_TYPE,
    // Realtime rules deliver critical events only (notification-relay
    // shouldNotify), and red is the highest band the score has.
    severity: 'critical',
    payload: {
      title: `${name}: disruption score ${score}/100`,
      source: 'Chokepoint Monitor',
      chokepointId: chokepoint.id,
      chokepointName: name,
      disruptionScore: score,
      status: 'red',
      activeWarnings: Number(chokepoint.activeWarnings) || 0,
      congestionLevel: typeof chokepoint.congestionLevel === 'string' ? chokepoint.congestionLevel : '',
      triggeredAt,
      // One key per crossing: the publisher dedups a retried tick, a later
      // crossing of the same chokepoint is a new event.
      coalesceKey: `chokepoint_disruption:${chokepoint.id}:${triggeredAt}`,
    },
  };
}

/**
 * Advances every chokepoint in a get-chokepoint-status response and publishes
 * one event per upward crossing. `publish` resolves true once the event is
 * queued (or was already queued); a chokepoint whose publish fails stays
 * armed for the next tick. Returns a summary, or null when the state could
 * not be read (publishing then would re-fire every red chokepoint).
 */
async function publishChokepointDisruptionAlerts(status, { now, readState, writeState, publish }) {
  const chokepoints = Array.isArray(status?.chokepoints) ? status.chokepoints : [];
  if (chokepoints.length === 0) return { published: 0, failed: 0, stateWritten: false, skipped: 'no_chokepoints' };

  let readFailed = false;
  const stored = await readState(STATE_KEY, () => { readFailed = true; });
  if (readFailed) return null;
  const state = stored && typeof stored === 'object' ? { ...stored } : {};

  const triggeredAt = new Date(now()).toISOString();
  let published = 0;
  let failed = 0;
  for (const chokepoint of chokepoints) {
    if (typeof chokepoint?.id !== 'string' || !chokepoint.id) continue;
    const { next, fire } = advance(state[chokepoint.id], chokepoint);
    if (fire) {
      if (await publish(buildEvent(chokepoint, triggeredAt))) {
        published += 1;
      } else {
        failed += 1;
        continue;
      }
    }
    if (next) state[chokepoint.id] = next;
  }
  // A lost write re-arms every chokepoint that fired this tick, so the next
  // tick publishes them again (at-least-once); the caller logs it.
  const stateWritten = (await writeState(STATE_KEY, state, STATE_TTL_SECONDS)) !== false;
  return { published, failed, stateWritten, skipped: null };
}

module.exports = {
  EVENT_TYPE,
  RED_THRESHOLD,
  STATE_KEY,
  STATE_TTL_SECONDS,
  advance,
  buildEvent,
  publishChokepointDisruptionAlerts,
};
