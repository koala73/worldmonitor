export const UNKNOWN_CLIENT_IP = 'unknown';

// Marker headers set on degraded fail-closed responses so observability can
// correlate rate-limit outages without parsing JSON bodies. Mirrors
// server/_shared/rate-limit.ts.
export const RATE_LIMIT_DEGRADED_HEADERS = Object.freeze({
  'X-RateLimit-Mode': 'degraded',
  'Retry-After': '5',
});

export function getClientIp(request) {
  // With Cloudflare proxy -> Vercel, x-real-ip is the CF edge IP (shared
  // across users). cf-connecting-ip is the actual client IP set by Cloudflare.
  //
  // x-forwarded-for is client-settable and must not be trusted for rate
  // limiting (#3531). When neither trusted header is present, return the
  // shared UNKNOWN_CLIENT_IP bucket so callers cannot rotate identities by
  // toggling x-forwarded-for.
  const cf = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const xr = (request.headers.get('x-real-ip') ?? '').trim();
  return cf || xr || UNKNOWN_CLIENT_IP;
}
