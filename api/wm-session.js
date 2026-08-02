// POST /api/wm-session — issues short-lived HttpOnly session cookies for
// browser access. Anonymous sessions get an HMAC-signed wms_ token cookie; if a
// caller submits legacy tester keys during migration, those keys are moved into
// short-lived HttpOnly cookies so they stop living in JS-readable storage.

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { timingSafeEqualSecret, timingSafeIncludes } from './_crypto.js';
import { checkRateLimit } from './_rate-limit.js';
import { issueSessionToken, validateSessionToken } from './_session.js';
import { emitWmSessionUsage } from './_usage-telemetry.js';

export const config = { runtime: 'edge' };

const SESSION_COOKIE = 'wm-session';
const WIDGET_KEY_COOKIE = 'wm-widget-key';
const PRO_KEY_COOKIE = 'wm-pro-key';
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const LEGACY_KEY_MAX_LEN = 512;
const SESSION_RATE_LIMIT_SCOPE = 'wm-session';
const SESSION_RATE_LIMIT_PER_MINUTE = 30;
const SESSION_RATE_LIMIT_WINDOW = '60 s';

function jsonResponse(body, status, headers) {
  const out = headers instanceof Headers ? headers : new Headers(headers);
  out.set('Content-Type', 'application/json');
  out.set('Cache-Control', 'no-store');
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

/**
 * Read one cookie off the request. Mirrors the reader in `_api-key.js`; kept
 * local because this endpoint is the only other consumer and `_api-key.js`
 * does not export it.
 */
function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || req.headers.get('cookie') || '';
  if (!raw) return '';
  const prefix = `${name}=`;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(trimmed.slice(prefix.length));
    } catch {
      return trimmed.slice(prefix.length);
    }
  }
  return '';
}

/**
 * Did THIS request arrive already carrying a usable session cookie?
 *
 * The client cannot answer this itself — the cookie is HttpOnly, so JS can
 * neither read it nor tell "the server rejected my cookie" apart from "my
 * browser never stored it." Those two need opposite responses: the first is
 * worth a re-mint, the second makes every re-mint useless because no route can
 * ever succeed. Reporting it back lets the client stop after one wasted mint
 * instead of spending one per route and blaming the API for a browser-side
 * storage failure (WORLDMONITOR-WG/XP).
 *
 * Computed from the INCOMING request, before this response's Set-Cookie.
 */
async function hadValidSessionCookie(req) {
  const presented = readCookie(req, SESSION_COOKIE);
  if (!presented) return false;
  return validateSessionToken(presented);
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

function submittedLegacyKey(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function envList(name) {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function matchesEnvSecret(key, name) {
  const secret = process.env[name] || '';
  return timingSafeEqualSecret(key, secret);
}

async function isValidEnterpriseKey(key) {
  return timingSafeIncludes(key, envList('WORLDMONITOR_VALID_KEYS'));
}

async function isValidWidgetKey(key) {
  return (await matchesEnvSecret(key, 'WIDGET_AGENT_KEY')) || await isValidEnterpriseKey(key);
}

async function isValidProKey(key) {
  return (await matchesEnvSecret(key, 'PRO_WIDGET_KEY')) || await isValidEnterpriseKey(key);
}

const BODY_READ_TIMEOUT_MS = Number(process.env.WM_SESSION_BODY_TIMEOUT_MS) || 5_000;

async function readBody(req) {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return {};
  try {
    // Adversarial DoS guard: a request body stream that never ends must not
    // hold the edge function open forever. Race json() against a tight budget.
    const parsed = await Promise.race([
      req.json(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('request body read timeout')),
        BODY_READ_TIMEOUT_MS,
      )),
    ]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export default async function handler(req, ctx) {
  const startedAt = Date.now();
  const respond = (body, status, headers, reason) => {
    const response = jsonResponse(body, status, headers);
    emitWmSessionUsage(ctx, req, response, startedAt, reason);
    return response;
  };

  if (isDisallowedOrigin(req)) {
    const response = new Response('Forbidden', { status: 403 });
    emitWmSessionUsage(ctx, req, response, startedAt, 'origin_403');
    return response;
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405, cors, 'method_not_allowed');
  }

  // Rate-limit per IP. Without this, an attacker can farm tokens cheaply.
  // Token TTL is 12h, so this route uses a lower, fail-closed issuance budget
  // instead of inheriting the availability-first global fallback.
  const rl = await checkRateLimit(req, cors, {
    failClosed: true,
    ctx,
    scope: SESSION_RATE_LIMIT_SCOPE,
    limit: SESSION_RATE_LIMIT_PER_MINUTE,
    window: SESSION_RATE_LIMIT_WINDOW,
  });
  if (rl) {
    emitWmSessionUsage(ctx, req, rl, startedAt, rl.status === 429 ? 'rate_limit_429' : 'rate_limit_degraded');
    return rl;
  }

  // Before the new Set-Cookie: whether the caller's browser gave the previous
  // cookie back. Never fails the request — it is diagnostic, not a gate.
  let hadSession = false;
  try {
    hadSession = await hadValidSessionCookie(req);
  } catch {
    hadSession = false;
  }

  let issued;
  try {
    issued = await issueSessionToken();
  } catch {
    // WM_SESSION_SECRET missing — fail closed. 503 signals "configure me",
    // not "you're rejected." Operator-visible.
    return respond({ error: 'Session service not configured' }, 503, cors, 'auth_unavailable');
  }

  const body = await readBody(req);
  const widgetKey = normalizeLegacyKey(body.widgetKey);
  const proKey = normalizeLegacyKey(body.proKey);

  if (
    (submittedLegacyKey(body.widgetKey) && !(await isValidWidgetKey(widgetKey))) ||
    (submittedLegacyKey(body.proKey) && !(await isValidProKey(proKey)))
  ) {
    return respond({ error: 'Invalid session key' }, 401, cors, 'auth_401');
  }

  let headers = appendHeader(cors, 'Set-Cookie', sessionCookie(req, SESSION_COOKIE, issued.token));

  // Best-effort cleanup for old JS-readable cookies only when replacing that
  // key. A no-key session refresh must preserve existing HttpOnly key cookies.
  if (widgetKey) {
    headers = appendHeader(headers, 'Set-Cookie', clearReadableCookie(WIDGET_KEY_COOKIE));
    headers = appendHeader(headers, 'Set-Cookie', sessionCookie(req, WIDGET_KEY_COOKIE, widgetKey));
  }
  if (proKey) {
    headers = appendHeader(headers, 'Set-Cookie', clearReadableCookie(PRO_KEY_COOKIE));
    headers = appendHeader(headers, 'Set-Cookie', sessionCookie(req, PRO_KEY_COOKIE, proKey));
  }

  // The HttpOnly cookie remains the primary transport. The anonymous token is
  // also returned so browsers that demonstrably refuse the shared-domain
  // cookie can use the existing X-WorldMonitor-Key validation path. This does
  // not expose user or premium authority: wms_ tokens are freely mintable,
  // anonymous-only, and forceKey routes reject them.
  return respond({
    ok: true,
    exp: issued.exp,
    hadSession,
    token: issued.token,
  }, 200, headers, 'ok');
}
