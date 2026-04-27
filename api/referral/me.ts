/**
 * Signed-in user's referral profile (Phase 9 / Todo #223).
 *
 * GET /api/referral/me
 *   Bearer-auth via Clerk JWT.
 *   -> 200 { code, shareUrl }
 *   -> 401 on missing/invalid bearer
 *   -> 503 if BRIEF_URL_SIGNING_SECRET is not configured (we reuse
 *      it as the HMAC secret for referral codes — see handler body).
 *
 * `code` is a deterministic 8-char hash of the Clerk userId (stable
 * for the life of the account).
 *
 * Stats are privacy-safe: the route returns counts only, never the
 * referred users' emails or identities.
 *
 * Convex binding is fire-and-forget via ctx.waitUntil (see handler).
 * An earlier iteration blocked on the binding and returned 503 on
 * any failure — that turned a single flaky Convex call into a
 * homepage-wide 503 outage for every PRO user (all homepage loads
 * fetch this within the 5-minute client cache window). The mutation
 * is idempotent; the next fetch re-attempts, and a receiver's
 * signup at /pro?ref=<code> only needs the binding to have landed
 * SOMETIME before that receiver completes signup, not on every
 * share-button mount. Missed attribution beats homepage 503.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { validateBearerToken } from '../../server/auth-session';
import { getReferralCodeForUser, buildShareUrl } from '../../server/_shared/referral-code';

const PUBLIC_BASE =
  process.env.WORLDMONITOR_PUBLIC_BASE_URL ?? 'https://worldmonitor.app';

/**
 * Bind the Clerk-derived share code to the userId in Convex so that
 * future /pro?ref=<code> signups can actually credit the sharer.
 *
 * Fire-and-forget via the caller's ctx.waitUntil — never blocks the
 * 200 response on this path. The mutation is idempotent, so the next
 * /api/referral/me fetch (or signup-side lookup) re-attempts. A
 * missed binding degrades to "receiver's signup isn't attributed"
 * which is strictly less bad than the prior behaviour of 503'ing
 * every PRO homepage load while Convex is slow or misconfigured.
 *
 * Resolves on success. Does NOT throw on failure — the caller relies
 * on waitUntil to catch + log so a background failure can't surface
 * as an unhandled rejection.
 */
async function registerReferralCodeInConvex(userId: string, code: string): Promise<void> {
  const convexSite =
    process.env.CONVEX_SITE_URL ??
    (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
  const relaySecret = process.env.RELAY_SHARED_SECRET ?? '';
  if (!convexSite || !relaySecret) {
    throw new Error('convex_relay_not_configured');
  }
  const res = await fetch(`${convexSite}/relay/register-referral-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${relaySecret}`,
      'User-Agent': 'worldmonitor-edge/1.0',
    },
    body: JSON.stringify({ userId, code }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`register_referral_code_${res.status}`);
  }
}

export default async function handler(
  req: Request,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }
  const cors = getCorsHeaders(req, 'GET, OPTIONS') as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);

  const session = await validateBearerToken(jwt);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  // Reuse BRIEF_URL_SIGNING_SECRET as the HMAC secret for referral
  // codes. Same secret, different message namespace (`referral:v1:`
  // vs `brief:...`) so code spaces don't collide. Avoids provisioning
  // yet another Railway env var — referral codes are low-stakes and
  // the consequence of secret rotation is "existing share links stop
  // counting", not "user-visible breakage".
  const secret = process.env.BRIEF_URL_SIGNING_SECRET ?? '';
  if (!secret) {
    console.error('[api/referral/me] BRIEF_URL_SIGNING_SECRET is not configured');
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  let code: string;
  try {
    code = await getReferralCodeForUser(session.userId, secret);
  } catch (err) {
    console.error('[api/referral/me] code generation failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/referral/me', step: 'code-generation' }, ctx });
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  // Bind the code to the userId in Convex in the background so future
  // /pro?ref=<code> signups can credit the sharer. FIRE-AND-FORGET
  // via ctx.waitUntil — the response doesn't wait, and a binding
  // failure (Convex outage, bad env, non-2xx, timeout) logs a warning
  // but never turns into a 503. See module docstring for the
  // rationale; an earlier blocking design caused homepage-wide
  // outages on every flake. The mutation is idempotent so the next
  // request retries.
  ctx.waitUntil(
    registerReferralCodeInConvex(session.userId, code).catch((err: unknown) => {
      // Narrow rather than cast — a future path that throws a
      // non-Error value must not turn this warning into "failed:
      // undefined". The helper today only throws Error instances,
      // so the instanceof branch is the common path.
      console.warn(
        '[api/referral/me] binding failed (non-blocking):',
        err instanceof Error ? err.message : String(err),
      );
    }),
  );

  // No invite/conversion count is returned on the response. The
  // waitlist path (userReferralCredits) now credits correctly, but
  // the Dodopayments checkout path (affonso_referral) still doesn't
  // flow into Convex. Counting only one of the two attribution
  // paths would mislead. Metrics will surface in a follow-up that
  // unifies both.
  return jsonResponse(
    {
      code,
      shareUrl: buildShareUrl(PUBLIC_BASE, code),
    },
    200,
    cors,
  );
}
