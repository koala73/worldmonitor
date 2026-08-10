// Trusted client-IP derivation, extracted from rate-limit.ts (#5231).
//
// This module MUST stay free of npm imports (node: builtins and repo-relative
// imports only). It sits in the static import closure of server/_shared/redis.ts
// -> usage.ts, which Railway seeders load through the tsx loader in containers
// that install no npm packages beyond tsx itself. A bare npm specifier
// reachable from here crashes those crons with ERR_MODULE_NOT_FOUND at module
// resolution time — that is how #5229 took down seed-bundle-resilience-
// validation by importing this logic's previous home (rate-limit.ts, which
// pulls @upstash/ratelimit). tests/resilience-validation-import-graph.test.mjs
// enforces the invariant.

// Sentinel returned when no trusted client-IP header is present. Routed
// through the Upstash limiter as a single shared bucket so the entire
// "no trusted identity" population is naturally rate-limited together —
// an attacker who strips cf-connecting-ip / x-real-ip can no longer rotate
// identities by toggling x-forwarded-for. See getClientIp / #3531.
export const UNKNOWN_CLIENT_IP = 'unknown';

// Header a Cloudflare Transform Rule injects on every proxied request to prove
// the request actually transited CF. Keep in sync with api/_client-ip.js.
const CF_EDGE_PROOF_HEADER = 'x-wm-edge-proof';

// Compare the edge-proof secret without an early exit on length mismatch.
// Synchronous so getClientIp stays sync (per-request rate-limit hot path,
// several non-awaiting callers). Keep in sync with api/_client-ip.js.
function constantTimeEqual(a: string, b: string): boolean {
  const len = b.length;
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

// True only when the request proves it transited Cloudflare. If
// CF_EDGE_PROOF_SECRET is unset, do not trust cf-connecting-ip; fall back to
// x-real-ip/UNKNOWN so a missing deployment secret cannot silently reopen
// GHSA-c267.
export function hasCloudflareTransitProof(request: Request): boolean {
  const secret = (process.env.CF_EDGE_PROOF_SECRET ?? '').trim();
  if (!secret) return false;
  return constantTimeEqual((request.headers.get(CF_EDGE_PROOF_HEADER) ?? '').trim(), secret);
}

// One-per-isolate warning that the edge-proof is not matching, so a missing
// CF_EDGE_PROOF_SECRET or a Cloudflare rule that stopped covering this route
// cannot regress silently. The dangerous state is cf-connecting-ip PRESENT
// (the request really did transit Cloudflare) but the x-wm-edge-proof header
// absent or mismatched: getClientIp then falls back to x-real-ip, which
// Vercel sets to its peer — the Cloudflare PoP — so every user behind that
// PoP shares one rate-limit bucket and per-IP budgets look enforced but are
// not (issue #6431). Keep this dependency-free: this module is in the static
// import closure of Railway seeders that install no npm packages (#5229), so
// no Sentry/logger import and no npm specifier may be added here.
let edgeProofMismatchWarned = false;
export function warnEdgeProofNotProving(): void {
  if (edgeProofMismatchWarned) return;
  edgeProofMismatchWarned = true;
  // One line, greppable in Vercel logs; not a per-request log. Follows the
  // rate-limit degraded-mode console.error precedent (server/_shared/rate-limit.ts).
  console.warn(
    '[client-ip] cf-connecting-ip present but x-wm-edge-proof missing/mismatched — rate-limit buckets keyed by Cloudflare PoP (x-real-ip), not per user. Fix CF_EDGE_PROOF_SECRET or the Cloudflare header transform rule. Issue #6431',
  );
}

// Test seam: the warn-once flag is module state, so a suite that exercises the
// warning in one test must be able to reset it for the next. Real isolates
// never call this — a fresh isolate starts with the flag clear, which is
// exactly what the once-per-isolate contract needs. Mirrors the
// resetRateLimitFallbackForTest pattern.
export function resetEdgeProofMismatchWarnedForTest(): void {
  edgeProofMismatchWarned = false;
}

export function getClientIp(request: Request): string {
  // cf-connecting-ip is only unforgeable for traffic that actually transited
  // Cloudflare (x-real-ip is then the CF edge IP, shared across users). On a
  // direct-to-origin hit (bypassing CF) cf-connecting-ip is fully client-
  // controlled, so a caller sending a fresh value per request rotates the
  // per-IP window and neutralises the limit (GHSA-c267). Trust it only with
  // proof of CF transit. Otherwise fall back to x-real-ip (the real peer IP)
  // then the UNKNOWN_CLIENT_IP sentinel — the spoofable cf-connecting-ip and
  // the client-settable x-forwarded-for (#3531) are deliberately NOT fallbacks.
  //
  // Trim each header value before falling through — a whitespace-only
  // cf-connecting-ip would otherwise short-circuit past x-real-ip.
  const cf = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const xr = (request.headers.get('x-real-ip') ?? '').trim();
  if (cf && hasCloudflareTransitProof(request)) return cf;
  // The precise "looks enforced but is shared" state (#6431): the request
  // really did transit Cloudflare (cf-connecting-ip present and real) but
  // proof of CF transit is missing, so the user just joined the PoP-shared
  // x-real-ip bucket. Warn once per isolate so a rule/secret regression
  // surfaces in logs without spamming them.
  if (cf) warnEdgeProofNotProving();
  return xr || UNKNOWN_CLIENT_IP;
}
