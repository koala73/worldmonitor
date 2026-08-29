/**
 * Pure path and environment helpers for the God's Eye View API mount.
 *
 * Separate from gev-api-server.mjs so that callers who only need these —
 * scripts/vendor-gev-api-base.mjs, tests/gev-api-contract.test.mjs — do not
 * pull in upstream's 7,383-line config and its whole module graph.
 */

/** Where every upstream `/api/...` route is re-mounted. */
export const GEV_API_PREFIX = '/api/gev';

/**
 * World Monitor's `.env` name → the name upstream's config reads.
 *
 * The fork's `.env` predates the merge and already used `GEV_`-prefixed names
 * for the two keys that would otherwise be ambiguous, and its NASA key is
 * spelled for World Monitor's own FIRMS client. Mapping here (rather than
 * editing `src/gev/vite.config.js`) keeps the vendored tree untouched, and
 * mirrors the `define` block in the root `vite.config.ts` that does the same
 * job for the browser half.
 */
export const GEV_ENV_ALIASES = Object.freeze({
  GEV_GOOGLE_API_KEY: 'GOOGLE_MAPS_API_KEY',
  GEV_TOMTOM_API_KEY: 'TOMTOM_API_KEY',
  NASA_FIRMS_API_KEY: 'FIRMS_MAP_KEY',
});

/**
 * Apply {@link GEV_ENV_ALIASES} to an environment object, in place.
 *
 * Only fills a target that is not already set — a real `TOMTOM_API_KEY` in the
 * environment always wins over `GEV_TOMTOM_API_KEY`.
 */
export function applyGevEnvAliases(env = process.env) {
  for (const [from, to] of Object.entries(GEV_ENV_ALIASES)) {
    const value = env[from];
    if (typeof value === 'string' && value.trim() && !env[to]) {
      env[to] = value;
    }
  }
  return env;
}

/**
 * Rewrite an upstream mount path into the `/api/gev` namespace.
 *
 * Connect strips a string mount path from `req.url` before invoking the
 * handler, so a handler registered at `/api/radio` sees `/stations?x=1` for a
 * request to `/api/radio/stations?x=1`. Re-mounting at `/api/gev/radio` makes
 * it see exactly the same thing — which is the whole reason upstream's
 * handlers need no edits.
 */
export function remountUnderGev(mountPath) {
  if (typeof mountPath !== 'string') return mountPath;
  if (mountPath.startsWith(`${GEV_API_PREFIX}/`) || mountPath === GEV_API_PREFIX) {
    return mountPath;
  }
  if (mountPath.startsWith('/api/')) {
    return `${GEV_API_PREFIX}/${mountPath.slice('/api/'.length)}`;
  }
  // Anything not under /api/ is left alone — upstream registers nothing else
  // today, but silently swallowing a new route would be worse than serving it
  // where the plugin asked for it.
  return mountPath;
}

/** Plugins whose middleware the API server replays. Upstream names them consistently. */
export function isGevProxyPlugin(plugin) {
  const name = plugin?.name;
  return typeof name === 'string' && (name.endsWith('-proxy') || name.endsWith('-proxies'));
}
