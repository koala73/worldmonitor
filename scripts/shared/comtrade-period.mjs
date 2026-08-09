// Shared UN Comtrade annual-period helpers. Single source of truth imported by:
//   - scripts/seed-trade-flows.mjs                              (strategic commodity flows)
//   - scripts/seed-comtrade-bilateral-hs4.mjs                   (bulk per-country seeder)
//   - server/worldmonitor/supply-chain/v1/_bilateral-hs4-lazy.ts (on-demand fallback)
//
// Before PR #5641's review these three carried three byte-identical copies of
// recentPeriod(). The copies mattered: seed-trade-flows.mjs already had a
// year-boundary fallback the other two silently lacked, so a fix landing in
// one did not reach the others.
//
// IMPORTANT — DO NOT MOVE THIS FILE OUT OF scripts/. Railway nixpacks services
// build with `root_dir=scripts` and package only `scripts/` into `/app/`, so a
// relative import that escapes `scripts/` resolves to a path that does not
// exist in the container and crashes the worker on startup with
// ERR_MODULE_NOT_FOUND. See scripts/_simulation-queue-constants.mjs (#3811
// incident / #3818 hotfix) and the regression test
// tests/scripts-railway-nixpacks-no-escape-import.test.mts. Vercel-side TS
// handlers are fine: esbuild inlines this module's contents at build time.
//
// Runtime constraint: Web-Platform APIs only (must run on Vercel Edge + Node).

/**
 * Newest annual period that is reliably final across reporters.
 *
 * Comtrade annual data lags, and it lags unevenly: the fastest reporters are a
 * full year ahead of the slowest. `lag = 2` is the repo-wide default because
 * (y-2) is old enough that the major reporters have all filed.
 */
export function recentPeriod(now = new Date(), lag = 2) {
  return String(now.getUTCFullYear() - lag);
}

/**
 * Sequential fallback periods, freshest first, for endpoints that accept only
 * ONE period per request.
 *
 * Needed because (y-2) rolls forward the instant the UTC year turns, to a year
 * the slower reporters have not filed yet; without a fallback a seed goes empty
 * every January until they catch up.
 */
export function candidatePeriods(now = new Date()) {
  return [recentPeriod(now, 2), recentPeriod(now, 3)];
}

/**
 * Comma-joined multi-year window for endpoints that accept a period LIST.
 *
 * Costs the same single request as one period but still lands a row for a
 * reporter that files late — the failure mode documented in
 * scripts/seed-recovery-import-hhi.mjs (UAE, Oman, Bahrain publish 1-2y behind
 * the G7). Consumers must resolve one row per (product, partner) afterwards,
 * newest year first, or a multi-year response silently mixes years.
 *
 * ONLY the authenticated `data/v1/get` route accepts a list. The public
 * `public/v1/preview` route returns HTTP 400 for a comma-separated period —
 * verified by live probe 2026-07-26: `period=2024` -> 200 (31 rows),
 * `period=2024,2023` -> 400. Use recentPeriod()/candidatePeriods() there.
 */
export function periodWindow(now = new Date(), { from = 2, to = 5 } = {}) {
  const years = [];
  for (let lag = from; lag <= to; lag++) years.push(recentPeriod(now, lag));
  return years.join(',');
}
