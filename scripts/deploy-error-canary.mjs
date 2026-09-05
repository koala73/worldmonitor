#!/usr/bin/env node

/**
 * Deploy-relative per-route error-rate canary (#7107).
 *
 * Why this exists: the 2026-08-01 09:57Z deploy of GHSA-cmj5-cfhr-w964 broke
 * `get-aircraft-details-batch` for effectively every dashboard user — 132,500
 * client-facing 400s over three days, 17k+ distinct IPs — and nothing
 * alerted. The same deploy produced the lowercase-country-code failures
 * (PR #7105) and an api_starter customer's 148 400s/day. All three were
 * reconstructed forensically weeks later. A change that moves a route's 4xx
 * rate from ~0% to ~100% of its traffic is invisible unless someone happens
 * to query Axiom.
 *
 * This is the issue's "coarse version": run hourly, compare each of the
 * top-N routes' 4xx/5xx rate in the CURRENT window (default: the last 2 h)
 * against the same route's own BASELINE (default: the 7 days before the
 * current window), and fail the job when a route is a step change over its
 * own baseline. Window boundaries are printed on every alert so the finding
 * is attributable to the deploys inside the current window. The data source
 * is the same `wm_api_usage` dataset the gateway already ingests to.
 *
 * Detection is deliberately per-route-relative, not absolute: a route that
 * is 1% errors every day never alerts at 2%, while a route that has been
 * ~0% for a week alerts within one run of going to 100%. Guards against
 * paging on noise:
 *   - only the top `topRoutes` routes by current traffic are evaluated
 *     (the issue's top-50), so long-tail probe scans cannot page;
 *   - `minCurrentErrors` is an absolute floor — a 10-request route that
 *     failed 8 times is somebody's typo, not an incident;
 *   - the baseline rate is floored at `baselineRateFloor` before the
 *     multiple is computed, so a zero-error week (or a brand-new route)
 *     does not make any single error an infinite step.
 *
 * Alerting follows the repo's monitor pattern (analytics-collector-monitor):
 * `::error` annotations + exit code 1, from a scheduled workflow.
 */

import { isMainModule } from './lib/main-module.mjs';

const AXIOM_APL_URL = 'https://api.axiom.co/v1/datasets/_apl?format=legacy';

export const DEFAULT_CANARY_OPTIONS = {
  /** Evaluate only the busiest routes in the current window (issue: top-50). */
  topRoutes: 50,
  /** Current error rate must be at least this multiple of the baseline rate. */
  rateMultiple: 10,
  /** Floor applied to the baseline rate before the multiple is computed. */
  baselineRateFloor: 0.005,
  /** Absolute floor: fewer current-window errors than this never alerts. */
  minCurrentErrors: 50,
  /** And the failing share must be material on its own. */
  minCurrentErrorRate: 0.2,
};

/** @typedef {{ route: string; total: number; errors: number }} RouteWindow */

/**
 * Pure detection core. `baseline` and `current` are per-route aggregates for
 * the two windows; `windows` is carried through onto the report and alert
 * summaries so every finding names the window it is attributed to.
 */
export function evaluateDeployCanary({ baseline, current, windows, options }) {
  const opts = { ...DEFAULT_CANARY_OPTIONS, ...(options ?? {}) };
  const baselineByRoute = new Map(baseline.map((row) => [row.route, row]));

  const evaluated = [...current]
    .sort((a, b) => b.total - a.total)
    .slice(0, opts.topRoutes);

  const alerts = [];
  for (const row of evaluated) {
    if (row.total <= 0) continue;
    if (row.errors < opts.minCurrentErrors) continue;
    const currentErrorRate = row.errors / row.total;
    if (currentErrorRate < opts.minCurrentErrorRate) continue;

    const base = baselineByRoute.get(row.route);
    const baselineErrorRate = base && base.total > 0 ? base.errors / base.total : 0;
    const flooredBaselineRate = Math.max(baselineErrorRate, opts.baselineRateFloor);
    const rateMultiple = currentErrorRate / flooredBaselineRate;
    if (rateMultiple < opts.rateMultiple) continue;

    const windowNote = windows
      ? ` in ${windows.current.from}..${windows.current.to} (baseline ${windows.baseline.from}..${windows.baseline.to})`
      : '';
    alerts.push({
      route: row.route,
      currentTotal: row.total,
      currentErrors: row.errors,
      currentErrorRate,
      baselineErrorRate,
      rateMultiple,
      summary:
        `${row.route}: ${row.errors}/${row.total} (${(currentErrorRate * 100).toFixed(1)}%) 4xx/5xx` +
        `${windowNote} — ${rateMultiple.toFixed(0)}x its own baseline of ${(baselineErrorRate * 100).toFixed(2)}%`,
    });
  }

  return { alerts, evaluatedRoutes: evaluated.length, windows: windows ?? null };
}

/** APL for one window's per-route totals and 4xx/5xx counts. */
export function buildCanaryApl(window) {
  return [
    "['wm_api_usage']",
    `| where _time >= datetime('${window.from}') and _time < datetime('${window.to}')`,
    '| summarize total = count(), errors = countif(status >= 400) by route',
  ].join('\n');
}

/**
 * Run one window's aggregation against Axiom. `format=legacy` answers with
 * `{ buckets: { totals: [{ group: { route }, aggregations: [...] }] } }`;
 * the tabular shapes differ per format, so parse defensively and throw on
 * anything unrecognizable — a monitor that silently reads zero rows would
 * report permanent health, which is the #7107 failure mode itself.
 */
async function queryWindow(window, { token, fetchImpl = fetch }) {
  const resp = await fetchImpl(AXIOM_APL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apl: buildCanaryApl(window),
      startTime: window.from,
      endTime: window.to,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`Axiom APL query failed: HTTP ${resp.status} ${await resp.text().catch(() => '')}`);
  }
  const payload = await resp.json();
  const totals = payload?.buckets?.totals;
  if (!Array.isArray(totals)) throw new Error('Axiom APL answer carried no buckets.totals');
  return totals.map((row) => {
    const aggs = Array.isArray(row?.aggregations) ? row.aggregations : [];
    const byOp = new Map(aggs.map((a) => [a?.op, a?.value]));
    return {
      route: String(row?.group?.route ?? ''),
      total: Number(byOp.get('total') ?? 0),
      errors: Number(byOp.get('errors') ?? 0),
    };
  }).filter((row) => row.route !== '');
}

function isoHoursAgo(hours, now = Date.now()) {
  return new Date(now - hours * 3_600_000).toISOString();
}

export async function runDeployErrorCanary({
  token = process.env.AXIOM_API_TOKEN,
  currentHours = 2,
  baselineDays = 7,
  fetchImpl = fetch,
  log = console,
} = {}) {
  if (!token) {
    // Config gap, not health: fail loudly so the workflow shows red instead
    // of a permanently-green canary nobody configured (#7107's own lesson).
    log.error('::error::deploy-error-canary: AXIOM_API_TOKEN is not set');
    return { ok: false, reason: 'not-configured' };
  }

  const now = Date.now();
  const windows = {
    current: { from: isoHoursAgo(currentHours, now), to: new Date(now).toISOString() },
    baseline: {
      from: isoHoursAgo(currentHours + baselineDays * 24, now),
      to: isoHoursAgo(currentHours, now),
    },
  };

  const [baseline, current] = await Promise.all([
    queryWindow(windows.baseline, { token, fetchImpl }),
    queryWindow(windows.current, { token, fetchImpl }),
  ]);

  const report = evaluateDeployCanary({ baseline, current, windows });
  log.log(
    `deploy-error-canary: evaluated ${report.evaluatedRoutes} routes; ` +
    `current ${windows.current.from}..${windows.current.to}, baseline ${baselineDays}d prior`,
  );
  for (const alert of report.alerts) {
    log.error(`::error::deploy-error-canary: ${alert.summary}`);
  }
  if (report.alerts.length === 0) log.log('deploy-error-canary: no step-change routes');
  return { ok: report.alerts.length === 0, report };
}

if (isMainModule(import.meta.url)) {
  runDeployErrorCanary()
    .then((result) => {
      if (!result.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`::error::deploy-error-canary: ${err?.message ?? err}`);
      process.exitCode = 1;
    });
}
