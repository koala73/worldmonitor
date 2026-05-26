// Pure parser for the DIGEST_ONLY_USER env flag. Lives here (not inline
// in seed-digest-notifications.mjs) because the seed script has no
// isMain guard — importing it executes main() + env-assert exits. This
// module is pure and test-friendly.

// Hard cap: an operator cannot set an expiry more than 48h in the future.
// Prevents "forever test" misconfig even if the format is otherwise valid.
// 48h covers every realistic same-day + next-day validation window.
export const DIGEST_ONLY_USER_MAX_HORIZON_MS = 48 * 60 * 60 * 1000;

/**
 * Parse the DIGEST_ONLY_USER env value.
 *
 * The value MUST be in the form `<userId>|until=<ISO8601>` where the
 * expiry is in the future and within the 48h horizon. Legacy bare-
 * userId format is REJECTED to prevent sticky test flags from producing
 * silent partial outages indefinitely if the operator forgets to unset.
 *
 * @param {string} raw - The trimmed env var value. Pass '' for unset.
 * @param {number} nowMs - Current ms (injected for deterministic tests).
 * @returns {{ kind: 'active', userId: string, untilMs: number }
 *   | { kind: 'reject', reason: string }
 *   | { kind: 'unset' }}
 */
export function parseDigestOnlyUser(raw, nowMs) {
  if (typeof raw !== 'string' || raw.length === 0) return { kind: 'unset' };

  const parts = raw.split('|');
  if (parts.length !== 2) {
    // Distinguish "no separator" from "too many" so the operator's
    // next action is clear. Without this, a double-`|until=` typo got
    // told "missing suffix" even though a suffix was present — the
    // operator's instinct would be to add a second suffix, looping.
    return {
      kind: 'reject',
      reason:
        parts.length === 1
          ? 'missing mandatory "|until=<ISO8601>" suffix'
          : `expected exactly one "|" separator, got ${parts.length - 1}`,
    };
  }
  const userId = parts[0].trim();
  const suffix = parts[1].trim();
  if (!userId) return { kind: 'reject', reason: 'empty userId before "|"' };
  if (!suffix.startsWith('until=')) {
    return {
      kind: 'reject',
      reason: `suffix must be "until=<ISO8601>" (got "${suffix}")`,
    };
  }
  const untilRaw = suffix.slice('until='.length).trim();
  // `Date.parse` is intentionally lenient in V8 (accepts RFC 2822,
  // locale-formatted dates, etc.). The documented contract is strict
  // ISO 8601 — gate with a rough regex so non-ISO values are rejected
  // by shape, not just by the 48h cap catching a random valid date.
  // Accept YYYY-MM-DD with optional time / fractional / timezone.
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+\-]\d{2}:?\d{2})?)?$/.test(untilRaw)) {
    return {
      kind: 'reject',
      reason: `expiry "${untilRaw}" is not a parseable ISO8601 timestamp`,
    };
  }
  const untilMs = Date.parse(untilRaw);
  if (!Number.isFinite(untilMs)) {
    return {
      kind: 'reject',
      reason: `expiry "${untilRaw}" is not a parseable ISO8601 timestamp`,
    };
  }
  if (untilMs <= nowMs) {
    return {
      kind: 'reject',
      reason: `expiry ${new Date(untilMs).toISOString()} is in the past (now=${new Date(nowMs).toISOString()}) — auto-disabled`,
    };
  }
  if (untilMs > nowMs + DIGEST_ONLY_USER_MAX_HORIZON_MS) {
    return {
      kind: 'reject',
      reason: `expiry ${new Date(untilMs).toISOString()} exceeds the 48h hard cap — set a closer expiry`,
    };
  }
  return { kind: 'active', userId, untilMs };
}
