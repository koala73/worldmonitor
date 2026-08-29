import {
  PUBLIC_WEATHER_BOOTSTRAP_KEY,
  bootstrapTierKeyNames,
} from './_bootstrap-tier-keys.js';

export const PUBLIC_BOOTSTRAP_TIERS = new Set(['fast', 'slow']);
const PUBLIC_ON_DEMAND_BOOTSTRAP_KEYS = new Set(bootstrapTierKeyNames('on-demand'));

/**
 * Classify the explicit public bootstrap URLs shared by the origin and Worker.
 * The marker is public before auth because a CDN hit can answer first. Exact
 * tier and single-key shapes keep the shared cache key space bounded.
 *
 * @param {URL} parsedUrl
 * @returns {{ authKind: 'public-tier', tier: string } | { authKind: 'public-weather' | 'public-on-demand', tier: null } | null}
 */
export function classifyPublicBootstrapUrl(parsedUrl) {
  const pathname = parsedUrl.pathname.length > 1
    ? parsedUrl.pathname.replace(/\/+$/, '')
    : parsedUrl.pathname;
  if (pathname !== '/api/bootstrap') return null;

  const paramNames = new Set(parsedUrl.searchParams.keys());
  const publicParams = parsedUrl.searchParams.getAll('public');
  if (paramNames.size !== 2 || !paramNames.has('public')) return null;
  if (publicParams.length !== 1 || publicParams[0] !== '1') return null;

  if (paramNames.has('tier')) {
    const tierParams = parsedUrl.searchParams.getAll('tier');
    if (tierParams.length !== 1 || !PUBLIC_BOOTSTRAP_TIERS.has(tierParams[0])) return null;
    return { authKind: 'public-tier', tier: tierParams[0] };
  }

  if (!paramNames.has('keys')) return null;
  const keyParams = parsedUrl.searchParams.getAll('keys');
  if (keyParams.length !== 1) return null;

  const key = keyParams[0];
  if (key === PUBLIC_WEATHER_BOOTSTRAP_KEY) {
    return { authKind: 'public-weather', tier: null };
  }
  if (PUBLIC_ON_DEMAND_BOOTSTRAP_KEYS.has(key)) {
    return { authKind: 'public-on-demand', tier: null };
  }
  return null;
}

/**
 * @param {Request} req
 * @param {URL} [parsedUrl]
 */
export function classifyPublicBootstrapRequest(req, parsedUrl = new URL(req.url)) {
  if (req.method !== 'GET') return null;
  return classifyPublicBootstrapUrl(parsedUrl);
}

/**
 * Return the tier for the two fixed public bootstrap request shapes, else null.
 * This registry-backed helper is shared by the Vercel handler and Cloudflare
 * Worker so their routing contract cannot drift independently.
 */
export function bootstrapTierFromPublicRequest(req, parsedUrl = new URL(req.url)) {
  const publicBootstrap = classifyPublicBootstrapRequest(req, parsedUrl);
  return publicBootstrap?.authKind === 'public-tier' ? publicBootstrap.tier : null;
}

export function isPublicTierBootstrapRequest(req) {
  return bootstrapTierFromPublicRequest(req) !== null;
}

export function isPublicWeatherBootstrapRequest(req) {
  return classifyPublicBootstrapRequest(req)?.authKind === 'public-weather';
}

export function isPublicOnDemandBootstrapRequest(req) {
  return classifyPublicBootstrapRequest(req)?.authKind === 'public-on-demand';
}
