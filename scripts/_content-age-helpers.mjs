#!/usr/bin/env node
//
// Shared content-age helpers for time-series seeders.
//
// runSeed's `contentMeta` contract (see scripts/_seed-utils.mjs) asks a seeder
// to report {newestItemAt, oldestItemAt} epoch-ms for the data it just fetched
// so /api/health can fire STALE_CONTENT when an upstream FREEZES — i.e. keeps
// returning HTTP 200 with the same observations indefinitely.
//
// Seeder LIVENESS (seed-meta.fetchedAt vs maxStaleMin) does NOT catch a freeze:
// the cron runs fine, the fetch succeeds, validate() passes, recordCount > 0 —
// only the observation DATES reveal it. This was issue #3845: ECB's legacy
// CISS series (SS_CI) stopped publishing in May 2025 and the FSI panel served
// a 12-month-old value for a year because no layer inspected the date of the
// newest observation. Content-age is the only signal that does.
//
// `tokensToContentMeta` accepts the date/period strings a seeder already has
// in its payload — daily ISO dates, SDMX monthly/quarterly/annual period
// tokens — and reduces them to the {newestItemAt, oldestItemAt} shape. It
// returns null when nothing parses to a finite, non-future timestamp; runSeed
// reads null as STALE_CONTENT (the upstream handed us nothing datable).

// 1h — matches the clock-skew tolerance in _imf-weo-content-age-helpers.mjs.
const CLOCK_SKEW_TOLERANCE_MS = 60 * 60 * 1000;

/** Minutes in a day — convenience for declaring maxContentAgeMin budgets. */
export const DAY_MIN = 24 * 60;

/**
 * Parse one date/period token to epoch ms.
 *   YYYY-MM-DD / full ISO datetime → that instant (date-only ⇒ UTC midnight)
 *   YYYY-MM   → first ms of that month
 *   YYYY-Qn   → first ms of that quarter
 *   YYYY      → first ms of that year
 *
 * Sub-day granularities resolve to the period START, never the end, so the
 * current month/quarter is never future-dated — an end-of-period mapping
 * would push the latest period past `now` and the skew filter would wrongly
 * drop genuinely-fresh data. Budgets (maxContentAgeMin) are sized against the
 * start-of-period convention by each caller.
 *
 * @param {unknown} token
 * @returns {number|null} epoch ms, or null when unparseable.
 */
export function periodTokenToMs(token) {
  if (typeof token !== 'string' || token === '') return null;
  let m;
  // Bare ISO date (YYYY-MM-DD) or full ISO datetime (…-DDT…). The (?:T|$)
  // anchor rejects trailing garbage like `2026-05-18xyz` explicitly rather
  // than relying on a downstream Date.parse → NaN.
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(token)) {
    const ts = Date.parse(token.length === 10 ? `${token}T00:00:00Z` : token);
    return Number.isFinite(ts) ? ts : null;
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(token))) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return Date.UTC(Number(m[1]), mo - 1, 1);
  }
  if ((m = /^(\d{4})-Q([1-4])$/.exec(token))) {
    return Date.UTC(Number(m[1]), (Number(m[2]) - 1) * 3, 1);
  }
  if ((m = /^(\d{4})$/.exec(token))) {
    return Date.UTC(Number(m[1]), 0, 1);
  }
  return null;
}

/**
 * Reduce a list of date/period tokens to runSeed's contentMeta shape.
 *
 * Tokens that are unparseable, non-finite, non-positive, or dated more than
 * CLOCK_SKEW_TOLERANCE_MS in the future are skipped. When NONE survive, the
 * return is null so the health classifier reports STALE_CONTENT.
 *
 * @param {Array<unknown>|unknown} tokens  one token or a list of them.
 * @param {number} [nowMs]                 injectable clock for deterministic tests.
 * @returns {{newestItemAt:number, oldestItemAt:number}|null}
 */
export function tokensToContentMeta(tokens, nowMs = Date.now()) {
  const skewLimit = nowMs + CLOCK_SKEW_TOLERANCE_MS;
  const list = Array.isArray(tokens) ? tokens : [tokens];
  let newest = -Infinity;
  let oldest = Infinity;
  let valid = 0;
  for (const token of list) {
    const ts = periodTokenToMs(token);
    if (ts == null || !Number.isFinite(ts) || ts <= 0 || ts > skewLimit) continue;
    valid++;
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  return valid === 0 ? null : { newestItemAt: newest, oldestItemAt: oldest };
}
