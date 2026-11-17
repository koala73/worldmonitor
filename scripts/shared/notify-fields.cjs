'use strict';

/**
 * Notification field validation — CJS mirror of server/_shared/notify-fields.ts.
 *
 * scripts/notification-relay.cjs runs on Railway under scripts/package.json
 * (no TS loader) and Dockerfile.relay COPYs scripts/** explicitly, so the
 * relay cannot import the .ts source. This file is the require()'able copy
 * the relay consumes; the .ts file is the Edge-bundled copy api/notify.ts
 * consumes. The two MUST stay byte-equivalent in behaviour — enforced by
 * tests/notify-fields-parity.test.mjs, which derives the export surface from
 * both modules and runs every vector against both, failing on any divergence.
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

const NOTIFY_REDACTED_LINK_TOKEN = '[link removed]';

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

function trimDanglingSurrogate(value) {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

function sanitizeNotificationText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const collapsed = collapseWhitespace(stripNotificationControlChars(value));
  if (collapsed.length <= maxLength) return collapsed;
  return trimDanglingSurrogate(collapsed.slice(0, maxLength)).trimEnd();
}

const URL_TOKEN_PATTERN =
  /(?:[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\/\S*)/gi;

function redactNotificationUrlTokens(value) {
  return collapseWhitespace(value.replace(URL_TOKEN_PATTERN, NOTIFY_REDACTED_LINK_TOKEN));
}

const IMPERSONATION_STRIP_PATTERN = /[\p{P}\p{S}\p{M}\p{Z}\p{C}]+/gu;

const CONFUSABLE_FOLD = {
  // Cyrillic
  'А': 'A', 'а': 'a', 'В': 'B', 'Е': 'E', 'е': 'e',
  'К': 'K', 'М': 'M', 'м': 'm', 'Н': 'H', 'н': 'n',
  'О': 'O', 'о': 'o', 'Р': 'P', 'р': 'p', 'С': 'C',
  'с': 'c', 'Т': 'T', 'т': 't', 'У': 'Y', 'у': 'y',
  'Х': 'X', 'х': 'x', 'І': 'I', 'і': 'i', 'ї': 'i',
  'Ѕ': 'S', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'Ԝ': 'W',
  'ѡ': 'w',
  // Greek
  'Α': 'A', 'α': 'a', 'Β': 'B', 'Ε': 'E', 'ε': 'e',
  'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'ι': 'i', 'Κ': 'K',
  'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'ο': 'o', 'Ρ': 'P',
  'ρ': 'p', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'σ': 'o',
  // Digit and symbol leetspeak
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't',
  '$': 's', '@': 'a', '!': 'i', '|': 'l',
};

function foldConfusables(value) {
  let out = '';
  for (const ch of value) out += CONFUSABLE_FOLD[ch] ?? ch;
  return out;
}

function isImpersonatingSource(value) {
  if (typeof value !== 'string') return false;
  const identity = foldConfusables(collapseWhitespace(stripNotificationControlChars(value)))
    .toLowerCase()
    .replace(IMPERSONATION_STRIP_PATTERN, '');
  if (!identity) return false;
  return FIRST_PARTY_SOURCE_MARKERS.some((marker) => identity.includes(marker));
}

function sanitizeNotificationTitle(value) {
  return sanitizeNotificationText(value, NOTIFY_TITLE_MAX_LENGTH);
}

function sanitizeCommunityNotificationTitle(value) {
  const title = redactNotificationUrlTokens(sanitizeNotificationTitle(value));
  if (!title) return NOTIFY_COMMUNITY_TITLE_PREFIX.trimEnd();
  if (title === NOTIFY_COMMUNITY_TITLE_PREFIX.trimEnd() || title.startsWith(NOTIFY_COMMUNITY_TITLE_PREFIX)) {
    return title;
  }
  return `${NOTIFY_COMMUNITY_TITLE_PREFIX}${title}`;
}

function sanitizeNotificationDescription(value) {
  return sanitizeNotificationText(value, NOTIFY_DESCRIPTION_MAX_LENGTH);
}

function sanitizeUserNotificationDescription(value) {
  return redactNotificationUrlTokens(sanitizeNotificationDescription(value));
}

function sanitizeNotificationSource(value) {
  if (isImpersonatingSource(value)) return NOTIFY_NEUTRAL_SOURCE;
  return sanitizeNotificationText(value, NOTIFY_SOURCE_MAX_LENGTH);
}

function sanitizeUserNotificationSource(value) {
  return sanitizeNotificationSource(value);
}

const RESOLVABLE_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

function classifyNotificationLink(value) {
  if (value === undefined || value === null || value === '') return { kind: 'absent' };
  if (typeof value !== 'string') return { kind: 'dashboard' };
  if (!RESOLVABLE_LINK_PATTERN.test(value.trim())) return { kind: 'dashboard' };
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

// Referrer tag for an outbound article link in an alert, so a publisher can
// attribute the visit to WorldMonitor: utm_source=worldmonitor,
// utm_medium=alert, utm_campaign=<channel>. Same rule as the brief's
// buildTrackedSourceUrl (server/_shared/brief-render.js): a parameter the link
// already carries is kept as the publisher set it.
//
// Only an off-origin article link is tagged. First-party links, the dashboard
// fallback and anything the classifier rejects come back unchanged. The
// parameters are appended to the classified URL as text, before the fragment:
// the host, path, existing query and fragment are never re-serialised.
//
// The link-suppression matchers remove exactly these tags before comparing
// (scripts/shared/notification-link-suppression.cjs,
// api/notification-suppressions.js, public/link-suppression-check.js), so a
// new channel here must be added to all three.
const NOTIFY_ALERT_UTM_SOURCE = 'worldmonitor';
const NOTIFY_ALERT_UTM_MEDIUM = 'alert';
const NOTIFY_ALERT_CHANNELS = ['email', 'telegram', 'slack', 'discord', 'teams', 'web_push'];

function withAlertReferrer(value, channel) {
  const classified = classifyNotificationLink(value);
  if (classified.kind !== 'article' || isFirstPartyNotificationHost(classified.host)) return value;
  const tags = [
    ['utm_source', NOTIFY_ALERT_UTM_SOURCE],
    ['utm_medium', NOTIFY_ALERT_UTM_MEDIUM],
  ];
  if (NOTIFY_ALERT_CHANNELS.includes(channel)) tags.push(['utm_campaign', channel]);
  const present = new URL(classified.url).searchParams;
  const additions = tags.filter(([key]) => !present.has(key)).map(([key, tag]) => `${key}=${tag}`);
  if (additions.length === 0) return classified.url;
  const hashAt = classified.url.indexOf('#');
  const beforeFragment = hashAt === -1 ? classified.url : classified.url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : classified.url.slice(hashAt);
  const queryAt = beforeFragment.indexOf('?');
  let joiner = '?';
  if (queryAt !== -1) joiner = queryAt === beforeFragment.length - 1 ? '' : '&';
  return `${beforeFragment}${joiner}${additions.join('&')}${fragment}`;
}

function renderNotificationLinkForText(value) {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'absent') return '';
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  if (isFirstPartyNotificationHost(classified.host)) return classified.url;
  return `${classified.url} (source: ${classified.host})`;
}

module.exports = {
  NOTIFY_TITLE_MAX_LENGTH,
  NOTIFY_SOURCE_MAX_LENGTH,
  NOTIFY_DESCRIPTION_MAX_LENGTH,
  NOTIFY_DASHBOARD_URL,
  NOTIFY_COMMUNITY_TITLE_PREFIX,
  NOTIFY_NEUTRAL_SOURCE,
  NOTIFY_REDACTED_LINK_TOKEN,
  NOTIFY_ALERT_UTM_SOURCE,
  NOTIFY_ALERT_UTM_MEDIUM,
  NOTIFY_ALERT_CHANNELS,
  stripNotificationControlChars,
  sanitizeNotificationText,
  redactNotificationUrlTokens,
  URL_TOKEN_PATTERN,
  isImpersonatingSource,
  sanitizeNotificationTitle,
  sanitizeCommunityNotificationTitle,
  sanitizeNotificationDescription,
  sanitizeUserNotificationDescription,
  sanitizeNotificationSource,
  sanitizeUserNotificationSource,
  classifyNotificationLink,
  isFirstPartyNotificationHost,
  sanitizeUserNotificationLinkUrl,
  sanitizeNotificationLinkUrl,
  withAlertReferrer,
  renderNotificationLinkForText,
};
