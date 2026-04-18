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

  // Invited count: registrations rows that used this code as
  // `referredBy`. Convex query is keyed by that field — see
  // convex/registerInterest.ts for the schema.
  // The count lookup is best-effort: a Convex outage shouldn't stop
  // the user from copying the share link, so we default to 0 and log.
  let invitedCount = 0;
  try {
    const convexSite =
      process.env.CONVEX_SITE_URL ??
      (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
    const relaySecret = process.env.RELAY_SHARED_SECRET ?? '';
    if (convexSite && relaySecret) {
      const res = await fetch(`${convexSite}/relay/referral-stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${relaySecret}`,
          'User-Agent': 'worldmonitor-edge/1.0',
        },
        body: JSON.stringify({ referralCode: code }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { invitedCount?: number };
        if (typeof data.invitedCount === 'number') invitedCount = data.invitedCount;
      }
    }
  } catch (err) {
    console.warn('[api/referral/me] stats fetch failed:', (err as Error).message);
  }

  return jsonResponse(
    {
      code,
      shareUrl: buildShareUrl(PUBLIC_BASE, code),
      invitedCount,
    },
    200,
    cors,
  );
}
