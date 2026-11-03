/**
 * Chokepoint PortWatch daily-history statistics — single source of truth for
 * the traffic-anomaly signal and the official-count summary.
 *
 * Lives in `shared/` rather than beside the other scoring helpers in
 * `server/worldmonitor/supply-chain/v1/_scoring.mjs` because the AIS relay
 * needs it too, and the relay image copies `shared/` but not `server/`
 * (see Dockerfile.relay). The relay previously carried a hand-maintained copy
 * kept honest by a source-comparison test; one module removes both.
 *
 * ESM, loaded from the CJS relay via `require()` (Node >= 22.12 require(esm);
 * the relay image is node:24).
 */

/**
 * Compares the trailing 7 days of transits against the 30 days before them.
 *
 * Needs 37 days of history: 7 for the recent window plus 30 for the baseline.
 * Below a baseline of 14 transits per week the ratio is too noisy to act on,
 * so it reports no signal rather than a large percentage of a tiny number.
 * A drop only raises `signal` at war_zone/critical threat levels — elsewhere a
 * traffic dip is seasonal, not a disruption.
 *
 * @param {Array<{date: string, total: number}> | null | undefined} history
 * @param {string} threatLevel
 * @returns {{dropPct: number, signal: boolean}}
 */
export function detectTrafficAnomaly(history, threatLevel) {
  if (!history || history.length < 37) return { dropPct: 0, signal: false };
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let recent7 = 0;
  let baseline30 = 0;
  for (let i = 0; i < 7 && i < sorted.length; i++) recent7 += sorted[i].total;
  for (let i = 7; i < 37 && i < sorted.length; i++) baseline30 += sorted[i].total;
  const baselineAvg7 = (baseline30 / Math.min(30, sorted.length - 7)) * 7;
  if (baselineAvg7 < 14) return { dropPct: 0, signal: false };
  const dropPct = Math.round(((baselineAvg7 - recent7) / baselineAvg7) * 100);
  const isHighThreat = threatLevel === 'war_zone' || threatLevel === 'critical';
  return { dropPct, signal: dropPct >= 50 && isHighThreat };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function roundOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

function isDayRecord(day) {
  return Boolean(day) && typeof day.date === 'string' && ISO_DAY.test(day.date)
    && typeof day.total === 'number' && Number.isFinite(day.total) && day.total >= 0;
}

/**
 * The official IMF PortWatch figures a chokepoint publishes: the latest
 * published day and its count, the mean of the latest 7 published days, and
 * the seeder's year-earlier baseline.
 *
 * PortWatch publishes with a lag of about four days, so "latest" is the newest
 * day in the history, never today. Every field is null when the input cannot
 * support it: no history gives no latest day, fewer than 7 days gives no
 * 7-day mean, and a baseline missing any of its three parts is dropped whole.
 * Null is the contract; a zero would read as a measured day of no traffic.
 *
 * @param {Array<{date: string, total: number}> | null | undefined} history
 * @param {{avgDaily: number, from: string, to: string} | null | undefined} baseline
 * @returns {{latestDate: string | null, latestTotal: number | null, avg7d: number | null,
 *   baselineAvgDaily: number | null, baselineFrom: string | null, baselineTo: string | null}}
 */
export function summarizePortwatchHistory(history, baseline) {
  const days = Array.isArray(history) ? history.filter(isDayRecord) : [];
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0] ?? null;
  const avg7d = sorted.length >= 7
    ? roundOneDecimal(sorted.slice(0, 7).reduce((sum, day) => sum + day.total, 0) / 7)
    : null;
  const baselineValid = Boolean(baseline)
    && typeof baseline.avgDaily === 'number' && Number.isFinite(baseline.avgDaily) && baseline.avgDaily >= 0
    && typeof baseline.from === 'string' && ISO_DAY.test(baseline.from)
    && typeof baseline.to === 'string' && ISO_DAY.test(baseline.to);
  return {
    latestDate: latest ? latest.date : null,
    latestTotal: latest ? latest.total : null,
    avg7d,
    baselineAvgDaily: baselineValid ? roundOneDecimal(baseline.avgDaily) : null,
    baselineFrom: baselineValid ? baseline.from : null,
    baselineTo: baselineValid ? baseline.to : null,
  };
}
