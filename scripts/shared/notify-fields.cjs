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
const NOTIFY_DESCRIPTION_MAX_LENGTH = 400;
const NOTIFY_DASHBOARD_URL = 'https://worldmonitor.app/';
const NOTIFY_COMMUNITY_TITLE_PREFIX = 'Community alert: ';

const FIRST_PARTY_SOURCE_MARKERS = ['worldmonitor', 'wmsecurity'];

const NOTIFY_NEUTRAL_SOURCE = 'Community alert';

const INVISIBLE_FORMAT_CHARS_PATTERN = /\p{Cf}+/gu;

function stripNotificationControlChars(value) {
  return value
    .normalize('NFKC')
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
  const identity = collapseWhitespace(stripNotificationControlChars(value))
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\p{C}]+/gu, '');
  if (!identity) return false;
  return FIRST_PARTY_SOURCE_MARKERS.some((marker) => identity.includes(marker));
}

function sanitizeNotificationTitle(value) {
  return sanitizeNotificationText(value, NOTIFY_TITLE_MAX_LENGTH);
}

function sanitizeCommunityNotificationTitle(value) {
  const title = sanitizeNotificationTitle(value);
  if (!title) return NOTIFY_COMMUNITY_TITLE_PREFIX.trimEnd();
  if (title === NOTIFY_COMMUNITY_TITLE_PREFIX.trimEnd() || title.startsWith(NOTIFY_COMMUNITY_TITLE_PREFIX)) {
    return title;
  }
  return sanitizeNotificationTitle(`${NOTIFY_COMMUNITY_TITLE_PREFIX}${title}`);
}

function sanitizeNotificationDescription(value) {
  return sanitizeNotificationText(value, NOTIFY_DESCRIPTION_MAX_LENGTH);
}

function sanitizeNotificationSource(value) {
  if (isImpersonatingSource(value)) return NOTIFY_NEUTRAL_SOURCE;
  return sanitizeNotificationText(value, NOTIFY_SOURCE_MAX_LENGTH);
}

function sanitizeUserNotificationSource(value) {
  return sanitizeNotificationSource(value) ? NOTIFY_NEUTRAL_SOURCE : '';
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

function isFirstPartyNotificationHost(host) {
  const normalized = host.toLowerCase();
  return normalized === 'worldmonitor.app' || normalized.endsWith('.worldmonitor.app');
}

function sanitizeUserNotificationLinkUrl(value) {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'absent') return '';
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  return isFirstPartyNotificationHost(classified.host)
    ? classified.url
    : NOTIFY_DASHBOARD_URL;
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
  NOTIFY_DESCRIPTION_MAX_LENGTH,
  NOTIFY_DASHBOARD_URL,
  NOTIFY_COMMUNITY_TITLE_PREFIX,
  NOTIFY_NEUTRAL_SOURCE,
  stripNotificationControlChars,
  sanitizeNotificationText,
  isImpersonatingSource,
  sanitizeNotificationTitle,
  sanitizeCommunityNotificationTitle,
  sanitizeNotificationDescription,
  sanitizeNotificationSource,
  sanitizeUserNotificationSource,
  classifyNotificationLink,
  isFirstPartyNotificationHost,
  sanitizeUserNotificationLinkUrl,
  sanitizeNotificationLinkUrl,
  renderNotificationLinkForText,
};
