/**
 * Resolve a root-relative static file (`/data/...`, `/textures/...`) against the
 * origin that served this bundle.
 *
 * The MCP Apps views run inside a host sandbox on another origin. Claude's
 * sandbox blocks `<base>`, so a bare `/data/countries.geojson` resolves against
 * the sandbox and 404s. `import.meta.url` is the bundle's own URL on the
 * WorldMonitor origin. When page and bundle share an origin (the web app, the
 * desktop app, dev), the path is returned unchanged.
 */
export function staticAssetUrl(path: string): string {
  if (typeof location === 'undefined') return path;
  const url = new URL(path, import.meta.url);
  return url.origin === location.origin ? path : url.href;
}
