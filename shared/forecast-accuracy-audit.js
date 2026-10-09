// The audit state of the public accuracy record (#8990). /accuracy/, its
// dataset download, llms-full.txt, the REST scorecard, the forecast panel and
// the MCP forecast surfaces each call forecastAccuracyAudit() on the scorecard
// they show, so the same scorecard reads the same way everywhere. While an
// audit holds, those surfaces withdraw every score and say why.

// The standing audit. It holds while the headline cohort is not measurable and
// lifts by itself once the scorecard reports it measurable: at least 30
// forecast families, with at least 5 that came true and 5 that did not. Nobody
// edits a constant to lift it.
export const STANDING_ACCURACY_AUDIT = Object.freeze({
  since: '2026-10-07',
  issue: 8990,
  reason: 'An audit found three errors in how forecasts were scored. Some outcomes were recorded as "did not happen" without reading the data that decides them. Some forecasts were counted more than once. Some were scored at a probability other than the one published.',
  liftsWhenMeasurable: true,
});

// Manual override for a future incident: set it to a frozen
// { since, issue, reason } to hold an audit even while the headline is
// measurable, then rebuild the generated outputs. null defers to the scorecard.
// There is deliberately no way to lift the audit while the headline is not
// measurable.
export const FORECAST_ACCURACY_AUDIT_OVERRIDE = null;

const FAMILY_INTERVAL_METHOD = /^family-level /;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Whether the headline cohort meets the scorecard's family minimums: 'met',
 * 'short', or 'unknown' when the scorecard cannot show either. The seeder's
 * own skill.measurable decides where the reader has it (the Redis value the
 * REST handler and MCP read). The public contract has no room for that field,
 * so a frozen REST capture falls back to the skill Brier interval's
 * insufficientSample flag, which the seeder computes with the same minimums
 * over the same rows.
 */
export function headlineFamilyGate(scorecard) {
  if (!isRecord(scorecard) || scorecard.degraded === true) return 'unknown';
  if (typeof scorecard.error === 'string' && scorecard.error.trim()) return 'unknown';
  const skill = isRecord(scorecard.skill) ? scorecard.skill : null;
  if (!skill || !isFiniteNumber(skill.count) || skill.count <= 0) return 'unknown';
  if (typeof skill.measurable === 'boolean') return skill.measurable ? 'met' : 'short';
  const uncertainty = isRecord(scorecard.uncertainty) ? scorecard.uncertainty : null;
  if (typeof uncertainty?.method !== 'string' || !FAMILY_INTERVAL_METHOD.test(uncertainty.method)) return 'unknown';
  const interval = uncertainty.skillBrier;
  // The interval must cover the headline's own rows: same count, same mean (both round to six decimals).
  if (!isRecord(interval) || skill.count < 2 || interval.count !== skill.count) return 'unknown';
  if (!isFiniteNumber(skill.brier) || !isFiniteNumber(interval.mean) || Math.abs(interval.mean - skill.brier) > 1e-6) return 'unknown';
  const [low, high] = Array.isArray(interval.ci95) && interval.ci95.length === 2 ? interval.ci95 : [];
  if (!isFiniteNumber(low) || !isFiniteNumber(high) || low < 0 || low > high || high > 1) return 'unknown';
  if (interval.insufficientSample === false) return 'met';
  return interval.insufficientSample === true ? 'short' : 'unknown';
}

/**
 * The audit in force for this scorecard, or null when none is. The override
 * wins; otherwise the standing audit holds until the headline is measurable.
 * A missing, degraded or unreadable scorecard is not measurable.
 */
export function forecastAccuracyAudit(scorecard, override = FORECAST_ACCURACY_AUDIT_OVERRIDE) {
  if (override) return override;
  return headlineFamilyGate(scorecard) === 'met' ? null : STANDING_ACCURACY_AUDIT;
}
