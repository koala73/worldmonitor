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

  // No invite/conversion count is returned. The earlier draft of
  // this endpoint read `registrations.referredBy`, but the live
  // `/pro?ref=<code>` flow feeds the ref into Dodopayments checkout
  // metadata (`affonso_referral`), NOT into registrations — so that
  // count would stay at 0 for anyone who converted direct-to-checkout
  // without filling the waitlist form. Rather than ship a misleading
  // "N invited" display, the count is deliberately omitted until the
  // two attribution paths (waitlist + Dodo metadata) are unified in
  // a follow-up. The share button itself works without metrics.
  return jsonResponse(
    {
      code,
      shareUrl: buildShareUrl(PUBLIC_BASE, code),
    },
    200,
    cors,
  );
}
