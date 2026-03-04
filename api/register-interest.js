export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_META_LENGTH = 100;

const rateLimitMap = new Map();
const RATE_LIMIT = 5;
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

  // x-real-ip is injected by Vercel from the TCP connection and cannot be spoofed by
  // clients. x-forwarded-for is client-settable and MUST NOT be the primary source for
  // rate limiting — an attacker can rotate arbitrary values to bypass the limit entirely.
  const ip =
    req.headers.get('x-real-ip') ||
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
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

  const { email, source, appVersion } = body;
  if (!email || typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email address' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // Coerce metadata fields to strings and enforce length caps to prevent
  // non-string values (objects/arrays are truthy and bypass `|| 'unknown'`)
  // from being forwarded to the database as wrong types, and to prevent
  // arbitrarily large payloads filling the registrations table.
  const safeSource = typeof source === 'string'
    ? source.slice(0, MAX_META_LENGTH)
    : 'unknown';
  const safeAppVersion = typeof appVersion === 'string'
    ? appVersion.slice(0, MAX_META_LENGTH)
    : 'unknown';

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    return new Response(JSON.stringify({ error: 'Registration service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    const result = await client.mutation('registerInterest:register', {
      email,
      source: safeSource,
      appVersion: safeAppVersion,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (err) {
    console.error('[register-interest] Convex error:', err);
    return new Response(JSON.stringify({ error: 'Registration failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
