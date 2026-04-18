/**
 * Signed-in user's referral profile (Phase 9 / Todo #223).
 *
 * GET /api/referral/me
 *   Bearer-auth via Clerk JWT.
 *   -> 200 { code, shareUrl, invitedCount, convertedCount }
 *   -> 401 on missing/invalid bearer
 *   -> 503 if BRIEF_URL_SIGNING_SECRET is not configured (we reuse
 *      it as the HMAC secret for referral codes — see handler body).
 *
 * `code` is a deterministic 8-char hash of the Clerk userId (stable
 * for the life of the account). `invitedCount` is the number of
 * `registrations` rows that used this user's code as `referredBy`.
 * `convertedCount` is the subset of those that later produced a PRO
 * subscription — omitted in the MVP because subscription tracking
 * lives in a different table and the join isn't needed for the
 * share-button UX.
 *
 * Stats are privacy-safe: the route returns counts only, never the
 * referred users' emails or identities.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
import { validateBearerToken } from '../../server/auth-session';
import { getReferralCodeForUser, buildShareUrl } from '../../server/_shared/referral-code';

const PUBLIC_BASE =
  process.env.WORLDMONITOR_PUBLIC_BASE_URL ?? 'https://worldmonitor.app';

/**
 * Bind the Clerk-derived share code to the userId in Convex so that
 * future /pro?ref=<code> signups can actually credit the sharer.
 *
 * BLOCKING (no longer fire-and-forget). If the binding can't be
 * persisted the endpoint returns 503 instead of a dead share link —
 * handing a user a code the waitlist mutation will never resolve is
 * worse than a retryable error. The Convex mutation is idempotent,
 * so client retries are safe.
 *
 * Throws on any failure; caller translates to 503.
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

export default async function handler(req: Request): Promise<Response> {
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
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  // Bind the code to the userId in Convex BEFORE returning the share
  // URL. If the binding can't be persisted (Convex outage, missing
  // env, non-2xx) we must NOT hand the user a link that the waitlist
  // mutation can never resolve — a dead share link is worse than a
  // retryable error. The mutation is idempotent so client retries
  // are safe.
  try {
    await registerReferralCodeInConvex(session.userId, code);
  } catch (err) {
    console.error('[api/referral/me] binding failed:', (err as Error).message);
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

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
