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

// Vercel's x-real-ip is its direct peer. Only a peer in Cloudflare's published
// proxy ranges proves that an unproven cf-connecting-ip came from a genuine
// Cloudflare hop rather than a direct-origin spoof. Sources:
// https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/
// Keep in sync with server/_shared/client-ip.ts.
const CLOUDFLARE_IPV4_CIDRS = Object.freeze([
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]);

const CLOUDFLARE_IPV6_CIDRS = Object.freeze([
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]);

function parseIpv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let address = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    address = (address * 256) + octet;
  }
  return address >>> 0;
}

function parseIpv6(value) {
  if (!value || value.includes('.') || value.includes('%')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length >= 8) return null;

  const groups = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function parseIpv4Cidr(cidr) {
  const [networkText, prefixText] = cidr.split('/');
  const network = parseIpv4(networkText);
  if (network === null) throw new Error(`Invalid Cloudflare IPv4 CIDR: ${cidr}`);
  return [network, Number(prefixText)];
}

function parseIpv6Cidr(cidr) {
  const [networkText, prefixText] = cidr.split('/');
  const network = parseIpv6(networkText);
  if (network === null) throw new Error(`Invalid Cloudflare IPv6 CIDR: ${cidr}`);
  return [network, Number(prefixText)];
}

const CLOUDFLARE_IPV4_RANGES = Object.freeze(CLOUDFLARE_IPV4_CIDRS.map(parseIpv4Cidr));
const CLOUDFLARE_IPV6_RANGES = Object.freeze(CLOUDFLARE_IPV6_CIDRS.map(parseIpv6Cidr));

function isInIpv4Range(address, network, prefixLength) {
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return ((address & mask) >>> 0) === ((network & mask) >>> 0);
}

function isInIpv6Range(address, network, prefixLength) {
  const fullGroups = Math.floor(prefixLength / 16);
  for (let i = 0; i < fullGroups; i += 1) {
    if (address[i] !== network[i]) return false;
  }
  const remainingBits = prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (address[fullGroups] & mask) === (network[fullGroups] & mask);
}

function isCloudflareProxyIp(value) {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) {
    return CLOUDFLARE_IPV4_RANGES.some(([network, prefix]) => isInIpv4Range(ipv4, network, prefix));
  }
  const ipv6 = parseIpv6(value);
  return ipv6 !== null
    && CLOUDFLARE_IPV6_RANGES.some(([network, prefix]) => isInIpv6Range(ipv6, network, prefix));
}

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

// One-per-isolate warning that the edge-proof is not matching, so a missing
// CF_EDGE_PROOF_SECRET or a Cloudflare rule that stopped covering this route
// cannot regress silently. The dangerous state is cf-connecting-ip PRESENT
// and x-real-ip in Cloudflare's proxy ranges, but the x-wm-edge-proof header
// absent or mismatched. Direct-origin spoofs with non-CF peers must not warn
// or consume the latch. Keep this dependency-free and in sync with
// server/_shared/client-ip.ts. Symbol.for gives both mirror modules one
// collision-resistant, isolate-wide latch even when both are loaded together.
const EDGE_PROOF_MISMATCH_LATCH = Symbol.for(
  'worldmonitor.client-ip.edge-proof-mismatch-warning.v1',
);

function getEdgeProofMismatchLatch() {
  const existing = Reflect.get(globalThis, EDGE_PROOF_MISMATCH_LATCH);
  if (existing) return existing;
  const latch = { warned: false };
  Reflect.set(globalThis, EDGE_PROOF_MISMATCH_LATCH, latch);
  return latch;
}

export function warnEdgeProofNotProving() {
  const latch = getEdgeProofMismatchLatch();
  if (latch.warned) return;
  latch.warned = true;
  // One line, greppable in Vercel logs; not a per-request log. Follows the
  // rate-limit degraded-mode console.error precedent (api/_rate-limit.js).
  console.warn(
    '[client-ip] cf-connecting-ip present but x-wm-edge-proof missing/mismatched — rate-limit buckets keyed by Cloudflare PoP (x-real-ip), not per user. Fix CF_EDGE_PROOF_SECRET or the Cloudflare header transform rule. Issue #6431',
  );
}

// Test seam for the shared isolate-wide latch. Real isolates never call this;
// a fresh isolate starts with the latch clear. Mirrors the
// resetRateLimitFallbackForTest pattern.
export function resetEdgeProofMismatchWarnedForTest() {
  getEdgeProofMismatchLatch().warned = false;
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
  // The precise "looks enforced but is shared" state (#6431): an unproven
  // cf-connecting-ip arrived from a Cloudflare peer, so the user just joined
  // the PoP-shared x-real-ip bucket. A non-CF peer is a direct-origin spoof;
  // it must neither warn nor consume the shared latch.
  if (cf && isCloudflareProxyIp(xr)) warnEdgeProofNotProving();
  return xr || UNKNOWN_CLIENT_IP;
}
