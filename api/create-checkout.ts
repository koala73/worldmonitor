/**
 * Checkout session creation edge gateway.
 *
 * Thin auth proxy: validates Clerk bearer token, then relays to the
 * Convex /relay/create-checkout HTTP action which runs the actual
 * Dodo checkout session creation with all validation (returnUrl
 * allowlist, HMAC signing, customer prefill).
 *
 * Used by both the /pro marketing page and the main dashboard.
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

  // Validate Clerk bearer token
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, cors);

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  // Parse request body
  let body: {
    productId?: string;
    returnUrl?: string;
    discountCode?: string;
    referralCode?: string;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400, cors);
  }

  if (!body.productId || typeof body.productId !== 'string') {
    return json({ error: 'productId is required' }, 400, cors);
  }

  if (!CONVEX_SITE_URL || !RELAY_SHARED_SECRET) {
    return json({ error: 'Service unavailable' }, 503, cors);
  }

  // Relay to Convex
  try {
    const resp = await fetch(`${CONVEX_SITE_URL}/relay/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RELAY_SHARED_SECRET}`,
      },
      body: JSON.stringify({
        userId: session.userId,
        email: session.email,
        name: session.name,
        productId: body.productId,
        returnUrl: body.returnUrl,
        discountCode: body.discountCode,
        referralCode: body.referralCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('[create-checkout] Relay error:', resp.status, data);
      if (resp.status === 409) {
        return json({
          error: data?.error || 'ACTIVE_SUBSCRIPTION_EXISTS',
          message: data?.message || 'An active subscription already exists for this account.',
          subscription: data?.subscription,
        }, 409, cors);
      }
      return json({ error: data?.error || 'Checkout creation failed' }, 502, cors);
    }

    return json(data, 200, cors);
  } catch (err) {
    console.error('[create-checkout] Relay failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/create-checkout', step: 'relay' }, ctx });
    return json({ error: 'Checkout service unavailable' }, 502, cors);
  }
}
