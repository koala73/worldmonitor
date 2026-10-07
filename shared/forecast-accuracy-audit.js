// The one switch for the public accuracy record (#8990). While it holds an
// audit, /accuracy/, llms-full.txt, scorecard.json, the forecast panel and the
// MCP forecast surfaces withdraw every score and say why. Set it to null to
// lift the audit, then rebuild the generated outputs.
export const FORECAST_ACCURACY_AUDIT = Object.freeze({
  since: '2026-10-07',
  issue: 8990,
  reason: 'An audit found errors in how forecasts were scored, including outcomes recorded without reading their data.',
});
