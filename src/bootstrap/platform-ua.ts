/**
 * Client-side platform detection for `beforeSend` filters.
 *
 * `event.contexts.os` is NOT available inside `beforeSend`. @sentry/browser 10.x
 * populates neither `contexts.os` nor `contexts.browser` — Sentry's ingest pipeline
 * derives both from the User-Agent header AFTER the event leaves the browser. Two
 * platform-gated filters read `event.contexts.os.name` anyway, so they compared
 * `''` against `/^(iOS|iPadOS)$/` and could never fire: WORLDMONITOR-WK kept
 * reporting across seven post-fix build SHAs (44 events, 100% iOS, all zero-frame
 * RangeErrors that the gate was written to drop). Their unit tests passed only
 * because the fixtures fabricated `contexts: { os: { name: 'iOS' } }` — a field
 * production never supplies.
 *
 * Sniff the User-Agent directly instead: it is the same string Sentry's backend
 * parses, and it is available synchronously in `beforeSend`.
 */

/**
 * True for iOS/iPadOS. `ua` is `navigator.userAgent`; `maxTouchPoints` is
 * `navigator.maxTouchPoints`.
 *
 * iPhone/iPad/iPod appear verbatim in every mobile-mode iOS UA, including in-app
 * WebViews (Google app, Chrome iOS, Facebook). iPadOS 13+ in desktop mode reports a
 * `Macintosh` UA instead, which is only separable from a real Mac by touch support —
 * genuine macOS reports `maxTouchPoints === 0`.
 *
 * Kept deliberately narrow: these filters SUPPRESS events, so a false negative just
 * lets an event through (safe) while a false positive would hide a real desktop
 * regression.
 */
export function isIosLikeUserAgent(ua: string, maxTouchPoints = 0): boolean {
  if (!ua) return false;
  if (/(iPhone|iPad|iPod)/.test(ua)) return true;
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}
