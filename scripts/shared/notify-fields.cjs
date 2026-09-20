'use strict';

/**
 * Notification field validation — CJS mirror of server/_shared/notify-fields.ts.
 *
 * scripts/notification-relay.cjs runs on Railway under scripts/package.json
 * (no TS loader) and Dockerfile.relay COPYs scripts/** explicitly, so the
 * relay cannot import the .ts source. This file is the require()'able copy
 * the relay consumes; the .ts file is the Edge-bundled copy api/notify.ts
 * consumes. The two MUST stay byte-equivalent in behaviour — enforced by
 * tests/notify-fields-parity.test.mjs, which runs every vector against both
 * modules and fails on any divergence.
 *
 * DO NOT edit behaviour here without mirroring it in
 * server/_shared/notify-fields.ts (and vice versa).
 */

const NOTIFY_TITLE_MAX_LENGTH = 200;
const NOTIFY_SOURCE_MAX_LENGTH = 120;
const NOTIFY_DASHBOARD_URL = 'https://worldmonitor.app/';

const FIRST_PARTY_SOURCE_MARKERS = ['worldmonitor', 'world monitor', 'wm security'];

const NOTIFY_NEUTRAL_SOURCE = 'Community alert';

const INVISIBLE_FORMAT_CHARS_PATTERN = /[\u200B-\u200F\u202A-\u202E\u00AD\u180E]+/g;

function stripNotificationControlChars(value) {
  return value
    .replace(INVISIBLE_FORMAT_CHARS_PATTERN, ' ')
    .replace(/[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]+/g, ' ');
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeNotificationText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const collapsed = collapseWhitespace(stripNotificationControlChars(value));
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength).trimEnd() : collapsed;
}

function isImpersonatingSource(value) {
  if (typeof value !== 'string') return false;
  const compacted = collapseWhitespace(stripNotificationControlChars(value)).toLowerCase();
  if (!compacted) return false;
  return FIRST_PARTY_SOURCE_MARKERS.some((marker) => compacted.includes(marker));
}

function sanitizeNotificationTitle(value) {
  return sanitizeNotificationText(value, NOTIFY_TITLE_MAX_LENGTH);
}

function sanitizeNotificationSource(value) {
  if (isImpersonatingSource(value)) return NOTIFY_NEUTRAL_SOURCE;
  return sanitizeNotificationText(value, NOTIFY_SOURCE_MAX_LENGTH);
}

function classifyNotificationLink(value) {
  if (value === undefined || value === null || value === '') return { kind: 'absent' };
  if (typeof value !== 'string') return { kind: 'dashboard' };
  let parsed;
  try {
    parsed = new URL(value, NOTIFY_DASHBOARD_URL);
  } catch {
    return { kind: 'dashboard' };
  }
  if (parsed.protocol !== 'https:') return { kind: 'dashboard' };
  if (parsed.username || parsed.password) return { kind: 'dashboard' };
  const host = parsed.hostname.toLowerCase();
  if (!host) return { kind: 'dashboard' };
  return { kind: 'article', url: parsed.href, host };
}

function sanitizeNotificationLinkUrl(value) {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'article') return classified.url;
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  return '';
}

function renderNotificationLinkForText(value) {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'absent') return '';
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  return `${classified.url} (source: ${classified.host})`;
}

module.exports = {
  NOTIFY_TITLE_MAX_LENGTH,
  NOTIFY_SOURCE_MAX_LENGTH,
  NOTIFY_DASHBOARD_URL,
  NOTIFY_NEUTRAL_SOURCE,
  stripNotificationControlChars,
  sanitizeNotificationText,
  isImpersonatingSource,
  sanitizeNotificationTitle,
  sanitizeNotificationSource,
  classifyNotificationLink,
  sanitizeNotificationLinkUrl,
  renderNotificationLinkForText,
};
