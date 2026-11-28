/**
 * Orbital Watch on the pricing page and in the product facts (#10761), published at
 * launch (#10768) together with VITE_ENABLE_ORBITAL_WATCH and ORBITAL_WATCH_ENABLED.
 * The copy names only shipped, gated features; own sites and the Business rows of
 * #10713 are not built yet.
 */
export const ORBITAL_WATCH_PRICING_PUBLISHED = true;

/**
 * lookup: the browser-only point lookup and the public latest image on watched sites.
 * alerts-mcp: adds the Pro imaging-window alerts and the paid MCP tools. Site-change alerts
 *   stay out of the copy while change scoring is in shadow (CHANGE_SHADOW, #10763).
 * alerts-mcp-api: also the premium REST paths, which need an API key.
 */
export type OrbitalWatchAccess = 'lookup' | 'alerts-mcp' | 'alerts-mcp-api';

/** Keyed by the pricing table's tier locale keys. */
export const ORBITAL_WATCH_ACCESS: Readonly<Record<string, OrbitalWatchAccess>> = {
  free: 'lookup',
  pro: 'alerts-mcp',
  proBusiness: 'alerts-mcp',
  api: 'alerts-mcp-api',
  apiBusiness: 'alerts-mcp-api',
  enterprise: 'alerts-mcp-api',
};

/** Product-facts wording, one line per access level. */
export const ORBITAL_WATCH_PLAN_LINES: Readonly<Record<OrbitalWatchAccess, string>> = {
  lookup: 'Orbital Watch: satellite passes over any point, looked up in your browser; latest image and date on watched sites',
  'alerts-mcp': 'Orbital Watch: imaging-window alerts; satellite passes and watched-site imagery over MCP',
  'alerts-mcp-api': 'Orbital Watch: imaging-window alerts; satellite passes and watched-site imagery over MCP and the REST API',
};

/** What a tier gets from Orbital Watch, or null while it is hidden or for an unknown tier. */
export function orbitalWatchAccess(tier: string, published: boolean = ORBITAL_WATCH_PRICING_PUBLISHED): OrbitalWatchAccess | null {
  return published ? ORBITAL_WATCH_ACCESS[tier] ?? null : null;
}
