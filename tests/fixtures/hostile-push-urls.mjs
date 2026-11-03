// Hostile push click-URL corpus, shared by the relay and service-worker suites.
//
// Push payload URLs come from `event.payload.link` — published verbatim by a Pro
// account through /api/notify, or ingested verbatim from an external RSS feed —
// so every entry here is attacker-supplied input, not a synthetic edge case.
//
// This list is shared rather than hand-copied because the two guards must agree
// on what counts as hostile. Previously each suite kept its own copy, so adding
// a banned scheme to one silently left the other unguarded. The repo already
// takes this position for the same problem in src/services/external-navigation.ts,
// where one predicate is exported specifically so a second call site gates on
// the SAME rule.
//
// Data only, deliberately: the two guards legitimately differ in what they
// RETURN for these (the relay substitutes a dashboard path; the worker collapses
// to '/'), so expectations live with each suite. What is shared is the corpus.

/** Schemes and shapes that must never become a navigation on either side. */
export const HOSTILE_SCHEMES = [
  { raw: 'javascript:alert(1)', why: 'script execution' },
  { raw: 'data:text/html,<script>1</script>', why: 'inline document' },
  { raw: 'http://example.com/', why: 'downgrade from the https dashboard' },
  { raw: 'https://worldmonitor.app@example.com/', why: 'credentials make a hostile host read as ours' },
];

/**
 * First-party BY HOST, but the pathname begins `//` — so detaching the path from
 * its origin yields a protocol-relative reference that resolves off-origin.
 *
 * These are the laundering vectors: the URL reads as ours in a stored payload or
 * a log, and becomes https://evil.com/ the moment either half normalizes it.
 * Both spellings arrive as the same `//evil.com` pathname, because WHATWG
 * normalizes `\` to `/` in a special scheme. The guards re-resolve and compare
 * origins rather than testing the string's shape, so they are robust to any
 * authority-shaped pathname the parser can produce.
 */
export const FIRST_PARTY_PATH_LAUNDERING = [
  { raw: 'https://worldmonitor.app//evil.com', why: 'double-slash pathname' },
  { raw: 'https://worldmonitor.app/\\evil.com', why: 'backslash normalizes to the same authority' },
];

/**
 * First-party by host AND authority-shaped in a way that survives the origin
 * round-trip: '//www.worldmonitor.app/x' resolves back to us, so it is not
 * hostile — but returning it unresolved pins the click to www even when the
 * worker runs on a vertical, re-admitting the origin coupling.
 */
export const FIRST_PARTY_AUTHORITY_SHAPED = [
  { raw: 'https://worldmonitor.app//www.worldmonitor.app/x', expectedPath: '/x', why: 'authority-shaped but first-party' },
];

/** Inputs that make `new URL()` itself throw, even with a base supplied. */
export const UNPARSEABLE = [
  { raw: 'http://[::1', why: 'unterminated IPv6 literal' },
  { raw: 'http://exa mple.com', why: 'space in authority' },
];

/** Schemes whose parsed origin equals ours, so an origin-first check lets them through. */
export const ORIGIN_SPOOFING_SCHEMES = [
  { raw: 'blob:https://www.worldmonitor.app/8e7-uuid', why: 'URL.origin returns the inner origin' },
  { raw: 'blob:https://worldmonitor.app/8e7-uuid', why: 'same, on the apex' },
];

/** Hosts that merely LOOK first-party. Exact-equality host checks reject them; substring checks do not. */
export const LOOKALIKE_HOSTS = [
  { raw: 'https://worldmonitor.app.evil.com/dashboard', why: 'suffix-style lookalike' },
  { raw: 'https://wwwworldmonitor.app/dashboard', why: 'missing separator' },
];

/** Everything above, for suites that assert a single property across the whole corpus. */
export const ALL_HOSTILE = [
  ...HOSTILE_SCHEMES,
  ...FIRST_PARTY_PATH_LAUNDERING,
  ...UNPARSEABLE,
  ...ORIGIN_SPOOFING_SCHEMES,
  ...LOOKALIKE_HOSTS,
];

/** Convenience: just the raw strings. */
export const rawsOf = (entries) => entries.map((e) => e.raw);
