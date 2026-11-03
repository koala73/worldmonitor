/**
 * Panel keys at every call site are code-controlled (panel registry constants,
 * `data-panel` attributes our own mount code writes), so this is a structural
 * guard, not a catalog check: anything that does not look like a panel key
 * collapses to 'unknown'. The full catalog lives in config/panels, whose
 * import-time side effects must stay out of the analytics graph. The registry
 * mixes kebab-case and camelCase ids (`gccNews`, `regionalStartups`), so the
 * shape allows interior uppercase; the real-catalog sweep in
 * tests/mission-funnel-events.test.mts pins that every live key passes.
 */
const PANEL_KEY_PATTERN = /^[a-z][a-zA-Z0-9-]{0,39}$/;

/**
 * User-created panels carry generated ids (`cw-<uuid>` custom widgets,
 * `mcp-<uuid>` MCP panels) that pass the structural guard but would fragment
 * the funnel into one Umami row per widget instance. Collapse each family to
 * a stable bucket before the shape check.
 */
const DYNAMIC_PANEL_KEY_BUCKETS: ReadonlyArray<[prefix: string, bucket: string]> = [
  ['cw-', 'custom-widget'],
  ['mcp-', 'mcp-panel'],
];

export function bucketPanelKeyForAnalytics(panelKey: string): string {
  for (const [prefix, bucket] of DYNAMIC_PANEL_KEY_BUCKETS) {
    if (panelKey.startsWith(prefix)) return bucket;
  }
  return PANEL_KEY_PATTERN.test(panelKey) ? panelKey : 'unknown';
}

