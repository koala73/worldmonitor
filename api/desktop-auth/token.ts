/**
 * POST /api/desktop-auth/token
 *
 * Step 8 of the desktop browser sign-in (see api/_desktop-auth.ts). The
 * desktop redeems the one-time code from its loopback redirect with the PKCE
 * verifier only it holds, and gets a short-lived, single-use Clerk sign-in
 * ticket. Unauthenticated by design: the desktop has no session yet.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error JS module without declarations.
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error JS module without declarations.
import { verifyPkceS256 } from '../_crypto.js';
// @ts-expect-error JS module without declarations.
import { checkRateLimit } from '../_rate-limit.js';
// @ts-expect-error JS module without declarations.
import { captureSilentError } from '../_sentry-edge.js';
import {
  clientIp,
  desktopAuthCodeKey,
  isCode,
  isCodeVerifier,
  jsonResponse,
  logDesktopAuthEvent,
  mintClerkSignInTicket,
  readJsonBody,
  takeDesktopAuthCode,
  type DesktopAuthAuditEvent,
  type DesktopAuthCodeRecord,
  type MintTicketResult,
} from '../_desktop-auth';

export interface DesktopTokenDeps {
  takeCode(key: string): Promise<DesktopAuthCodeRecord | null>;
  mintTicket(userId: string): Promise<MintTicketResult>;
  rateLimit(request: Request, cors: Record<string, string>): Promise<Response | null>;
  audit(event: DesktopAuthAuditEvent): void;
  report(error: unknown): void;
}

export async function desktopAuthTokenHandler(
  request: Request,
  deps: DesktopTokenDeps,
): Promise<Response> {
  const cors = getCorsHeaders(request) as Record<string, string>;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
  }

  const limited = await deps.rateLimit(request, cors);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const code = body?.code;
  const codeVerifier = body?.code_verifier;
  if (!isCode(code) || !isCodeVerifier(codeVerifier)) {
    return jsonResponse({ error: 'invalid_request' }, 400, cors);
  }

  const key = await desktopAuthCodeKey(code);
  const audit = (outcome: string, userId: string | null = null) => deps.audit({
    step: 'token',
    outcome,
    userId,
    ip: clientIp(request),
    ua: request.headers.get('user-agent'),
    codeKey: key.slice(-12),
  });

  let record: DesktopAuthCodeRecord | null;
  try {
    // GETDEL: a wrong verifier burns the code too, so it cannot be guessed at.
    record = await deps.takeCode(key);
  } catch (error) {
    console.warn('[desktop-auth] code read failed:', error instanceof Error ? error.message : String(error));
    captureSilentError(error, {
      tags: { route: 'api/desktop-auth/token', step: 'redis-take' },
      fingerprint: ['desktop-auth', 'redis-take'],
    });
    audit('store_failed');
    return jsonResponse({ error: 'service_unavailable' }, 503, { ...cors, 'Retry-After': '5' });
  }
  if (!record || (await verifyPkceS256(codeVerifier, record.codeChallenge)) !== true) {
    audit('invalid_grant', record?.userId ?? null);
    return jsonResponse({ error: 'invalid_grant' }, 400, cors);
  }

  let minted: MintTicketResult;
  try {
    minted = await deps.mintTicket(record.userId);
  } catch (error) {
    console.warn('[desktop-auth] sign-in token failed:', error instanceof Error ? error.message : String(error));
    // sentry-coverage-ok reported via `deps.report` (captureSilentError in
    // production) so the fingerprint is assertable without a DSN.
    deps.report(error);
    audit('clerk_failed', record.userId);
    return jsonResponse({ error: 'upstream_unavailable' }, 502, cors);
  }
  if (minted.kind === 'refused') {
    audit(`clerk_refused_${minted.status}`, record.userId);
    return jsonResponse({ error: 'sign_in_refused' }, 403, cors);
  }

  audit('ticket_issued', record.userId);
  return jsonResponse({ ticket: minted.ticket }, 200, cors);
}

export default async function handler(request: Request): Promise<Response> {
  return desktopAuthTokenHandler(request, {
    takeCode: takeDesktopAuthCode,
    mintTicket: mintClerkSignInTicket,
    rateLimit: (req, cors) => checkRateLimit(req, cors, {
      scope: 'desktop-auth-token',
      limit: 20,
      window: '10 m',
    }),
    audit: logDesktopAuthEvent,
    report: (error) => captureSilentError(error, {
      tags: { route: 'api/desktop-auth/token', step: 'clerk-sign-in-token' },
      fingerprint: ['desktop-auth', 'clerk-sign-in-token'],
    }),
  });
}
