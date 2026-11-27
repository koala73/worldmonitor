'use strict';

/**
 * @notification-source: domain
 *   payload.title is built from structured reservoir records (name, level,
 *   measurement date). Not RSS-origin; MUST NOT set payload.description.
 *   Enforced by tests/notification-relay-payload-audit.test.mjs.
 */

// Opt-in Pro alert for Strategic Water Levels. After each seed run the producer
// publishes one `reservoir_level_alert` event per reservoir whose lidar
// measurement date advanced. The event carries the measurement itself (date,
// level, share of its measured range, seasonal drop flag); the relay then
// applies each rule's own choice in `reservoirAlertDecision`: a level below the
// chosen share of the reservoir's range, or a drop beyond its seasonal baseline.
// The baseline is the seeder's (seasonalBaseline in scripts/_reservoir-levels.mjs):
// this module never computes one, it only carries the seeder's verdict.
//
// Satellite levels reach NASA 50-70 days after the overpass, so every title says
// when the level was measured and none says it is current.

const RESERVOIR_ALERT_EVENT_TYPE = 'reservoir_level_alert';
// A level measured days ago is never urgent, so the event is not critical: quiet hours silence
// it (or hold it, under Batch). The relay lets it past the realtime critical-only gate because
// the per-reservoir opt-in and the rule's own threshold are the filters (shouldNotify).
const SEVERITY = 'medium';
const DEDUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const STATE_KEY = 'notify:reservoir-level:state:v1';
const STATE_TTL_SECONDS = 120 * 24 * 60 * 60;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
function isMeasurementDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * What one rule makes of one event payload. `settings` is the rule's `reservoirAlert`.
 * Returns the criteria that fired; nothing fires without a dated measurement.
 */
function reservoirAlertDecision(settings, payload) {
  const none = { fire: false, reasons: [] };
  if (!settings || !Array.isArray(settings.reservoirs) || settings.reservoirs.length === 0) return none;
  if (typeof payload?.reservoirId !== 'string' || !settings.reservoirs.includes(payload.reservoirId)) return none;
  if (!isMeasurementDate(payload.measuredAt)) return none;
  const reasons = [];
  const percent = finite(payload.percentOfRange);
  if (finite(settings.belowPercent) != null && percent != null && percent < settings.belowPercent) reasons.push('below_threshold');
  if (settings.seasonalDrop === true && payload.beyondSeasonalBaseline === true) reasons.push('seasonal_drop');
  return { fire: reasons.length > 0, reasons };
}

function describeLevel(record, levelM) {
  const parts = [`${record.name}: lidar level ${levelM.toFixed(1)} m, measured ${record.latest.date}`];
  const percent = finite(record.percentOfRange);
  if (percent != null) parts.push(`${percent.toFixed(0)}% of its measured range`);
  const anomaly = finite(record.seasonalAnomalyM);
  if (anomaly != null) parts.push(`${Math.abs(anomaly).toFixed(1)} m ${anomaly < 0 ? 'below' : 'above'} its seasonal norm`);
  return parts.join(', ');
}

/** The event for a reservoir's latest measurement, or null when it has no dated measurement. */
function buildReservoirLevelEvent(record) {
  const levelM = finite(record?.latest?.levelM);
  const date = record?.latest?.date;
  if (typeof record?.id !== 'string' || !record.id || levelM == null || !isMeasurementDate(date)) return null;
  const key = `${RESERVOIR_ALERT_EVENT_TYPE}:${record.id}:${date}`;
  return {
    eventType: RESERVOIR_ALERT_EVENT_TYPE,
    severity: SEVERITY,
    cooldownSeconds: DEDUP_TTL_SECONDS,
    payload: {
      title: describeLevel(record, levelM),
      // Not a first-party name: sanitizeNotificationSource rewrites those to "Community alert".
      source: 'NASA ICESat-2 lidar',
      reservoirId: record.id,
      reservoirName: record.name,
      // Not countryCode/country: those make the relay's country scope veto an alert the user listed by name.
      reservoirCountry: typeof record.country === 'string' ? record.country : undefined,
      measuredAt: date,
      levelM,
      percentOfRange: finite(record.percentOfRange),
      seasonalAnomalyM: finite(record.seasonalAnomalyM),
      seasonalZ: finite(record.seasonalZ),
      beyondSeasonalBaseline: record.belowSeasonalBaseline === true,
      dedupe_key: key,
      coalesceKey: key,
    },
  };
}

/**
 * Publishes the reservoirs whose measurement date advanced since the last run. State maps
 * each reservoir id to the newest measurement date already answered. The first run only
 * records what is already measured: a backlog of old measurements is not news, and a
 * reservoir new to a known state is likewise answered on its next measurement. A date is
 * answered once `publish` resolves true (queued, or already queued); a failed publish
 * leaves it open for the next run. Returns a summary, or null when the state could not
 * be read (nothing is published then).
 */
async function publishReservoirLevelAlerts(records, { readState, writeState, publish }) {
  const list = Array.isArray(records) ? records.filter((r) => buildReservoirLevelEvent(r) !== null) : [];
  if (list.length === 0) return { published: 0, failed: 0, seeded: 0, stateWritten: false };

  let readFailed = false;
  const stored = await readState(STATE_KEY, () => { readFailed = true; });
  if (readFailed) return null;
  const state = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};

  let published = 0;
  let failed = 0;
  let seeded = 0;
  for (const record of list) {
    const date = record.latest.date;
    const answered = typeof state[record.id] === 'string' ? state[record.id] : null;
    if (answered == null) {
      state[record.id] = date;
      seeded += 1;
      continue;
    }
    if (date <= answered) continue;
    if (await publish(buildReservoirLevelEvent(record))) {
      state[record.id] = date;
      published += 1;
    } else {
      failed += 1;
    }
  }
  const stateWritten = (await writeState(STATE_KEY, state, STATE_TTL_SECONDS)) !== false;
  return { published, failed, seeded, stateWritten };
}

module.exports = {
  RESERVOIR_ALERT_EVENT_TYPE,
  SEVERITY,
  STATE_KEY,
  DEDUP_TTL_SECONDS,
  isMeasurementDate,
  reservoirAlertDecision,
  buildReservoirLevelEvent,
  publishReservoirLevelAlerts,
};
