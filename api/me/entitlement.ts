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
 * Cacheable per-request but NOT shared: Cache-Control private, no-store.
 * A user's entitlement changes when Dodo webhooks fire, and /pro reads
 * it on every page load — caching at the edge would serve stale state.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import { isCallerPremium } from '../../server/_shared/premium-check';

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', Allow: 'GET, OPTIONS' },
    });
  }

  const isPro = await isCallerPremium(req);
  return new Response(JSON.stringify({ isPro }), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });
}
