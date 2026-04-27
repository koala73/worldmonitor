/**
 * Customer portal edge gateway.
 *
 * Thin auth proxy: validates Clerk bearer token, then relays to the
 * Convex /relay/customer-portal HTTP action which creates a user-scoped
 * Dodo customer portal session.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import { validateBearerToken } from '../server/auth-session';

const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET ?? '';

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const cors = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, cors);

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  if (!CONVEX_SITE_URL || !RELAY_SHARED_SECRET) {
    return json({ error: 'Service unavailable' }, 503, cors);
  }

  try {
    const resp = await fetch(`${CONVEX_SITE_URL}/relay/customer-portal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RELAY_SHARED_SECRET}`,
      },
      body: JSON.stringify({ userId: session.userId }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[customer-portal] Relay error:', resp.status, data);
      return json({ error: data?.error || 'Customer portal unavailable' }, resp.status === 404 ? 404 : 502, cors);
    }

    return json(data, 200, cors);
  } catch (err) {
    console.error('[customer-portal] Relay failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/customer-portal', step: 'relay' }, ctx });
    return json({ error: 'Customer portal unavailable' }, 502, cors);
  }
}
