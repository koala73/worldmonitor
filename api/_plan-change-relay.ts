// Shared edge handler for the /pro in-place plan changes. Each plan change has
// its own route at both hops (api/pro-business-upgrade.ts →
// /relay/pro-business-upgrade, api/pro-annual-switch.ts →
// /relay/pro-annual-switch), so a deployment that predates a change answers 404
// for it instead of running another one. The routes differ only in the body
// they accept and where they relay; auth, idempotency, the limiter call, the
// relay abort and the refusal passthrough are the same.

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
import { validateBearerToken } from '../server/auth-session';

const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const CONVEX_TENANT_RELAY_SECRET = process.env.CONVEX_TENANT_RELAY_SECRET ?? '';

/**
 * Under the Edge runtime's 25 s first-response cap, and above a confirm's
 * worst case in Convex (PLAN_CHANGE_CONFIRM_WORST_CASE_MS, 21 s) plus the hop,
 * so a switch that went through is not reported as failed.
 */
export const PLAN_CHANGE_RELAY_ABORT_MS = 23_000;

/** One budget per user across both plan changes, as when one route served both. */
export const PLAN_CHANGE_RATE_LIMIT = {
  scope: 'pro-business-upgrade',
  limit: 5,
  window: '60 s',
  failClosed: true,
} as const;

/** Refusals the client turns into copy; everything else is a generic failure. */
const PASSTHROUGH_ERRORS = new Set([
  'NO_UPGRADEABLE_PRO',
  'ALREADY_PRO_BUSINESS',
  'PRO_CANCEL_SCHEDULED',
  'UPGRADE_IN_PROGRESS',
  'UPGRADE_RATE_LIMITED',
  'ACCOUNT_DELETION_IN_PROGRESS',
  'DODO_PLAN_CHANGE_ERROR',
  'ALREADY_PRO_ANNUAL',
  'PROMO_ENDED',
  'PROMO_CODE_REJECTED',
  'CHARGE_CHANGED',
]);

type EdgeCtx = { waitUntil: (p: Promise<unknown>) => void };

export interface PlanChangeRoute {
  /** Public path; also the idempotency scope. */
  pathname: string;
  /** Convex HTTP route this edge route relays to. */
  relayPath: string;
  /** Fixed route name for logs and the Sentry fingerprint. */
  routeName: string;
  userAgent: string;
  /** The fields to forward after `userId`, or null to answer INVALID_BODY. Runs before any limiter or relay call. */
  parseBody: (body: Record<string, unknown>) => Record<string, unknown> | null;
  /** The route's own limiter call, so the rate-limit audit sees it in the route file. */
  rateLimit: (req: Request, cors: Record<string, string>, userId: string, ctx?: EdgeCtx) => Promise<Response | null>;
}

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

export function createPlanChangeHandler(route: PlanChangeRoute) {
  return async function handler(req: Request, ctx?: EdgeCtx): Promise<Response> {
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

    let forward: Record<string, unknown>;
    try {
      // Read a clone: the idempotency helpers hash the original body, and a
      // consumed body would make them fall back to "disabled" (no replay lock).
      const body = await req.clone().json() as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: 'INVALID_BODY' }, 400, cors);
      }
      const parsed = route.parseBody(body as Record<string, unknown>);
      if (!parsed) return json({ error: 'INVALID_BODY' }, 400, cors);
      forward = parsed;
    } catch {
      return json({ error: 'INVALID_JSON' }, 400, cors);
    }

    const idempotencyKey = getIdempotencyKey(req);
    const idempotencyOptions = idempotencyKey ? {
      request: req,
      pathname: route.pathname,
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    } : null;
    if (idempotencyOptions) {
      const existing = await peekStandaloneIdempotency(idempotencyOptions);
      if (existing.kind !== 'miss' && existing.kind !== 'disabled') return existing.response;
    }

    const limited = await route.rateLimit(req, cors, session.userId, ctx);
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
      const resp = await fetch(`${CONVEX_SITE_URL}${route.relayPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': route.userAgent,
          Authorization: `Bearer ${CONVEX_TENANT_RELAY_SECRET}`,
        },
        body: JSON.stringify({ userId: session.userId, ...forward }),
        signal: AbortSignal.timeout(PLAN_CHANGE_RELAY_ABORT_MS),
      });

      // Only a refusal's body is read best-effort. A success body that cannot be
      // read throws to the 502 below, so a cut-off reply is never stored or
      // returned as a 200.
      const data = (resp.ok ? await resp.json() : await resp.json().catch(() => ({}))) as { error?: unknown };
      if (!resp.ok) {
        // A Convex deployment without this route answers 404: a generic
        // failure, so nothing is retried elsewhere.
        const code = typeof data.error === 'string' && PASSTHROUGH_ERRORS.has(data.error)
          ? data.error
          : 'Upgrade unavailable';
        console.error(`[${route.routeName}] Relay error:`, resp.status, data);
        const status = resp.status === 409 ? 409 : 502;
        return completeStandaloneIdempotency(idempotency, json({ error: code }, status, cors));
      }

      return completeStandaloneIdempotency(idempotency, json(data, 200, cors));
    } catch (err) {
      console.error(`[${route.routeName}] Relay failed:`, (err as Error).message);
      captureSilentError(err, {
        tags: { route: `api/${route.routeName}`, step: 'relay' },
        fingerprint: [`api/${route.routeName}`, 'relay', err instanceof Error ? err.name : 'Error'],
        ctx,
      });
      return completeStandaloneIdempotency(idempotency, json({ error: 'Upgrade unavailable' }, 502, cors));
    }
  };
}
