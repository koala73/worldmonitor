/**
 * Resolve a root-relative static file (`/data/...`, `/textures/...`) against the
 * origin that served this bundle.
 *
 * The MCP Apps views run inside a host sandbox on another origin. Claude's
 * sandbox blocks `<base>`, so a bare `/data/countries.geojson` resolves against
 * the sandbox and 404s. `import.meta.url` is the bundle's own URL on the
 * WorldMonitor origin. When page and bundle share an origin (the web app, the
 * desktop app, dev), or the bundle was not loaded over HTTP (tests), the path
 * is returned unchanged.
 */
export function resolveStaticAssetUrl(path: string, bundleUrl: string, pageOrigin: string | undefined): string {
  if (pageOrigin === undefined) return path;
  const url = new URL(path, bundleUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return path;
  return url.origin === pageOrigin ? path : url.href;
}

export function staticAssetUrl(path: string): string {
  return resolveStaticAssetUrl(path, import.meta.url, typeof location === 'undefined' ? undefined : location.origin);
}
