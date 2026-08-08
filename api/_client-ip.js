export const UNKNOWN_CLIENT_IP = 'unknown';

// Marker headers set on degraded fail-closed responses so observability can
// correlate rate-limit outages without parsing JSON bodies. Mirrors
// server/_shared/rate-limit.ts.
export const RATE_LIMIT_DEGRADED_HEADERS = Object.freeze({
  'X-RateLimit-Mode': 'degraded',
  'Retry-After': '5',
});

// Header a Cloudflare Transform Rule injects on every proxied request to prove
// the request actually transited CF. Keep in sync with server/_shared/client-ip.ts.
const CF_EDGE_PROOF_HEADER = 'x-wm-edge-proof';

// Compare the edge-proof secret without an early exit on length mismatch.
// Synchronous so getClientIp stays sync (it's on the per-request rate-limit hot
// path with several callers that invoke it without await). Keep in sync with
// server/_shared/client-ip.ts.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = b.length;
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

// True only when the request proves it transited Cloudflare. If
// CF_EDGE_PROOF_SECRET is unset, do not trust cf-connecting-ip; fall back to
// x-real-ip/UNKNOWN so a missing deployment secret cannot silently reopen
// GHSA-c267.
export function hasCloudflareTransitProof(request) {
  const secret = (process.env.CF_EDGE_PROOF_SECRET ?? '').trim();
  if (!secret) return false;
  return constantTimeEqual((request.headers.get(CF_EDGE_PROOF_HEADER) ?? '').trim(), secret);
}

export function getClientIp(request) {
  const cf = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const xr = (request.headers.get('x-real-ip') ?? '').trim();
  // cf-connecting-ip is only unforgeable for traffic that actually transited
  // Cloudflare. On a direct-to-origin hit (bypassing CF) it is fully client-
  // controlled, so an attacker sending a fresh value per request rotates the
  // sliding-window bucket and neutralises the IP limits (GHSA-c267). Trust it
  // only with proof of CF transit. Otherwise use Vercel's own x-real-ip (the
  // real peer IP) then the shared UNKNOWN bucket; the spoofable cf-connecting-ip
  // and the client-settable x-forwarded-for (#3531) are deliberately NOT
  // fallbacks here.
  if (cf && hasCloudflareTransitProof(request)) return cf;
  return xr || UNKNOWN_CLIENT_IP;
}
