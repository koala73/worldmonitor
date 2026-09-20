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
 *     path), over-long values are truncated, and a `source` that impersonates
 *     a first-party identity is replaced with a neutral label.
 *   - `link`: https-only, no credentials — the same scheme/credential
 *     discipline PR #8384's `safePushClickUrl` enforces for web push, so the
 *     two sinks cannot drift. Dangerous schemes collapse to the dashboard
 *     URL. Reachable off-origin https article links are KEPT (they are the
 *     point of an rss_alert, and legitimate RSS publishers span a long tail
 *     outside any allowlist) but rendered with their destination host
 *     disclosed inline, so WorldMonitor branding can never mask the target.
 *
 * Edge-safe: no Node imports, no JSON imports — `api/notify.ts` bundles with
 * esbuild for Vercel Edge (see scripts/check-edge-function-bundles.mjs).
 */

export const NOTIFY_TITLE_MAX_LENGTH = 200;
export const NOTIFY_SOURCE_MAX_LENGTH = 120;
export const NOTIFY_DASHBOARD_URL = 'https://worldmonitor.app/';

/**
 * First-party identity markers a `source` value must not impersonate. An
 * attacker-chosen source arriving from the platform's genuine sending
 * identity (alerts@worldmonitor.app) is the phishing primitive on its own —
 * the link is the payload, not the lure — so matching is deliberately broad:
 * case-insensitive substring on the compacted value.
 */
const FIRST_PARTY_SOURCE_MARKERS = ['worldmonitor', 'world monitor', 'wm security'];

/** Neutral label substituted for an impersonating or empty source. */
export const NOTIFY_NEUTRAL_SOURCE = 'Community alert';

/**
 * Strip ASCII control characters (including \r\n), DEL, and the common
 * unicode line/paragraph separators, collapsing runs to a single space.
 * Newlines in title/source enable header and body injection in the email
 * path; control characters have no legitimate rendering in any channel.
 */
export function stripNotificationControlChars(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]+/g, ' ');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Single-line plain-text shaping shared by title and source: strip control
 * characters, collapse whitespace, truncate to the field budget.
 */
export function sanitizeNotificationText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = collapseWhitespace(stripNotificationControlChars(value));
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength).trimEnd() : collapsed;
}

/** True when the source value impersonates a first-party identity. */
export function isImpersonatingSource(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const compacted = collapseWhitespace(stripNotificationControlChars(value)).toLowerCase();
  if (!compacted) return false;
  return FIRST_PARTY_SOURCE_MARKERS.some((marker) => compacted.includes(marker));
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
 * Sanitise a notification source. Like the title, plus first-party
 * impersonation is replaced with a neutral server-side label — a
 * server-derived label is safer than an attacker-supplied string next to
 * the platform's own branding.
 */
export function sanitizeNotificationSource(value: unknown): string {
  if (isImpersonatingSource(value)) return NOTIFY_NEUTRAL_SOURCE;
  return sanitizeNotificationText(value, NOTIFY_SOURCE_MAX_LENGTH);
}

export type SanitizedNotificationLink =
  | { kind: 'absent' }
  | { kind: 'dashboard' }
  | { kind: 'article'; url: string; host: string };

/**
 * Classify a notification link. https-only with no embedded credentials —
 * the same scheme/credential discipline PR #8384's `safePushClickUrl`
 * enforces for the web-push click URL, so the email/chat sinks and the push
 * sink cannot drift apart.
 *
 * Returns `absent` for missing/non-string input, `dashboard` for anything
 * that must never be delivered (dangerous scheme, credentials, unparseable),
 * and `article` for a deliverable https URL with its host for disclosure.
 */
export function classifyNotificationLink(value: unknown): SanitizedNotificationLink {
  if (value === undefined || value === null || value === '') return { kind: 'absent' };
  if (typeof value !== 'string') return { kind: 'dashboard' };
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

/**
 * Delivery-safe URL for a link: the article URL when deliverable, otherwise
 * the dashboard. Matches `safePushClickUrl` semantics for the values both
 * accept; relative inputs resolve against the dashboard origin in both.
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
 */
export function renderNotificationLinkForText(value: unknown): string {
  const classified = classifyNotificationLink(value);
  if (classified.kind === 'absent') return '';
  if (classified.kind === 'dashboard') return NOTIFY_DASHBOARD_URL;
  return `${classified.url} (source: ${classified.host})`;
}
