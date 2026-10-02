/**
 * POST /api/embed/session?panel=
 *
 * Exchanges the partner's `wme_` embed key for a short-lived, panel-scoped
 * `wmg_` grant. The frame calls this ONCE at boot (and again when the grant
 * expires), then polls `/api/embed/map-frame` with the grant instead of the
 * key — see server/_shared/embed-grant.ts for why the key must not ride every
 * poll.
 *
 * Keyed to the embedding account's key, never to the page visitor's cookies
 * or anonymous session token, exactly like the entitlement endpoint beside it.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import { checkEndpointRateLimit } from '../../server/_shared/rate-limit';
import { getEntitlements, isEntitlementBackendConfigured } from '../../server/_shared/entitlement-check';
import { validateEmbedKey } from '../../server/_shared/embed-key';
import { mintEmbedGrant } from '../../server/_shared/embed-grant';
import { evaluateEmbedSession } from '../../server/_shared/embed-session';
import { lookupClerkPlan } from '../../server/auth-session';

const SESSION_PATH = '/api/embed/session';

function requestWithoutCookies(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.delete('cookie');
  return new Request(req, { headers });
}

function embedKeyFromHeaders(headers: Headers): string | null {
  const key = (headers.get('X-WorldMonitor-Key') ?? headers.get('X-Api-Key') ?? '').trim();
  return key || null;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  // `no-store` is not optional here: the response body is a bearer credential,
  // so a shared cache holding it would hand one partner's grant to the next.
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ granted: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'POST, OPTIONS' },
    });
  }

  const limited = await checkEndpointRateLimit(req, SESSION_PATH, cors);
  if (limited) return limited;

  const stripped = requestWithoutCookies(req);
  const url = new URL(stripped.url);
  const result = await evaluateEmbedSession(
    url.searchParams.get('panel'),
    embedKeyFromHeaders(stripped.headers),
    {
      validateEmbedKey,
      getEntitlements,
      getAccountPlan: lookupClerkPlan,
      isEntitlementBackendConfigured,
      mintGrant: (claims) => mintEmbedGrant(claims),
      now: () => Date.now(),
    },
  );

  const headers: Record<string, string> = { ...jsonHeaders };
  if (result.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(result.retryAfterSeconds);
  }
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}
