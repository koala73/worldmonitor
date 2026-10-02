/**
 * Notification field validation — the shared boundary for `title`, `source`
 * and `link` on notification events (issue #8397, Sept 2026 pentest).
 *
 * `payload.title`, `payload.source` and `payload.link` reach every delivery
 * channel: the email subject/body (`WorldMonitor Alert: <title>`,
 * `Source: <source>`, bare `<link>`), the chat text for Telegram/Slack/
 * Discord (`formatMessage`), and the web-push click URL. PR #8384 closed only
 * the web-push click path; a hostile event still produced a real email from
 * alerts@worldmonitor.app with a forged subject, a forged
 * `Source: WorldMonitor Security` line, and an off-origin link verbatim.
 *
 * Two entry points consume this module:
 *   - `api/notify.ts` validates user-submitted payloads BEFORE queueing, so
 *     every downstream channel inherits the guarantee.
 *   - `scripts/notification-relay.cjs` `formatMessage` applies the same
 *     shaping as defence in depth, since the relay also emits events that
 *     never pass through `/api/notify` (ais-relay, seed-aviation,
 *     alert-emitter, seed-digest-notifications).
 *
 * Policy (per-field neutralise, never whole-event reject — legitimate RSS
 * headlines carry punctuation, unicode and long-tail publisher domains):
 *   - `title`/`source`: single-line plain text. Control characters and
 *     newlines are stripped (they enable header/body injection in the email
 *     path), compatibility forms are normalized, over-long values are
 *     truncated, and a `source` that impersonates a first-party identity is
 *     replaced with a neutral label.
 *   - Caller-submitted `title`/`description` additionally have clickable URL
 *     tokens redacted. The structured `link` field is the only sanctioned
 *     link channel; without this, a caller moves the phishing URL one field
 *     left into free text, where every mail and chat client autolinks it with
 *     none of the link policy applied (review finding).
 *   - `link`: https-only, no credentials. Dangerous schemes and values that
 *     are not absolute (or root-relative) collapse to the dashboard URL.
 *     Deliverable off-origin https article links are KEPT for text sinks —
 *     they are the point of an rss_alert, and legitimate RSS publishers span
 *     a long tail outside any allowlist — but always rendered with their
 *     destination host disclosed inline, so WorldMonitor branding can never
 *     mask the target. The web-push click target has no room for that inline
 *     disclosure, so caller-submitted events collapse to first-party there.
 *
 * Edge-safe: no Node imports, no JSON imports — `api/notify.ts` bundles with
 * esbuild for Vercel Edge (see scripts/check-edge-function-bundles.mjs).
 */

export const NOTIFY_TITLE_MAX_LENGTH = 200;
export const NOTIFY_SOURCE_MAX_LENGTH = 120;
export const NOTIFY_DESCRIPTION_MAX_LENGTH = 400;
export const NOTIFY_DASHBOARD_URL = 'https://worldmonitor.app/';
export const NOTIFY_COMMUNITY_TITLE_PREFIX = 'Community alert: ';

/**
 * First-party identity markers a `source` value must not impersonate. An
 * attacker-chosen source arriving from the platform's genuine sending
 * identity (alerts@worldmonitor.app) is the phishing primitive on its own —
 * the link is the payload, not the lure — so matching is deliberately broad:
 * case-insensitive substring on a confusable-folded, compacted value.
 */
const FIRST_PARTY_SOURCE_MARKERS = ['worldmonitor', 'wmsecurity'];

/** Neutral label substituted for an impersonating source. */
export const NOTIFY_NEUTRAL_SOURCE = 'Community alert';

/** Replaces a redacted URL token in caller-submitted free text. */
export const NOTIFY_REDACTED_LINK_TOKEN = '[link removed]';

/**
 * Unicode format characters that defeat substring impersonation matching
 * while rendering as nothing in email/chat clients: zero-width characters,
 * bidi controls, soft hyphen, and related Cf values. Stripped BEFORE the
 * first-party marker match (review finding:
 * 'World\u200bMonitor Security' otherwise renders exactly like the forged
 * `Source:` line). Also stripped from titles so lookalike text cannot hide
 * in any rendered channel.
 *
 * Deliberately Cf only. Nonspacing marks (\p{Mn}) are also invisible and are
 * also an impersonation vector, but they carry meaning in Arabic, Hebrew and
 * Indic scripts that NFKC does not precompose — stripping them from delivered
 * text would corrupt legitimate non-Latin headlines. They are folded out of
 * the impersonation identity instead (IMPERSONATION_STRIP_PATTERN).
 */
const INVISIBLE_FORMAT_CHARS_PATTERN = /\p{Cf}+/gu;

/**
 * Strip ASCII control characters (including \r\n), DEL, C1 controls, the
 * common unicode line/paragraph separators, and invisible format characters
 * (zero-width, bidi, soft hyphen), collapsing runs to a single space.
 * Newlines in title/source enable header and body injection in the email
 * path; control and invisible-format characters have no legitimate rendering
 * in any channel.
 */
export function stripNotificationControlChars(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_FORMAT_CHARS_PATTERN, ' ')
    .replace(/[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]+/g, ' ');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Drop a trailing lone high surrogate left behind by a code-unit slice.
 * `String.prototype.slice` cuts UTF-16 code units, so truncating an astral
 * character (emoji, CJK extensions) at an odd offset keeps the high half and
 * drops its low half — the result renders as a replacement glyph and throws
 * in `encodeURIComponent` (review finding, reproduced at all three budgets).
 */
function trimDanglingSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

/**
 * Single-line plain-text shaping shared by title and source: strip control
 * characters, collapse whitespace, truncate to the field budget on a whole
 * code point.
 */
export function sanitizeNotificationText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = collapseWhitespace(stripNotificationControlChars(value));
  if (collapsed.length <= maxLength) return collapsed;
  return trimDanglingSurrogate(collapsed.slice(0, maxLength)).trimEnd();
}

/**
 * Clickable-link shapes in free text: any scheme-bearing URL, a `www.` host,
 * or a bare host with a path. A bare host with no path ('reuters.com') is
 * left alone — it is ordinary publisher attribution, not a click target.
 */
const URL_TOKEN_PATTERN =
  /(?:[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\/\S*)/gi;

/**
 * Redact clickable URL tokens from caller-submitted free text. The structured
 * `link` field is the only sanctioned link channel for a caller; every mail
 * and chat client autolinks a bare URL in a title or snippet, so free text
 * would otherwise bypass the entire link policy (review finding: moving the
 * phishing URL from `link` into `title` defeated the fix).
 */
export function redactNotificationUrlTokens(value: string): string {
  return collapseWhitespace(value.replace(URL_TOKEN_PATTERN, NOTIFY_REDACTED_LINK_TOKEN));
}

/**
 * Characters removed before the first-party marker match. Punctuation,
 * separators and control classes defeat a substring match while rendering as
 * a word break ('World-Monitor Security'); symbols and nonspacing marks do
 * the same ('World+Monitor Security', 'World\u034fMonitor Security'). None
 * carry identity, so all are dropped from the comparison value only — never
 * from the delivered text.
 */
const IMPERSONATION_STRIP_PATTERN = /[\p{P}\p{S}\p{M}\p{Z}\p{C}]+/gu;

/**
 * Visual doubles for the Latin letters that appear in the first-party
 * markers. NFKC folds compatibility forms (fullwidth, mathematical
 * alphanumerics) but NOT cross-script confusables, so 'Wоrldmonitor'
 * (Cyrillic o) renders identically to the genuine brand and passes the raw
 * substring match. Folded into the comparison value only.
 */
const CONFUSABLE_FOLD: Record<string, string> = {
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

function foldConfusables(value: string): string {
  let out = '';
  for (const ch of value) out += CONFUSABLE_FOLD[ch] ?? ch;
  return out;
}

/** True when the source value impersonates a first-party identity. */
export function isImpersonatingSource(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const identity = foldConfusables(collapseWhitespace(stripNotificationControlChars(value)))
    .toLowerCase()
    .replace(IMPERSONATION_STRIP_PATTERN, '');
  if (!identity) return false;
  return FIRST_PARTY_SOURCE_MARKERS.some((marker) => identity.includes(marker));
}

/**
 * Sanitise a notification title. Titles are free-form publisher/RSS text —
 * punctuation and unicode are preserved; only control characters, newlines
 * and over-length values are shaped.
 */
export function sanitizeNotificationTitle(value: unknown): string {
  return sanitizeNotificationText(value, NOTIFY_TITLE_MAX_LENGTH);
}

/**
 * Mark caller-submitted titles as community content, not WorldMonitor copy,
 * and redact clickable URL tokens so free text cannot carry a click target.
 *
 * The prefix is added AFTER truncation, not before: prefixing first spent 17
 * of the 200-character budget and truncated the caller's distinguishing
 * suffix, so two different long alerts could collapse to one title — and the
 * relay's per-user dedup keys on the title, silently suppressing the second
 * for the dedup TTL (review finding).
 */
export function sanitizeCommunityNotificationTitle(value: unknown): string {
  const title = redactNotificationUrlTokens(sanitizeNotificationTitle(value));
  if (!title) return NOTIFY_COMMUNITY_TITLE_PREFIX.trimEnd();
  if (title === NOTIFY_COMMUNITY_TITLE_PREFIX.trimEnd() || title.startsWith(NOTIFY_COMMUNITY_TITLE_PREFIX)) {
    return title;
  }
  return `${NOTIFY_COMMUNITY_TITLE_PREFIX}${title}`;
}

/** Preserve the established 400-character notification snippet budget. */
export function sanitizeNotificationDescription(value: unknown): string {
  return sanitizeNotificationText(value, NOTIFY_DESCRIPTION_MAX_LENGTH);
}

/** Caller-submitted snippets get the same free-text link redaction as titles. */
export function sanitizeUserNotificationDescription(value: unknown): string {
  return redactNotificationUrlTokens(sanitizeNotificationDescription(value));
}

/**
 * Sanitise a notification source. Like the title, plus first-party
 * impersonation is replaced with a neutral server-side label — a
 * server-derived label is safer than an attacker-supplied string next to
 * the platform's own branding.
 */
export function sanitizeNotificationSource(value: unknown): string {
  if (isImpersonatingSource(value)) return NOTIFY_NEUTRAL_SOURCE;
  return sanitizeNotificationText(value, NOTIFY_SOURCE_MAX_LENGTH);
}

/**
 * Caller-submitted source identity.
 *
 * Neutralising EVERY caller source (not just impersonating ones) destroyed
 * real publisher attribution — the platform's own browser RSS forwarder posts
 * through `/api/notify`, so 'Reuters' was delivered as 'Community alert'
 * (review finding). The impersonation check carries the security property
 * here; a non-impersonating publisher name is ordinary attribution and is
 * preserved.
 */
export function sanitizeUserNotificationSource(value: unknown): string {
  return sanitizeNotificationSource(value);
}

export type SanitizedNotificationLink =
  | { kind: 'absent' }
  | { kind: 'dashboard' }
  | { kind: 'article'; url: string; host: string };

/** An absolute (scheme-bearing), protocol-relative, or root-relative value. */
const RESOLVABLE_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

/**
 * Classify a notification link. https-only with no embedded credentials.
 *
 * Returns `absent` for missing/non-string input, `dashboard` for anything
 * that must never be delivered (dangerous scheme, credentials, unparseable,
 * or not a link at all), and `article` for a deliverable https URL with its
 * host for disclosure.
 *
 * A value that is neither absolute nor root-relative is rejected BEFORE the
 * base-relative parse: `new URL(value, base)` almost never throws for free
 * text, so 'not a url' was otherwise resolved into a real-looking first-party
 * URL and classified `article` (review finding).
 */
export function classifyNotificationLink(value: unknown): SanitizedNotificationLink {
  if (value === undefined || value === null || value === '') return { kind: 'absent' };
  if (typeof value !== 'string') return { kind: 'dashboard' };
  if (!RESOLVABLE_LINK_PATTERN.test(value.trim())) return { kind: 'dashboard' };
  let parsed: URL;
  try {
    parsed = new URL(value, NOTIFY_DASHBOARD_URL);
  } catch {
    return { kind: 'dashboard' };
  }
  if (parsed.protocol !== 'https:') return { kind: 'dashboard' };
  // Embedded credentials exist only to make a hostile host read as ours.
  if (parsed.username || parsed.password) return { kind: 'dashboard' };
  const host = parsed.hostname.toLowerCase();
  if (!host) return { kind: 'dashboard' };
  return { kind: 'article', url: parsed.href, host };
}

/** True for the dashboard apex and its owned variant subdomains. */
export function isFirstPartyNotificationHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'worldmonitor.app' || normalized.endsWith('.worldmonitor.app');
}

/**
 * Click target for a caller-submitted event's web push.
 *
 * Push is the one sink with no room to disclose the destination host inline —
 * the OS notification shows only the registering origin — so an off-origin
 * click target reads as first-party with no counter-signal. Caller events
 * therefore keep only first-party links here; text sinks get the real article
 * link with its host disclosed (renderNotificationLinkForText).
 */
export function sanitizeUserNotificationLinkUrl(value: unknown): string {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'absent') return '';
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  return isFirstPartyNotificationHost(classified.host)
    ? classified.url
    : NOTIFY_DASHBOARD_URL;
}

/**
 * Delivery-safe URL for a link: the article URL when deliverable, otherwise
 * the dashboard. Used for the web-push click target of trusted relay events.
 */
export function sanitizeNotificationLinkUrl(value: unknown): string {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'article') return classified.url;
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  return '';
}

/**
 * Render a link for text channels (email body, Telegram/Slack/Discord).
 * Deliverable article links keep their URL with the destination host
 * disclosed inline (`<url> (source: <host>)`), so WorldMonitor branding can
 * never mask the target. Non-deliverable links collapse to the dashboard.
 * Absent links render nothing.
 *
 * Trust-independent: the inline host disclosure IS the control, and it works
 * as well for a caller-submitted article link as for a relay-originated one.
 */
export function renderNotificationLinkForText(value: unknown): string {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'absent') return '';
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  // The disclosure exists to stop first-party branding masking a third-party
  // destination; on a first-party host it is noise.
  if (isFirstPartyNotificationHost(classified.host)) return classified.url;
  return `${classified.url} (source: ${classified.host})`;
}
