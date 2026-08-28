/**
 * Notification publish endpoint.
 *
 * POST /api/notify — validates Clerk JWT, publishes event to Upstash wm:events:notify channel
 *
 * Authentication: Clerk Bearer token in Authorization header.
 * Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN env vars.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
import {
  beginStandaloneIdempotency,
  completeStandaloneIdempotency,
  getIdempotencyKey,
  peekStandaloneIdempotency,
} from './_idempotency.js';
import { validateBearerToken } from '../server/auth-session';
import { checkTierProEntitlement } from '../server/_shared/pro-entitlement';
import {
  RATE_LIMIT_DEGRADED_HEADERS,
  checkScopedRateLimit,
  scopedTooManyRequestsResponse,
} from '../server/_shared/rate-limit';

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const INTERNAL_EVENT_TYPES = new Set(['flush_quiet_held', 'channel_welcome', 'watchlist_story_alert']);

// Publishes create relay-side delivery obligations and LPUSH onto the SHARED
// wm:events:queue, so unlike low-stakes reads this limiter must bound both
// rate and payload size (user-prefs.ts is the contract reference).
export const NOTIFY_WRITE_RATE_LIMIT = 30;
export const NOTIFY_WRITE_RATE_SCOPE = 'notify-write';
export const NOTIFY_WRITE_RATE_WINDOW = '60 s' as const;
export const NOTIFY_MAX_PAYLOAD_BYTES = 16 * 1024;

type NotifyDeps = {
  validateBearerToken: typeof validateBearerToken;
  checkTierProEntitlement: typeof checkTierProEntitlement;
  checkScopedRateLimit: typeof checkScopedRateLimit;
};

function createDefaultNotifyDeps(): NotifyDeps {
  return {
    validateBearerToken,
    checkTierProEntitlement,
    checkScopedRateLimit,
  };
}

let notifyDeps = createDefaultNotifyDeps();

export function __setNotifyDepsForTests(overrides: Partial<NotifyDeps> | null): void {
  notifyDeps = overrides
    ? { ...createDefaultNotifyDeps(), ...overrides }
    : createDefaultNotifyDeps();
}

function notifyTooManyRequestsResponse(
  scoped: Awaited<ReturnType<typeof checkScopedRateLimit>>,
  cors: Record<string, string>,
): Response {
  const shared = scopedTooManyRequestsResponse(scoped, NOTIFY_WRITE_RATE_WINDOW, cors);
  return new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
    status: shared.status,
    headers: shared.headers,
  });
}

export function isInternalNotifyEventType(eventType: string): boolean {
  return INTERNAL_EVENT_TYPES.has(eventType);
}

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const session = await notifyDeps.validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const proAccess = await notifyDeps.checkTierProEntitlement(session.userId, cors);
  if (!proAccess.allowed) {
    // #5600: an entitlement the backend could not VERIFY is not a confirmed
    // free user. Answer the shared retryable contract (503 + Retry-After) for
    // those states before falling back to the terminal upsell. Note this covers
    // lookup failure and renewal verification only — the day-0 poisoned-marker
    // cohort arrives as a plain tier-0 answer and still gets the 403; that
    // window is bounded by NOT_APPLICABLE_VERIFICATION_TTL_SECONDS instead.
    const { billingDenial } = proAccess;
    if (billingDenial) return billingDenial;
    return jsonResponse({ error: 'pro_required', message: 'Event publishing is available on the Pro plan.', upgradeUrl: 'https://worldmonitor.app/pro' }, 403, cors);
  }

  const idempotencyKey = getIdempotencyKey(req);
  if (idempotencyKey) {
    const peek = await peekStandaloneIdempotency({
      request: req,
      pathname: '/api/notify',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    });
    if (peek.kind !== 'miss' && peek.kind !== 'disabled') {
      return peek.response;
    }
  }

  const scoped = await notifyDeps.checkScopedRateLimit(
    NOTIFY_WRITE_RATE_SCOPE,
    NOTIFY_WRITE_RATE_LIMIT,
    NOTIFY_WRITE_RATE_WINDOW,
    session.userId,
  );
  // Unlike user-prefs, a limiter outage here should NOT fail open: each
  // accepted publish fans out to relay subscribers. A limiter outage is a
  // retryable 503, while a confirmed quota denial remains a 429.
  if (scoped.degraded) {
    return jsonResponse(
      { error: 'Rate-limit service temporarily unavailable' },
      503,
      { ...cors, ...RATE_LIMIT_DEGRADED_HEADERS },
    );
  }
  if (!scoped.allowed) {
    return notifyTooManyRequestsResponse(scoped, cors);
  }

  // Preserve an untouched request for body hashing. The claim intentionally
  // remains after validation, so malformed payloads cannot occupy a key.
  const idempotencyRequest = req.clone();
  let body: { eventType?: unknown; payload?: unknown; severity?: unknown; variant?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }

  if (typeof body.eventType !== 'string' || !body.eventType || body.eventType.length > 64) {
    return jsonResponse({ error: 'eventType required (string, max 64 chars)' }, 400, cors);
  }

  // Reject internal relay control events. These are dispatched by Railway
  // cron scripts (seed-digest-notifications, quiet-hours) and must never be
  // user-submittable. flush_quiet_held would let a Pro user force-drain their
  // held queue on demand, bypassing batch_on_wake behaviour. watchlist_story_alert
  // is produced by the digest scanner after ticker extraction, importance gating,
  // and scan dedup; user-submitted copies would bypass that pipeline.
  if (isInternalNotifyEventType(body.eventType)) {
    return jsonResponse({ error: 'Reserved event type' }, 403, cors);
  }

  // Bound the serialized event before it reaches the shared queue.
  if (new TextEncoder().encode(JSON.stringify(body)).length > NOTIFY_MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: `payload too large (max ${NOTIFY_MAX_PAYLOAD_BYTES} bytes)` }, 413, cors);
  }

  if (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) {
    return jsonResponse({ error: 'payload must be an object' }, 400, cors);
  }

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!upstashUrl || !upstashToken) {
    return jsonResponse({ error: 'Service unavailable' }, 503, cors);
  }

  const idempotency = idempotencyKey
    ? await beginStandaloneIdempotency({
      request: idempotencyRequest,
      pathname: '/api/notify',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    })
    : null;
  if (
    idempotency &&
    idempotency.kind !== 'proceed' &&
    idempotency.kind !== 'disabled'
  ) {
    return idempotency.response;
  }

  const { eventType } = body;

  // Strip relay-internal scoring fields from user-supplied payload. These are
  // computed server-side by the relay's importanceScore pipeline; allowing
  // user-supplied values would let a Pro user bypass the IMPORTANCE_SCORE_MIN
  // gate and fan out arbitrary alerts to every subscriber.
  const payload = { ...(body.payload as Record<string, unknown>) };
  delete payload.importanceScore;
  delete payload.corroborationCount;

  const rawSeverity = typeof body.severity === 'string' ? body.severity : 'high';
  const severity = VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : 'high';
  const variant = typeof body.variant === 'string' ? body.variant : undefined;

  const msg = JSON.stringify({
    eventType,
    payload,
    severity,
    variant,
    publishedAt: Date.now(),
    userId: session.userId,
  });

  const res = await fetch(
    `${upstashUrl}/lpush/wm:events:queue/${encodeURIComponent(msg)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${upstashToken}`, 'User-Agent': 'worldmonitor-edge/1.0' } },
  );

  if (!res.ok) {
    return completeStandaloneIdempotency(idempotency, jsonResponse({ error: 'Publish failed' }, 502, cors));
  }

  return completeStandaloneIdempotency(idempotency, jsonResponse({ ok: true }, 200, cors));
}
