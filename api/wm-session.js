// POST /api/wm-session — issues short-lived HttpOnly session cookies for
// browser access. Anonymous sessions get an HMAC-signed wms_ token cookie; if a
// caller submits legacy tester keys during migration, those keys are moved into
// short-lived HttpOnly cookies so they stop living in JS-readable storage.

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { checkRateLimit } from './_rate-limit.js';
import { issueSessionToken } from './_session.js';

export const config = { runtime: 'edge' };

const SESSION_COOKIE = 'wm-session';
const WIDGET_KEY_COOKIE = 'wm-widget-key';
const PRO_KEY_COOKIE = 'wm-pro-key';
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const LEGACY_KEY_MAX_LEN = 512;

function jsonResponse(body, status, headers) {
  const out = headers instanceof Headers ? headers : new Headers(headers);
  out.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), {
    status,
    headers: out,
  });
}

function appendHeader(headers, name, value) {
  const next = new Headers(headers);
  next.append(name, value);
  return next;
}

function shouldUseSharedCookieDomain(req) {
  const host = (req.headers.get('host') || new URL(req.url).hostname).toLowerCase();
  return host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app');
}

function cookieDomainAttribute(req) {
  return shouldUseSharedCookieDomain(req) ? '; Domain=.worldmonitor.app' : '';
}

function sessionCookie(req, name, value) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}${cookieDomainAttribute(req)}; HttpOnly; Secure; SameSite=Lax`;
}

function clearReadableCookie(name) {
  return `${name}=; Domain=.worldmonitor.app; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}

function normalizeLegacyKey(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LEGACY_KEY_MAX_LEN) return '';
  return trimmed;
}

async function readBody(req) {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return {};
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export default async function handler(req) {
  if (isDisallowedOrigin(req)) {
    return new Response('Forbidden', { status: 403 });
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  // Rate-limit per IP. Without this, an attacker can farm tokens cheaply.
  // Token TTL is 12h, so a sustained ~1 RPS yields 86400 tokens/day per IP —
  // the existing IP cap (600/min) keeps that bounded.
  const rl = await checkRateLimit(req, cors);
  if (rl) return rl;

  let issued;
  try {
    issued = await issueSessionToken();
  } catch {
    // WM_SESSION_SECRET missing — fail closed. 503 signals "configure me",
    // not "you're rejected." Operator-visible.
    return jsonResponse({ error: 'Session service not configured' }, 503, cors);
  }

  const body = await readBody(req);
  const widgetKey = normalizeLegacyKey(body.widgetKey);
  const proKey = normalizeLegacyKey(body.proKey);

  let headers = appendHeader(cors, 'Set-Cookie', sessionCookie(req, SESSION_COOKIE, issued.token));
  if (widgetKey) headers = appendHeader(headers, 'Set-Cookie', sessionCookie(req, WIDGET_KEY_COOKIE, widgetKey));
  if (proKey) headers = appendHeader(headers, 'Set-Cookie', sessionCookie(req, PRO_KEY_COOKIE, proKey));

  // Best-effort cleanup for the old JS-readable cookies with the same names.
  // HttpOnly cookies cannot be cleared from JS; setting these tombstones from
  // the server removes any legacy non-HttpOnly variants the browser still has.
  headers = appendHeader(headers, 'Set-Cookie', clearReadableCookie(WIDGET_KEY_COOKIE));
  headers = appendHeader(headers, 'Set-Cookie', clearReadableCookie(PRO_KEY_COOKIE));

  return jsonResponse({ ok: true, exp: issued.exp }, 200, headers);
}
