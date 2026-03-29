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

  let body: { eventType?: unknown; payload?: unknown; severity?: unknown; variant?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }

  if (typeof body.eventType !== 'string' || !body.eventType || body.eventType.length > 64) {
    return jsonResponse({ error: 'eventType required (string, max 64 chars)' }, 400, cors);
  }

  if (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) {
    return jsonResponse({ error: 'payload must be an object' }, 400, cors);
  }

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!upstashUrl || !upstashToken) {
    return jsonResponse({ error: 'Service unavailable' }, 503, cors);
  }

  const { eventType, payload } = body;
  const severity = typeof body.severity === 'string' ? body.severity : 'high';
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
    `${upstashUrl}/publish/wm:events:notify/${encodeURIComponent(msg)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${upstashToken}` } },
  );

  if (!res.ok) {
    return jsonResponse({ error: 'Publish failed' }, 502, cors);
  }

  return jsonResponse({ ok: true }, 200, cors);
}
