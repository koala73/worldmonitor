/**
 * Chokepoint traffic-anomaly detection — single source of truth.
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
