export const PUBLIC_BOOTSTRAP_TIERS = new Set(['fast', 'slow']);

/**
 * Return the tier for the two fixed public bootstrap request shapes, else null.
 * This dependency-free helper is shared by the Vercel handler and Cloudflare
 * shadow Worker so their routing contract cannot drift independently.
 */
export function bootstrapTierFromPublicRequest(req, parsedUrl = new URL(req.url)) {
  if (req.method !== 'GET') return null;

  const pathname = parsedUrl.pathname.length > 1
    ? parsedUrl.pathname.replace(/\/+$/, '')
    : parsedUrl.pathname;
  if (pathname !== '/api/bootstrap') return null;

  const params = Array.from(parsedUrl.searchParams.keys());
  if (params.some((key) => key !== 'tier' && key !== 'public')) return null;

  const tierParams = parsedUrl.searchParams.getAll('tier');
  const publicParams = parsedUrl.searchParams.getAll('public');
  if (tierParams.length !== 1 || publicParams.length !== 1 || publicParams[0] !== '1') return null;

  return PUBLIC_BOOTSTRAP_TIERS.has(tierParams[0]) ? tierParams[0] : null;
}

export function isPublicTierBootstrapRequest(req) {
  return bootstrapTierFromPublicRequest(req) !== null;
}
