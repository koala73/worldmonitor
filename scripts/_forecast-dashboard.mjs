/**
 * Dashboard-sized projection of the forecast feed (#5300).
 *
 * `forecast:predictions:v2` is 188 KB for 15 predictions, and **78% of it is
 * `caseFile`** — the per-forecast evidence dossier (~19,000 words of prose across
 * branches, actors, worldState, supporting/counter evidence, escalatory and
 * contrarian cases, triggers).
 *
 * That dossier is read in exactly ONE place: `ForecastPanel.renderDetailBody()`,
 * which mounts it eagerly into `<div class="fc-detail fc-hidden">` and reveals it
 * with a hover-only "Analysis" toggle. So today every visitor:
 *   - pulls 146 KB of dossiers out of Redis on every bootstrap origin miss,
 *   - downloads them on every page load, and
 *   - has ~19,000 words serialised to HTML and parsed into the DOM at panel
 *     render — on a priority-1 panel, i.e. inside the LCP/INP window —
 * for content the overwhelming majority never expand.
 *
 * The bootstrap key therefore carries the LIST the panel renders (188 KB -> 41 KB).
 * The canonical key keeps the dossiers and still serves the RPC, the MCP widget and
 * chat-analyst-context; the panel fetches a dossier lazily when someone actually
 * opens one.
 *
 * NOTE: this file must not import anything outside `scripts/` — Railway builds the
 * seeders from a scripts-only Nixpacks root, and a `../api/` import crashes the
 * container at startup (#5268 took the wildfire feed down for ~6h exactly that way).
 */

/** Fields dropped from the dashboard list. Only `caseFile` today — it is 78% of the payload. */
export const FORECAST_DETAIL_FIELDS = ['caseFile'];

/**
 * Top-level fields the dashboard key may carry. An ALLOWLIST, deliberately.
 *
 * This is the whole lesson of the incident below: `runSeed` feeds `publishTransform(data)`
 * to the canonical key but feeds RAW `data` to every extraKey transform
 * (scripts/_seed-utils.mjs — `publishData` at the canonical write vs `ekData` in the
 * extraKeys loop). For seed-forecasts, raw `data` is the full internal pipeline state:
 * fullRunPredictions, inputs, publishSelectionPool, situationClusters, situationFamilies,
 * stateUnits, enrichmentMeta, publishTelemetry, selection* — ~11 MB of trace.
 *
 * The first version of this function spread that object (`{ ...payload }`) and merely
 * deleted `caseFile` from each prediction. It therefore published an 11.5 MB dashboard
 * key — 66x LARGER than the 172 KB canonical key it was supposed to compact — and every
 * bootstrap origin miss pulled all of it. A denylist cannot be safe against an input
 * whose shape you do not control. Name what you keep, never what you drop.
 */
export const FORECAST_DASHBOARD_TOP_LEVEL_FIELDS = ['generatedAt', 'predictions'];

export function compactForecastDashboardPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.predictions)) return payload;

  let stripped = 0;
  const predictions = payload.predictions.map((prediction) => {
    if (!prediction || typeof prediction !== 'object') return prediction;
    let touched = false;
    const next = { ...prediction };
    for (const field of FORECAST_DETAIL_FIELDS) {
      if (next[field] !== undefined) {
        delete next[field];
        touched = true;
      }
    }
    if (touched) stripped += 1;
    // Tell the client the dossier exists but is not here, so it can lazily fetch
    // one instead of rendering an empty Analysis pane.
    return touched ? { ...next, hasCaseFile: true } : next;
  });

  const compact = { predictions, detailStripped: stripped };
  for (const field of FORECAST_DASHBOARD_TOP_LEVEL_FIELDS) {
    if (field !== 'predictions' && payload[field] !== undefined) compact[field] = payload[field];
  }
  return compact;
}
