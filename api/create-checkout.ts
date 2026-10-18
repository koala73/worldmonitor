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
  peekStandaloneIdempotency,
} from './_idempotency.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { CHECKOUT_PER_IP_RATE_POLICY, ENDPOINT_RATE_POLICIES } from '../server/_shared/rate-limit';
import { validateBearerToken } from '../server/auth-session';
// From the canonical shared module, not via api/mcp/upgrade — the checkout edge
// function has no reason to depend on the MCP transport tree (#6716).
import { normalizeCheckoutAttributionSource } from '../shared/mcp-attribution';
import { publicCheckoutError } from '../shared/checkout-errors';

const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const CONVEX_TENANT_RELAY_SECRET = process.env.CONVEX_TENANT_RELAY_SECRET ?? '';
const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS';
const CHECKOUT_RELAY_USER_AGENT = 'worldmonitor-checkout-edge/1.0';
const CHECKOUT_RATE_POLICY_LOOKUP = ENDPOINT_RATE_POLICIES['/api/create-checkout'];
if (!CHECKOUT_RATE_POLICY_LOOKUP) {
  throw new Error("[create-checkout] missing ENDPOINT_RATE_POLICIES['/api/create-checkout']");
}
const CHECKOUT_RATE_POLICY = CHECKOUT_RATE_POLICY_LOOKUP;

type CreateCheckoutDeps = {
  validateBearerToken: typeof validateBearerToken;
  fetch: typeof fetch;
  checkRateLimit: typeof checkRateLimit;
};

type RelayErrorBody = {
  error?: unknown;
  message?: unknown;
  subscription?: unknown;
  pendingPayment?: unknown;
};

function createDefaultCreateCheckoutDeps(): CreateCheckoutDeps {
  return {
    validateBearerToken,
    fetch: (...args) => globalThis.fetch(...args),
    checkRateLimit,
  };
}

let createCheckoutDeps: CreateCheckoutDeps = createDefaultCreateCheckoutDeps();

export function __setCreateCheckoutDepsForTests(overrides: Partial<CreateCheckoutDeps> | null): void {
  createCheckoutDeps = overrides
    ? { ...createDefaultCreateCheckoutDeps(), ...overrides }
    : createDefaultCreateCheckoutDeps();
}

function json(
  body: unknown,
  status: number,
  cors: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
      ...extraHeaders,
    },
  });
}

function checkoutBlockedBody(data: RelayErrorBody): {
  error: string;
  message: string;
  subscription: unknown;
  pendingPayment: unknown;
} {
  return {
    error: typeof data?.error === 'string' ? data.error : 'CHECKOUT_BLOCKED',
    message: typeof data?.message === 'string' ? data.message : 'This checkout could not be started.',
    subscription: data?.subscription,
    pendingPayment: data?.pendingPayment,
  };
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

  const session = await createCheckoutDeps.validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  const idempotencyRequest = req.clone();
  const idempotencyKey = getIdempotencyKey(req);
  const idempotencyOptions = idempotencyKey
    ? {
      request: idempotencyRequest,
      pathname: '/api/create-checkout',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
      completedTtlSeconds: 10 * 60,
    }
    : null;
  // A completed replay is not a new Dodo session. Peek before the limiter so
  // confirmation retries are not charged against the per-user budget.
  if (idempotencyOptions) {
    const existing = await peekStandaloneIdempotency(idempotencyOptions);
    if (existing.kind !== 'miss' && existing.kind !== 'disabled') return existing.response;
  }

  // Per-user, fail-closed. Keyed on the validated Clerk id, not the edge
  // egress IP. A Redis outage must not open the paid checkout relay.
  const limited = await createCheckoutDeps.checkRateLimit(req, cors, {
    scope: 'create-checkout',
    identifier: session.userId,
    limit: CHECKOUT_RATE_POLICY.limit,
    window: CHECKOUT_RATE_POLICY.window,
    failClosed: true,
    ctx,
  });
  if (limited) return limited;

  // Per-client-IP, fail-closed. The per-user budget cannot see one client
  // cycling many free accounts against Dodo's shared API-key rate limit.
  const ipLimited = await createCheckoutDeps.checkRateLimit(req, cors, {
    scope: 'create-checkout-ip',
    limit: CHECKOUT_PER_IP_RATE_POLICY.limit,
    window: CHECKOUT_PER_IP_RATE_POLICY.window,
    failClosed: true,
    ctx,
  });
  if (ipLimited) return ipLimited;

  // Parse request body
  let body: {
    productId?: string;
    returnUrl?: string;
    discountCode?: string;
    referralCode?: string;
    attributionSource?: string;
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

  const idempotency = idempotencyOptions
    ? await beginStandaloneIdempotency(idempotencyOptions)
    : null;
  if (
    idempotency &&
    idempotency.kind !== 'proceed' &&
    idempotency.kind !== 'disabled'
  ) {
    return idempotency.response;
  }

  if (!CONVEX_SITE_URL || !CONVEX_TENANT_RELAY_SECRET) {
    return completeStandaloneIdempotency(idempotency, json({ error: 'Service unavailable' }, 503, cors));
  }

  const attributionSource = normalizeCheckoutAttributionSource(body.attributionSource);

  // Relay to Convex
  try {
    const resp = await createCheckoutDeps.fetch(`${CONVEX_SITE_URL}/relay/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONVEX_TENANT_RELAY_SECRET}`,
        'User-Agent': CHECKOUT_RELAY_USER_AGENT,
      },
      body: JSON.stringify({
        userId: session.userId,
        email: session.email,
        name: session.name,
        productId: body.productId,
        returnUrl: body.returnUrl,
        discountCode: body.discountCode,
        referralCode: body.referralCode,
        attributionSource,
        bypassPendingGuard: body.bypassPendingGuard,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await resp.json();
    if (!resp.ok) {
      if (resp.status === 400 && data?.error === 'INVALID_CHECKOUT_PRODUCT') {
        return completeStandaloneIdempotency(
          idempotency,
          json({ error: 'INVALID_CHECKOUT_PRODUCT' }, 400, cors),
        );
      }
      if (resp.status === 429) {
        const retryAfter = resp.headers.get('retry-after');
        return completeStandaloneIdempotency(
          idempotency,
          json(
            {
              error: typeof data?.error === 'string' ? data.error : 'CHECKOUT_RATE_LIMITED',
              message: typeof data?.message === 'string'
                ? data.message
                : 'Checkout is temporarily rate limited. Retry shortly.',
            },
            429,
            cors,
            { 'Retry-After': retryAfter && /^\d{1,4}$/.test(retryAfter) ? retryAfter : '10' },
          ),
        );
      }
      if (resp.status === 409) {
        // Two distinct blocks share 409; the client discriminates on `error`
        // (ACTIVE_SUBSCRIPTION_EXISTS vs PAYMENT_IN_PROGRESS, #4438). Forward
        // whichever context object the relay attached. Neutral fallback: the
        // relay always sets `error: result.code`, but defaulting a missing code
        // to ACTIVE_SUBSCRIPTION_EXISTS would silently misroute a PAYMENT_IN_PROGRESS
        // (or any future) block to the wrong dialog — so fall back to a generic
        // code that the client classifies as a neutral block, not a duplicate sub.
        const blockedBody = checkoutBlockedBody(data as RelayErrorBody);
        if (blockedBody.error === ACTIVE_SUBSCRIPTION_EXISTS) {
          return completeStandaloneIdempotency(idempotency, json(blockedBody, 409, cors));
        }
        console.error('[create-checkout] Relay error:', resp.status, data);
        return completeStandaloneIdempotency(idempotency, json(blockedBody, 409, cors));
      }
      console.error('[create-checkout] Relay error:', resp.status, data);
      // A reached relay returning 500 is an application/provider failure. Keep
      // it distinct from an edge-to-relay fetch failure (the catch below),
      // which remains 502 and is eligible for the browser's single retry.
      const edgeStatus = resp.status === 500 ? 500 : 502;
      return completeStandaloneIdempotency(
        idempotency,
        json({ error: publicCheckoutError(data?.error) }, edgeStatus, cors),
      );
    }

    return completeStandaloneIdempotency(idempotency, json(data, 200, cors));
  } catch (err) {
    console.error('[create-checkout] Relay failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/create-checkout', step: 'relay' }, fingerprint: ['api/create-checkout', 'relay', err instanceof Error ? err.name : 'Error'], ctx });
    return completeStandaloneIdempotency(idempotency, json({ error: 'Checkout service unavailable' }, 502, cors));
  }
}
