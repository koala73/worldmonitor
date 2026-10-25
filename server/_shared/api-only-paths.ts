/**
 * The one named API-only set (plan 2026-10-25-001, KTD7 / R4).
 *
 * A desktop-key principal gets what a signed-in Pro session gets — decided by
 * the same entitlement checks — EXCEPT these surfaces, which belong to the
 * API plans. The gateway has no tier above 1 and a Pro session reaches
 * `/api/v2/shipping/route-intelligence` today, so "same checks" alone would
 * open REST v2 to a desktop key; this set is what closes it. The gateway and
 * `resolvePremiumCallerIdentity` both deny a desktop principal (a `desktop`
 * key, or a downgraded owner's `api` key at desktop scope) on any path here.
 *
 * MCP (`/mcp`, `/api/mcp`) and the OAuth key grants are served by their own
 * edge entries, whose generic validators already refuse every kind but `api`
 * (KTD3) and whose `wm_` path refuses downgraded owners (KTD5). They are still
 * listed so the set is complete in ONE place and pinned by one test, and so
 * a future route that reaches the gateway under these prefixes is denied
 * without anyone remembering to add it.
 *
 * Membership is by prefix for `/api/v2/` (every path, present and future —
 * the whole versioned REST surface is the API product) and exact otherwise.
 */

/** Every `/api/v2/` route is API-only. */
export const API_ONLY_PATH_PREFIXES: readonly string[] = Object.freeze(['/api/v2/']);

/** The MCP edge and the OAuth key-grant edges, both rewritten and canonical. */
export const API_ONLY_EXACT_PATHS: ReadonlySet<string> = new Set([
  '/mcp',
  '/api/mcp',
  '/.well-known/mcp',
  '/.well-known/mcp.json',
  '/oauth/authorize',
  '/oauth/authorize-pro',
  '/oauth/token',
  '/oauth/register',
  '/api/oauth/authorize',
  '/api/oauth/authorize-pro',
  '/api/oauth/token',
  '/api/oauth/register',
]);

/**
 * True when `pathname` is in the API-only set. Duplicate slashes are collapsed
 * first (`//api/v2/x` and `/api//v2/x` are the same route to a router that
 * normalizes them) and trailing slashes are ignored, so neither spelling can
 * slip a desktop principal past the prefix check.
 */
export function isApiOnlyPath(pathname: string): boolean {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  const normalized = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.replace(/\/+$/, '') : collapsed;
  if (API_ONLY_EXACT_PATHS.has(normalized)) return true;
  return API_ONLY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix) || normalized === prefix.slice(0, -1));
}
