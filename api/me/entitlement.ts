/**
 * GET /api/me/entitlement
 *
 * Returns { isPro: boolean } for the caller based on the same two-signal
 * check used by every premium gate in the codebase (Clerk pro role OR
 * Convex Dodo entitlement tier >= 1).
 *
 * Exists so the /pro marketing bundle (pro-test/) can swap its upgrade
 * CTAs for "Go to dashboard" affordances without pulling in a full
 * Convex client or reimplementing the two-signal check in a third place.
 *
 * Status code discipline:
 *   - 200 { isPro: true|false }  — bearer validated; user is pro or free
 *   - 401 { error: "unauthenticated" } — no bearer, malformed bearer, or
 *     invalid/expired Clerk session. Distinguishing this from the free-
 *     tier case matters for observability: a `/pro` auth regression
 *     would otherwise be indistinguishable from normal free-tier traffic.
 *     The /pro client treats any non-200 as `isPro: false` (safe default).
 *
 * Cacheable per-request but NOT shared: Cache-Control private, no-store.
 * A user's entitlement changes when Dodo webhooks fire, and /pro reads
 * it on every page load — caching at the edge would serve stale state.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import { isCallerPremium } from '../../server/_shared/premium-check';
import { validateBearerToken } from '../../server/auth-session';

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  const commonJsonHeaders = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...commonJsonHeaders, Allow: 'GET, OPTIONS' },
    });
  }

  // Validate bearer BEFORE calling isCallerPremium so we can distinguish
  // "no/invalid auth" from "auth ok but free tier." isCallerPremium
  // itself fails closed (returns false for bad auth), which is safe but
  // collapses both cases into identical 200 { isPro: false } responses —
  // a /pro auth regression would read like normal free-tier traffic in
  // the edge logs. Requiring a valid bearer here surfaces that regression
  // as a 4xx surge instead.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401, headers: commonJsonHeaders,
    });
  }
  const session = await validateBearerToken(authHeader.slice(7));
  if (!session.valid) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401, headers: commonJsonHeaders,
    });
  }

  // Bearer is valid — delegate to the canonical two-signal check for the
  // actual entitlement verdict (covers Clerk role AND Convex tier).
  const isPro = await isCallerPremium(req);
  return new Response(JSON.stringify({ isPro }), {
    status: 200, headers: commonJsonHeaders,
  });
}
