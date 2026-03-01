export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

/**
 * POST /api/book-request
 *
 * Accepts a book-generation request from the WorldMonitor codexes variant
 * or xcu_my_apps Streamlit page.
 *
 * Body:
 *   eventId      — clustered-event identifier
 *   title        — event headline
 *   flavor       — 'lite-briefing' | 'deep-history' | 'deep-technical' | 'executive-summary'
 *   score        — book-worthiness score 0-100
 *   rationale    — scoring rationale string
 *   notes        — optional user notes
 *   category     — event category (conflict, cyber, …)
 *   threatLevel  — event threat level
 *   sourceCount  — number of corroborating sources
 *   link         — primary source URL
 *
 * Response:
 *   { requestId, status: 'pending' }
 *
 * Side-effects:
 *   - Stores request in Upstash Redis (pending queue)
 *   - Sends webhook notification for approval (configurable)
 */

const VALID_FLAVORS = new Set([
  'lite-briefing',
  'deep-history',
  'deep-technical',
  'executive-summary',
]);

const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function generateRequestId() {
  return `br_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default async function handler(req) {
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // --- Validate required fields ---
  const { title, flavor, score, notes, category, threatLevel, sourceCount, link, eventId } = body;

  if (!title || typeof title !== 'string' || title.length > 500) {
    return new Response(JSON.stringify({ error: 'Invalid or missing title' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (!flavor || !VALID_FLAVORS.has(flavor)) {
    return new Response(JSON.stringify({ error: `Invalid flavor. Must be one of: ${[...VALID_FLAVORS].join(', ')}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const requestId = generateRequestId();
  const requestPayload = {
    requestId,
    eventId: eventId || null,
    title,
    flavor,
    score: typeof score === 'number' ? score : null,
    rationale: body.rationale || null,
    notes: typeof notes === 'string' ? notes.slice(0, 2000) : null,
    category: category || null,
    threatLevel: threatLevel || null,
    sourceCount: typeof sourceCount === 'number' ? sourceCount : null,
    link: typeof link === 'string' ? link : null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ip,
  };

  // --- Store in Redis (if configured) ---
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    try {
      // Store with 7-day TTL
      await fetch(`${redisUrl}/SET/book-request:${requestId}/${encodeURIComponent(JSON.stringify(requestPayload))}/EX/604800`, {
        headers: { Authorization: `Bearer ${redisToken}` },
      });
      // Add to pending list
      await fetch(`${redisUrl}/LPUSH/book-requests:pending/${requestId}`, {
        headers: { Authorization: `Bearer ${redisToken}` },
      });
    } catch (err) {
      console.error('[book-request] Redis error:', err);
      // Continue — the request was received even if persistence failed
    }
  }

  // --- Send webhook notification (if configured) ---
  const webhookUrl = process.env.BOOK_REQUEST_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `New book request: "${title}" (${flavor}, score ${score ?? '?'})`,
          requestId,
          ...requestPayload,
        }),
      });
    } catch (err) {
      console.error('[book-request] Webhook error:', err);
    }
  }

  return new Response(
    JSON.stringify({ requestId, status: 'pending' }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    },
  );
}
