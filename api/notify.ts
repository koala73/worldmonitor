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
import { validateBearerToken } from '../server/auth-session';
import { getEntitlements } from '../server/_shared/entitlement-check';

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const INTERNAL_EVENT_TYPES = new Set(['flush_quiet_held', 'channel_welcome']);

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

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const ent = await getEntitlements(session.userId);
  if (!ent || ent.features.tier < 1) {
    return jsonResponse({ error: 'pro_required', message: 'Event publishing is available on the Pro plan.', upgradeUrl: 'https://worldmonitor.app/pro' }, 403, cors);
  }

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
  // held queue on demand, bypassing batch_on_wake behaviour.
  if (INTERNAL_EVENT_TYPES.has(body.eventType)) {
    return jsonResponse({ error: 'Reserved event type' }, 403, cors);
  }

  if (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) {
    return jsonResponse({ error: 'payload must be an object' }, 400, cors);
  }

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!upstashUrl || !upstashToken) {
    return jsonResponse({ error: 'Service unavailable' }, 503, cors);
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
    return jsonResponse({ error: 'Publish failed' }, 502, cors);
  }

  return jsonResponse({ ok: true }, 200, cors);
}
