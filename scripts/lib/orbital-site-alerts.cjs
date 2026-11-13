'use strict';

/**
 * @notification-source: domain
 *   payload.title is built from structured watched-site records (site name,
 *   satellite name, pass time). Not RSS-origin; MUST NOT set payload.description.
 *   Enforced by tests/notification-relay-payload-audit.test.mjs.
 */

// Publishes two opt-in, site-scoped alerts after each watched-site seed run:
// `orbital_imaging_window` when an open optical or radar satellite will image a
// watched site within the lead horizon, and `orbital_site_change` when a site's
// change flag moves to confirmed. scripts/notification-relay.cjs matches each
// event to the rules that list its site.

const IMAGING_WINDOW_EVENT_TYPE = 'orbital_imaging_window';
const SITE_CHANGE_EVENT_TYPE = 'orbital_site_change';
const ORBITAL_SITE_EVENT_TYPES = Object.freeze([IMAGING_WINDOW_EVENT_TYPE, SITE_CHANGE_EVENT_TYPE]);

// Only open archives publish the image a window produces.
const OPEN_IMAGING_CATEGORIES = new Set(['open-optical', 'open-radar']);
const WINDOW_LEAD_MS = 24 * 60 * 60 * 1000;
const WINDOW_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// A confirmation older than this is history, not news: it never pages, so a
// site first seen by the producer does not alert on its past.
const CHANGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WINDOWS_PER_EVENT = 5;
const STATE_KEY = 'notify:orbital-site:state:v1';
const STATE_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

const windowKey = (window) => `${window.noradId}@${window.time}`;

function openWindowsAhead(record, nowMs) {
  const windows = Array.isArray(record?.nextWindows) ? record.nextWindows : [];
  return windows.filter((window) => {
    const timeMs = Date.parse(window?.time);
    return OPEN_IMAGING_CATEGORIES.has(window?.category) && timeMs >= nowMs && timeMs - nowMs <= WINDOW_LEAD_MS;
  });
}

function latestConfirmation(flag) {
  const events = Array.isArray(flag?.events) ? flag.events : [];
  let latest = null;
  for (const event of events) {
    if (event?.kind !== 'confirmed' || typeof event.datetime !== 'string') continue;
    if (!latest || event.datetime > latest.datetime) latest = event;
  }
  return latest;
}

/**
 * One site's imaging-window edge. A window alerts once, when it first enters the
 * lead horizon; every new window of one run coalesces into one event. A pending
 * event is republished with its own coalesceKey until it is queued.
 */
function advanceWindows(previous, record, nowMs) {
  const seen = (previous?.seen ?? []).filter((key) => Date.parse(key.slice(key.indexOf('@') + 1)) >= nowMs);
  // A pending event keeps only passes still ahead; once all have ended, this refresh's windows replace it.
  const stillAhead = (previous?.pending?.windows ?? []).filter((window) => Date.parse(window.time) >= nowMs);
  if (stillAhead.length > 0) {
    const pending = { ...previous.pending, windows: stillAhead };
    return { next: { ...previous, seen, pending }, owed: pending };
  }
  const fresh = openWindowsAhead(record, nowMs).filter((window) => !seen.includes(windowKey(window)));
  const { pending: _expired, ...kept } = previous ?? {};
  const base = previous ? { ...kept, seen } : null;
  if (fresh.length === 0) return { next: base, owed: null };
  if (Number.isFinite(previous?.firedAt) && nowMs - previous.firedAt < WINDOW_COOLDOWN_MS) return { next: base, owed: null };
  const windows = fresh.slice(0, MAX_WINDOWS_PER_EVENT).map((window) => ({
    noradId: window.noradId, name: window.name, profileId: window.profileId, category: window.category, time: window.time,
  }));
  const pending = { coalesceKey: `${IMAGING_WINDOW_EVENT_TYPE}:${record.siteId}:${windows[0].time}`, windows };
  return { next: { ...base, seen: [...seen, ...fresh.map(windowKey)], pending }, owed: pending };
}

/** One site's confirmed-change edge: the newest confirmation the producer has not yet answered. */
function advanceChange(previous, record, nowMs) {
  if (previous?.pending) return { next: previous, owed: previous.pending };
  const confirmation = latestConfirmation(record?.flag);
  if (!confirmation || (previous?.datetime && confirmation.datetime <= previous.datetime)) return { next: previous, owed: null };
  const answered = { ...previous, datetime: confirmation.datetime, itemId: confirmation.itemId };
  const ageMs = nowMs - Date.parse(confirmation.datetime);
  const cooling = Number.isFinite(previous?.firedAt) && nowMs - previous.firedAt < CHANGE_COOLDOWN_MS;
  if (!(ageMs <= CHANGE_MAX_AGE_MS) || cooling) return { next: answered, owed: null };
  const pending = {
    coalesceKey: `${SITE_CHANGE_EVENT_TYPE}:${record.siteId}:${confirmation.itemId}`,
    itemId: confirmation.itemId,
    datetime: confirmation.datetime,
    platform: confirmation.platform ?? null,
  };
  return { next: { ...answered, pending }, owed: pending };
}

const siteName = (record) => (typeof record.name === 'string' && record.name ? record.name : record.siteId);

function buildImagingWindowEvent(record, pending) {
  const first = pending.windows[0];
  const more = pending.windows.length > 1 ? ` (+${pending.windows.length - 1} more)` : '';
  return {
    eventType: IMAGING_WINDOW_EVENT_TYPE,
    // Realtime rules deliver critical events only; the per-site opt-in is the filter.
    severity: 'critical',
    cooldownSeconds: DEDUP_TTL_SECONDS,
    payload: {
      title: `${siteName(record)}: ${first.name} imaging window at ${first.time}${more}`,
      // Not a first-party name: sanitizeNotificationSource rewrites those to "Community alert".
      source: 'Orbital Watch',
      siteId: record.siteId,
      siteName: siteName(record),
      windows: pending.windows,
      triggeredAt: first.time,
      coalesceKey: pending.coalesceKey,
    },
  };
}

function buildSiteChangeEvent(record, pending) {
  return {
    eventType: SITE_CHANGE_EVENT_TYPE,
    severity: 'critical',
    cooldownSeconds: DEDUP_TTL_SECONDS,
    payload: {
      title: `${siteName(record)}: radar imagery statistics changed (confirmed)`,
      source: 'Orbital Watch',
      siteId: record.siteId,
      siteName: siteName(record),
      itemId: pending.itemId,
      platform: pending.platform,
      triggeredAt: pending.datetime,
      coalesceKey: pending.coalesceKey,
    },
  };
}

const EDGES = [
  { slot: 'window', advance: advanceWindows, build: buildImagingWindowEvent },
  { slot: 'change', advance: advanceChange, build: buildSiteChangeEvent },
];

/**
 * Advances every published site record. `shadow` true (change scoring in its shadow
 * period) suppresses change alerts entirely, whatever flag a record carries. Owed
 * events are persisted as pending before any publish, so a lost write after a
 * publish cannot mint a second coalesceKey; each is marked fired once `publish`
 * resolves true (queued or already queued). Returns a summary, or null when the
 * state could not be read or the pending write failed (nothing is published then).
 */
async function publishOrbitalSiteAlerts(records, { shadow, now, readState, writeState, publish }) {
  const list = Array.isArray(records) ? records.filter((record) => typeof record?.siteId === 'string' && record.siteId) : [];
  if (list.length === 0) return { published: 0, failed: 0, stateWritten: false };
  if (typeof shadow !== 'boolean') throw new TypeError('publishOrbitalSiteAlerts needs an explicit shadow switch');

  let readFailed = false;
  const stored = await readState(STATE_KEY, () => { readFailed = true; });
  if (readFailed) return null;
  const state = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};

  const nowMs = now();
  const owed = [];
  for (const record of list) {
    const site = { ...state[record.siteId] };
    for (const edge of EDGES) {
      if (edge.slot === 'change' && shadow) continue;
      const { next, owed: pending } = edge.advance(site[edge.slot], record, nowMs);
      if (next) site[edge.slot] = next;
      if (pending) owed.push({ record, edge, pending });
    }
    if (Object.keys(site).length) state[record.siteId] = site;
  }
  if (owed.length && (await writeState(STATE_KEY, state, STATE_TTL_SECONDS)) === false) return null;

  let published = 0;
  let failed = 0;
  for (const { record, edge, pending } of owed) {
    if (await publish(edge.build(record, pending))) {
      const { pending: _sent, ...rest } = state[record.siteId][edge.slot];
      state[record.siteId] = { ...state[record.siteId], [edge.slot]: { ...rest, firedAt: nowMs } };
      published += 1;
    } else {
      failed += 1;
    }
  }
  const stateWritten = (await writeState(STATE_KEY, state, STATE_TTL_SECONDS)) !== false;
  return { published, failed, stateWritten };
}

module.exports = {
  IMAGING_WINDOW_EVENT_TYPE,
  SITE_CHANGE_EVENT_TYPE,
  ORBITAL_SITE_EVENT_TYPES,
  OPEN_IMAGING_CATEGORIES,
  WINDOW_LEAD_MS,
  WINDOW_COOLDOWN_MS,
  CHANGE_COOLDOWN_MS,
  CHANGE_MAX_AGE_MS,
  STATE_KEY,
  DEDUP_TTL_SECONDS,
  publishOrbitalSiteAlerts,
};
