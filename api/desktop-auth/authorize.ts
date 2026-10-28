/**
 * POST /api/desktop-auth/authorize
 *
 * Step 3 of the desktop browser sign-in (see api/_desktop-auth.ts). The
 * signed-in browser sends the desktop's PKCE challenge and gets a one-time
 * code, which it hands to the desktop on a 127.0.0.1 loopback redirect.
 * Clerk bearer auth is the control; no cookie authenticates this route.
 *
 * The bearer's session must be live at Clerk, not merely signed: the code is
 * redeemed for a brand-new session, so a token whose session was revoked
 * would otherwise be laundered into a fresh one until `exp`.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error JS module without declarations.
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error JS module without declarations.
import { checkRateLimit } from '../_rate-limit.js';
// @ts-expect-error JS module without declarations.
import { captureSilentError } from '../_sentry-edge.js';
import { verifyClerkSessionActive, type ClerkSessionCheck } from '../../server/auth-session';
import { resolveVerifiedClerkSession, type ClerkSession } from '../../server/_shared/auth-session';
import {
  DESKTOP_AUTH_CODE_TTL_SECONDS,
  clientIp,
  desktopAuthCodeKey,
  isCodeChallenge,
  jsonResponse,
  logDesktopAuthEvent,
  newDesktopAuthCode,
  readJsonBody,
  storeDesktopAuthCode,
  type DesktopAuthAuditEvent,
  type DesktopAuthCodeRecord,
} from '../_desktop-auth';

export interface DesktopAuthorizeDeps {
  /** Bearer identity from the local JWKS check only (no outbound call); null = 401, Response = retryable denial. */
  resolveSession(request: Request): Promise<ClerkSession | Response | null>;
  /** Is that session still live at Clerk, for this user? Runs after the rate limit. */
  verifySession(sessionId: string, userId: string): Promise<ClerkSessionCheck>;
  storeCode(key: string, record: DesktopAuthCodeRecord, ttlSeconds: number): Promise<boolean>;
  rateLimit(request: Request, userId: string, cors: Record<string, string>): Promise<Response | null>;
  audit(event: DesktopAuthAuditEvent): void;
}

export async function desktopAuthAuthorizeHandler(
  request: Request,
  deps: DesktopAuthorizeDeps,
): Promise<Response> {
  const cors = getCorsHeaders(request) as Record<string, string>;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
  }

  const session = await deps.resolveSession(request);
  if (session instanceof Response) {
    Object.entries({ ...cors, 'Cache-Control': 'no-store' }).forEach(([key, value]) => session.headers.set(key, value));
    return session;
  }
  // No `sid` means this is not a session token: nothing to keep live.
  if (!session?.sessionId) return jsonResponse({ error: 'unauthenticated' }, 401, cors);
  const { userId, sessionId } = session;

  // The limiter runs on the network-free identity, before the Clerk call, so
  // a limited caller cannot spend the instance-wide Clerk quota.
  const limited = await deps.rateLimit(request, userId, cors);
  if (limited) return limited;

  const liveness = await deps.verifySession(sessionId, userId);
  if (liveness === 'unavailable') {
    deps.audit({ step: 'authorize', outcome: 'session_check_unavailable', userId, ip: clientIp(request) });
    return jsonResponse({ error: 'service_unavailable' }, 503, { ...cors, 'Retry-After': '5' });
  }
  if (liveness !== 'active') {
    deps.audit({ step: 'authorize', outcome: 'session_inactive', userId, ip: clientIp(request) });
    return jsonResponse({ error: 'unauthenticated' }, 401, cors);
  }

  const body = await readJsonBody(request);
  const codeChallenge = body?.code_challenge;
  if (!isCodeChallenge(codeChallenge)) return jsonResponse({ error: 'invalid_request' }, 400, cors);

  const code = newDesktopAuthCode();
  const key = await desktopAuthCodeKey(code);
  let stored = false;
  try {
    stored = await deps.storeCode(key, { userId, sessionId, codeChallenge }, DESKTOP_AUTH_CODE_TTL_SECONDS);
  } catch (error) {
    console.warn('[desktop-auth] code store failed:', error instanceof Error ? error.message : String(error));
    captureSilentError(error, {
      tags: { route: 'api/desktop-auth/authorize', step: 'redis-store' },
      fingerprint: ['desktop-auth', 'redis-store'],
    });
  }
  if (!stored) {
    deps.audit({ step: 'authorize', outcome: 'store_failed', userId, ip: clientIp(request) });
    return jsonResponse({ error: 'service_unavailable' }, 503, { ...cors, 'Retry-After': '5' });
  }

  deps.audit({
    step: 'authorize',
    outcome: 'code_issued',
    userId,
    ip: clientIp(request),
    ua: request.headers.get('user-agent'),
    codeKey: key.slice(-12),
  });
  return jsonResponse({ code }, 200, cors);
}

/**
 * The limiter guards the outbound Clerk session check, so it fails closed: an
 * unavailable limiter must not let one caller spend the shared Clerk quota.
 */
export function desktopAuthorizeRateLimitPolicy(userId: string) {
  return {
    scope: 'desktop-auth-authorize',
    identifier: `user:${userId}`,
    limit: 10,
    window: '10 m',
    failClosed: true,
  } as const;
}

export default async function handler(request: Request): Promise<Response> {
  return desktopAuthAuthorizeHandler(request, {
    resolveSession: resolveVerifiedClerkSession,
    verifySession: verifyClerkSessionActive,
    storeCode: storeDesktopAuthCode,
    rateLimit: (req, userId, cors) => checkRateLimit(req, cors, desktopAuthorizeRateLimitPolicy(userId)),
    audit: logDesktopAuthEvent,
  });
}
