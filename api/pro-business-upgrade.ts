// POST: a signed-in /pro visitor (Clerk bearer) previews or applies the
// in-place Pro → Pro Business upgrade. Body: { confirm: boolean }.
// confirm=false returns the prorated charge; confirm=true moves the existing
// Dodo subscription to the Pro Business product. The dashboard calls the
// Convex action directly; this edge route exists because /pro is a separate
// build without a Convex client.
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
import { validateBearerToken } from '../server/auth-session';

const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const CONVEX_TENANT_RELAY_SECRET = process.env.CONVEX_TENANT_RELAY_SECRET ?? '';
const UPGRADE_RELAY_USER_AGENT = 'worldmonitor-pro-business-upgrade-edge/1.0';

/** Refusals the client turns into copy; everything else is a generic failure. */
const PASSTHROUGH_ERRORS = new Set([
  'NO_UPGRADEABLE_PRO',
  'ALREADY_PRO_BUSINESS',
  'PRO_CANCEL_SCHEDULED',
  'UPGRADE_IN_PROGRESS',
  'UPGRADE_RATE_LIMITED',
  'ACCOUNT_DELETION_IN_PROGRESS',
  'DODO_PLAN_CHANGE_ERROR',
]);

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
    return json({ error: 'Method not allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, cors);

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  let confirm: boolean;
  try {
    // Read a clone: the idempotency helpers hash the original body, and a
    // consumed body would make them fall back to "disabled" (no replay lock).
    const body = await req.clone().json() as { confirm?: unknown } | null;
    if (!body || typeof body !== 'object' || typeof body.confirm !== 'boolean') {
      return json({ error: 'INVALID_BODY' }, 400, cors);
    }
    confirm = body.confirm;
  } catch {
    return json({ error: 'INVALID_JSON' }, 400, cors);
  }

  const idempotencyKey = getIdempotencyKey(req);
  const idempotencyOptions = idempotencyKey ? {
    request: req,
    pathname: '/api/pro-business-upgrade',
    scope: `user:${session.userId}`,
    idempotencyKey,
    corsHeaders: cors,
  } : null;
  if (idempotencyOptions) {
    const existing = await peekStandaloneIdempotency(idempotencyOptions);
    if (existing.kind !== 'miss' && existing.kind !== 'disabled') return existing.response;
  }

  const limited = await checkRateLimit(req, cors, {
    scope: 'pro-business-upgrade', identifier: session.userId, limit: 5, window: '60 s',
    failClosed: true, ctx,
  });
  if (limited) return limited;

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

  try {
    const resp = await fetch(`${CONVEX_SITE_URL}/relay/pro-business-upgrade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UPGRADE_RELAY_USER_AGENT,
        Authorization: `Bearer ${CONVEX_TENANT_RELAY_SECRET}`,
      },
      body: JSON.stringify({ userId: session.userId, confirm }),
      signal: AbortSignal.timeout(20_000),
    });

    const data = await resp.json().catch(() => ({})) as { error?: unknown };
    if (!resp.ok) {
      const code = typeof data.error === 'string' && PASSTHROUGH_ERRORS.has(data.error)
        ? data.error
        : 'Upgrade unavailable';
      console.error('[pro-business-upgrade] Relay error:', resp.status, data);
      const status = resp.status === 409 ? 409 : 502;
      return completeStandaloneIdempotency(idempotency, json({ error: code }, status, cors));
    }

    return completeStandaloneIdempotency(idempotency, json(data, 200, cors));
  } catch (err) {
    console.error('[pro-business-upgrade] Relay failed:', (err as Error).message);
    captureSilentError(err, {
      tags: { route: 'api/pro-business-upgrade', step: 'relay' },
      fingerprint: ['api/pro-business-upgrade', 'relay', err instanceof Error ? err.name : 'Error'],
      ctx,
    });
    return completeStandaloneIdempotency(idempotency, json({ error: 'Upgrade unavailable' }, 502, cors));
  }
}
