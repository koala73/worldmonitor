// @ts-check
// Regional Intelligence state-change alert emitter.
//
// Phase 2 PR1 — reads the SnapshotDiff produced by diffRegionalSnapshot()
// and enqueues one notification event per meaningful state change onto the
// existing wm:events:queue Redis list consumed by notification-relay.cjs.
//
// Emits on 4 event types:
//   regional_regime_shift      — diff.regime_changed set
//   regional_trigger_activation — one per entry in diff.trigger_activations
//   regional_corridor_break    — one per entry in diff.corridor_breaks
//   regional_buffer_failure    — one per entry in diff.buffer_failures
//
// Scenario jumps and leverage shifts are intentionally NOT emitted —
// probability fluctuations are noisy and not actionable as alerts.
//
// Severity mapping:
//   - critical when regime shifts to escalation_ladder or fragmentation_risk
//   - critical for every corridor_break
//   - high for other regime shifts, trigger activations, buffer failures
//   - nothing below high is emitted
//
// Best-effort: `emitRegionalAlerts` never throws. Each event publisher
// call is guarded independently, so one failure cannot block other events
// or the snapshot persist that called it. The default publisher uses the
// same Upstash REST pattern as ais-relay.cjs:
//   1. SET NX on wm:notif:scan-dedup:{eventType}:{hash} (6h TTL)
//   2. LPUSH on wm:events:queue with JSON {eventType, payload, severity,
//      publishedAt}
//
// The `publishEvent` function is dependency-injectable via opts so unit
// tests can exercise the full event-building + dedup pipeline without
// touching the network.

import { getRedisCredentials } from '../_seed-utils.mjs';

// ── Event type constants ─────────────────────────────────────────────────────

const EVENT_REGIME_SHIFT = 'regional_regime_shift';
const EVENT_TRIGGER_ACTIVATION = 'regional_trigger_activation';
const EVENT_CORRIDOR_BREAK = 'regional_corridor_break';
const EVENT_BUFFER_FAILURE = 'regional_buffer_failure';

/** Regime labels that upgrade a regime shift from high to critical severity. */
const CRITICAL_REGIME_LABELS = new Set(['escalation_ladder', 'fragmentation_risk']);

/** Dedup TTL for the notification queue. Matches the 6h snapshot cron cadence. */
const DEDUP_TTL_SECONDS = 6 * 60 * 60;

// ── Humanization helpers (pure) ──────────────────────────────────────────────

function humanRegime(label) {
  return String(label ?? '').replace(/_/g, ' ') || 'unknown';
}

function humanAxis(axis) {
  return String(axis ?? '').replace(/_/g, ' ');
}

// ── Pure event builders ──────────────────────────────────────────────────────

/**
 * @param {{id: string, label: string}} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {{from: string, to: string}} regimeChange
 */
function buildRegimeShiftEvent(region, snapshot, regimeChange) {
  const severity = CRITICAL_REGIME_LABELS.has(regimeChange.to) ? 'critical' : 'high';
  const fromLabel = regimeChange.from || 'none';
  return {
    eventType: EVENT_REGIME_SHIFT,
    severity,
    payload: {
      title: `${region.label}: regime ${humanRegime(fromLabel)} → ${humanRegime(regimeChange.to)}`,
      region_id: region.id,
      snapshot_id: snapshot.meta?.snapshot_id ?? '',
      triggered_at: snapshot.generated_at,
      details: { from: fromLabel, to: regimeChange.to },
    },
  };
}

/**
 * @param {{id: string, label: string}} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {{id: string, description: string}[]} activations
 */
function buildTriggerActivationEvents(region, snapshot, activations) {
  return (activations ?? []).map((t) => ({
    eventType: EVENT_TRIGGER_ACTIVATION,
    severity: 'high',
    payload: {
      title: `${region.label}: trigger ${t.id}${t.description ? ` — ${t.description}` : ''}`,
      region_id: region.id,
      snapshot_id: snapshot.meta?.snapshot_id ?? '',
      triggered_at: snapshot.generated_at,
      details: { trigger_id: t.id, description: t.description ?? '' },
    },
  }));
}

/**
 * @param {{id: string, label: string}} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {{corridor_id: string, from: string, to: string}[]} breaks
 */
function buildCorridorBreakEvents(region, snapshot, breaks) {
  return (breaks ?? []).map((b) => ({
    eventType: EVENT_CORRIDOR_BREAK,
    severity: 'critical',
    payload: {
      title: `${region.label}: corridor degraded — ${b.corridor_id} (${b.from} → ${b.to})`,
      region_id: region.id,
      snapshot_id: snapshot.meta?.snapshot_id ?? '',
      triggered_at: snapshot.generated_at,
      details: { corridor_id: b.corridor_id, from: b.from, to: b.to },
    },
  }));
}

/**
 * @param {{id: string, label: string}} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {{axis: string, from: number, to: number}[]} failures
 */
function buildBufferFailureEvents(region, snapshot, failures) {
  return (failures ?? []).map((f) => ({
    eventType: EVENT_BUFFER_FAILURE,
    severity: 'high',
    payload: {
      title: `${region.label}: buffer failure — ${humanAxis(f.axis)} ${f.from.toFixed(2)} → ${f.to.toFixed(2)}`,
      region_id: region.id,
      snapshot_id: snapshot.meta?.snapshot_id ?? '',
      triggered_at: snapshot.generated_at,
      details: { axis: f.axis, from: f.from, to: f.to },
    },
  }));
}

// ── Public: build all events from a diff (pure) ──────────────────────────────

/**
 * Pure event builder. Returns every alert event that should be emitted for
 * a (region, snapshot, diff) triple in stable order: regime shift first,
 * then trigger activations, then corridor breaks, then buffer failures.
 *
 * @param {{id: string, label: string}} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {import('../../shared/regions.types.js').SnapshotDiff} diff
 * @returns {object[]}
 */
export function buildAlertEvents(region, snapshot, diff) {
  if (!region || !snapshot || !diff) return [];
  const events = [];
  if (diff.regime_changed) {
    events.push(buildRegimeShiftEvent(region, snapshot, diff.regime_changed));
  }
  events.push(...buildTriggerActivationEvents(region, snapshot, diff.trigger_activations));
  events.push(...buildCorridorBreakEvents(region, snapshot, diff.corridor_breaks));
  events.push(...buildBufferFailureEvents(region, snapshot, diff.buffer_failures));
  return events;
}

// ── Dedup key derivation (pure, exported for tests) ──────────────────────────

/**
 * FNV-1a-ish 32-bit hash. Matches the `notifySimpleHash` style used in
 * ais-relay.cjs so dedup keys don't collide across emitters.
 *
 * @param {string} str
 * @returns {string}
 */
export function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Build the Upstash dedup key for an event. Exposed so tests can assert the
 * exact key shape without reaching into the default publisher.
 *
 * @param {{eventType: string, payload: {title?: string}}} event
 * @returns {string}
 */
export function buildDedupKey(event) {
  const title = String(event.payload?.title ?? '');
  return `wm:notif:scan-dedup:${event.eventType}:${simpleHash(`${event.eventType}:${title}`)}`;
}

// ── Default Upstash publisher ────────────────────────────────────────────────

async function upstashSetNx(url, token, key, ttlSeconds) {
  // Path-based REST call: /set/{key}/{value}?NX=true&EX={ttl}
  const resp = await fetch(
    `${url}/set/${encodeURIComponent(key)}/1?NX=true&EX=${ttlSeconds}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!resp.ok) return false;
  const json = await resp.json().catch(() => null);
  return json?.result === 'OK';
}

async function upstashLpush(url, token, key, value) {
  const resp = await fetch(
    `${url}/lpush/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!resp.ok) return false;
  const json = await resp.json().catch(() => null);
  return typeof json?.result === 'number';
}

/**
 * Default publisher. Walks the same SET-NX-then-LPUSH path as ais-relay.cjs
 * publishNotificationEvent(). Never throws; returns false on any failure or
 * dedup hit.
 *
 * @param {object} event
 * @returns {Promise<boolean>} true when enqueued, false on dedup or failure
 */
async function defaultPublishEvent(event) {
  try {
    const { url, token } = getRedisCredentials();
    const dedupKey = buildDedupKey(event);
    const isNew = await upstashSetNx(url, token, dedupKey, DEDUP_TTL_SECONDS);
    if (!isNew) {
      const title = String(event.payload?.title ?? '');
      console.log(`[alerts] dedup skip: ${event.eventType} — ${title.slice(0, 60)}`);
      return false;
    }
    const msg = JSON.stringify({ ...event, publishedAt: Date.now() });
    const ok = await upstashLpush(url, token, 'wm:events:queue', msg);
    if (ok) {
      const title = String(event.payload?.title ?? '');
      console.log(`[alerts] queued ${event.severity} ${event.eventType}: ${title.slice(0, 60)}`);
    } else {
      console.warn(`[alerts] LPUSH failed for ${event.eventType}`);
    }
    return ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[alerts] publish failed for ${event?.eventType}: ${msg}`);
    return false;
  }
}

// ── Public: emit alerts for one region snapshot ──────────────────────────────

/**
 * Emit all state-change alerts for one region's newly-persisted snapshot.
 * Ship-on-every-diff, best-effort, never throws. Returns the count of
 * events successfully enqueued and the full list that was considered
 * (so callers can log / telemetry independently of the queue result).
 *
 * @param {{id: string, label: string}} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {import('../../shared/regions.types.js').SnapshotDiff} diff
 * @param {{publishEvent?: (event: object) => Promise<boolean>}} [opts]
 * @returns {Promise<{enqueued: number, events: object[]}>}
 */
export async function emitRegionalAlerts(region, snapshot, diff, opts = {}) {
  if (!region || !snapshot || !diff) return { enqueued: 0, events: [] };
  const events = buildAlertEvents(region, snapshot, diff);
  if (events.length === 0) return { enqueued: 0, events };

  const publisher = opts.publishEvent ?? defaultPublishEvent;
  let enqueued = 0;
  for (const event of events) {
    try {
      const ok = await publisher(event);
      if (ok) enqueued += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[alerts] ${event.eventType} publish threw: ${msg}`);
    }
  }
  return { enqueued, events };
}
