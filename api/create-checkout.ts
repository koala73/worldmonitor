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
import {
  beginStandaloneIdempotency,
  completeStandaloneIdempotency,
  getIdempotencyKey,
} from './_idempotency.js';
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
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

  const idempotencyRequest = req.clone();

  // Parse request body
  let body: {
    productId?: string;
    returnUrl?: string;
    discountCode?: string;
    referralCode?: string;
    bypassPendingGuard?: boolean;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400, cors);
  }

  if (!body.productId || typeof body.productId !== 'string') {
    return json({ error: 'productId is required' }, 400, cors);
  }

  const idempotencyKey = getIdempotencyKey(req);
  const idempotency = idempotencyKey
    ? await beginStandaloneIdempotency({
      request: idempotencyRequest,
      pathname: '/api/create-checkout',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
      completedTtlSeconds: 10 * 60,
    })
    : null;
  if (
    idempotency &&
    idempotency.kind !== 'proceed' &&
    idempotency.kind !== 'disabled'
  ) {
    return idempotency.response;
  }

  if (!CONVEX_SITE_URL || !RELAY_SHARED_SECRET) {
    return completeStandaloneIdempotency(idempotency, json({ error: 'Service unavailable' }, 503, cors));
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
        bypassPendingGuard: body.bypassPendingGuard,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('[create-checkout] Relay error:', resp.status, data);
      if (resp.status === 409) {
        // Two distinct blocks share 409; the client discriminates on `error`
        // (ACTIVE_SUBSCRIPTION_EXISTS vs PAYMENT_IN_PROGRESS, #4438). Forward
        // whichever context object the relay attached. Neutral fallback: the
        // relay always sets `error: result.code`, but defaulting a missing code
        // to ACTIVE_SUBSCRIPTION_EXISTS would silently misroute a PAYMENT_IN_PROGRESS
        // (or any future) block to the wrong dialog — so fall back to a generic
        // code that the client classifies as a neutral block, not a duplicate sub.
        return completeStandaloneIdempotency(idempotency, json({
          error: data?.error ?? 'CHECKOUT_BLOCKED',
          message: data?.message ?? 'This checkout could not be started.',
          subscription: data?.subscription,
          pendingPayment: data?.pendingPayment,
        }, 409, cors));
      }
      return completeStandaloneIdempotency(idempotency, json({ error: data?.error || 'Checkout creation failed' }, 502, cors));
    }

    return completeStandaloneIdempotency(idempotency, json(data, 200, cors));
  } catch (err) {
    console.error('[create-checkout] Relay failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/create-checkout', step: 'relay' }, ctx });
    return completeStandaloneIdempotency(idempotency, json({ error: 'Checkout service unavailable' }, 502, cors));
  }
}
