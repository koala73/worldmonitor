import { escapeHtml } from './sanitize';

/**
 * Attribution footer for energy-atlas panels.
 *
 * Design: every public number on the Energy Atlas must expose its grounds —
 * source type, method, calibration sample size, freshness. This is the
 * "quantitative rigour" moat called out in §5.6 of the parity-and-surpass
 * plan. Reusable so future pipeline / storage / shortage panels hit the
 * same bar automatically.
 *
 * Intentionally a string builder (not a Panel helper) so it composes with
 * the existing panel render pattern (template-literal HTML). Data-
 * attributes are agent-readable so MCP tools can surface the same provenance.
 */

export type AttributionSourceType =
  | 'operator'        // operator disclosure / dashboard
  | 'regulator'       // govt regulator / EIA / IEA / JODI
  | 'ais'             // AIS-relay / Portwatch DWT calibration
  | 'satellite'       // Sentinel / Landsat / commercial EO
  | 'press'           // wire / outlet coverage
  | 'classifier'      // internal LLM/heuristic classifier
  | 'derived';        // computed from other sources

export interface AttributionFooterInput {
  /** Primary source type. */
  sourceType: AttributionSourceType;
  /** Free-text method summary — short, e.g. "AIS-DWT calibrated" or "GIE AGSI+ daily". */
  method?: string;
  /** Observation sample size (vessels, stations, rows, etc.). */
  sampleSize?: number;
  sampleLabel?: string;
  /** ISO8601 timestamp of last data refresh (or a Date). */
  updatedAt?: string | Date | number | null;
  /** Confidence band 0..1 (shown as "high/medium/low" to end user). */
  confidence?: number;
  /** Optional URL / credit for the data source (e.g. OWID, GEM). */
  creditName?: string;
  creditUrl?: string;
  /** Optional classifier version string for evidence-derived badges. */
  classifierVersion?: string;
}

function formatWhen(raw: AttributionFooterInput['updatedAt']): string | null {
  if (raw == null) return null;
  try {
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    const deltaMs = Date.now() - d.getTime();
    const mins = Math.round(deltaMs / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  } catch {
    return null;
  }
}

function confidenceLabel(c: number | undefined): string | null {
  if (c == null) return null;
  if (c >= 0.8) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
}

const SOURCE_LABEL: Record<AttributionSourceType, string> = {
  operator: 'operator disclosure',
  regulator: 'regulator data',
  ais: 'AIS calibration',
  satellite: 'satellite imagery',
  press: 'press / wire',
  classifier: 'evidence classifier',
  derived: 'derived metric',
};

export function attributionFooterHtml(input: AttributionFooterInput): string {
  const parts: string[] = [];

  const sourceLabel = SOURCE_LABEL[input.sourceType];
  parts.push(escapeHtml(sourceLabel));

  if (input.method) parts.push(escapeHtml(input.method));

  if (typeof input.sampleSize === 'number' && Number.isFinite(input.sampleSize)) {
    const label = input.sampleLabel || 'obs';
    parts.push(`${input.sampleSize.toLocaleString()} ${escapeHtml(label)}`);
  }

  const when = formatWhen(input.updatedAt);
  if (when) parts.push(`updated ${when}`);

  const conf = confidenceLabel(input.confidence);
  if (conf) parts.push(`${conf} confidence`);

  if (input.classifierVersion) parts.push(`classifier ${escapeHtml(input.classifierVersion)}`);

  const creditHtml = input.creditName
    ? (input.creditUrl
      ? ` · <a href="${escapeHtml(input.creditUrl)}" target="_blank" rel="noopener" class="attr-credit">${escapeHtml(input.creditName)}</a>`
      : ` · <span class="attr-credit">${escapeHtml(input.creditName)}</span>`)
    : '';

  const dataAttrs = [
    `data-attr-source="${escapeHtml(input.sourceType)}"`,
    input.method ? `data-attr-method="${escapeHtml(input.method)}"` : '',
    typeof input.sampleSize === 'number' ? `data-attr-n="${input.sampleSize}"` : '',
    input.confidence != null ? `data-attr-confidence="${input.confidence.toFixed(2)}"` : '',
    input.classifierVersion ? `data-attr-classifier="${escapeHtml(input.classifierVersion)}"` : '',
  ].filter(Boolean).join(' ');

  return `<div class="panel-attribution-footer" ${dataAttrs}>${parts.join(' · ')}${creditHtml}</div>`;
}

/** Inline <style> block to accompany the footer. Include once per panel. */
export const ATTRIBUTION_FOOTER_CSS = `
<style>
  .panel-attribution-footer {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid rgba(255,255,255,0.05);
    font-size: 9px;
    color: var(--text-dim, #888);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .panel-attribution-footer .attr-credit { color: var(--text-dim, #888); text-decoration: none; }
  .panel-attribution-footer .attr-credit:hover { text-decoration: underline; }
</style>
`;
