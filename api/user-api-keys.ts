/** API and desktop key issuance requires a live Clerk session. */
export const config = { runtime: 'edge' };

// @ts-expect-error JS module without declarations.
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error JS module without declarations.
import { checkRateLimit } from './_rate-limit.js';
import { verifyClerkSessionActive, type ClerkSessionCheck } from '../server/auth-session';
import { resolveVerifiedClerkSession, type ClerkSession } from '../server/_shared/auth-session';
import { jsonResponse, readJsonBody } from './_desktop-auth';

export interface UserApiKeyCreateDeps {
  resolveSession(request: Request): Promise<ClerkSession | Response | null>;
  rateLimit(request: Request, userId: string, cors: Record<string, string>): Promise<Response | null>;
  verifySession(sessionId: string, userId: string): Promise<ClerkSessionCheck>;
  relay(body: Record<string, unknown>): Promise<Response>;
}

export function userApiKeyCreateRateLimitPolicy(userId: string) {
  return { scope: 'user-api-key-create', identifier: `user:${userId}`, limit: 10, window: '10 m', failClosed: true } as const;
}

export async function userApiKeyCreateHandler(request: Request, deps: UserApiKeyCreateDeps): Promise<Response> {
  const cors = { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Cache-Control': 'no-store' } as Record<string, string>;
  const finish = (response: Response) => {
    const headers = new Headers(response.headers);
    Object.entries(cors).forEach(([key, value]) => headers.set(key, value));
    return new Response(response.body, { status: response.status, headers });
  };
  const unavailable = () => jsonResponse({ error: 'service_unavailable' }, 503, { ...cors, 'Retry-After': '5' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
  const session = await deps.resolveSession(request);
  if (session instanceof Response) return finish(session);
  if (!session?.sessionId) return jsonResponse({ error: 'unauthenticated' }, 401, cors);
  const { userId, sessionId } = session;
  const limited = await deps.rateLimit(request, userId, cors);
  if (limited) return finish(limited);
  const liveness = await deps.verifySession(sessionId, userId);
  if (liveness === 'unavailable') return unavailable();
  if (liveness !== 'active') return jsonResponse({ error: 'unauthenticated' }, 401, cors);
  const body = await readJsonBody(request);
  if (!body || typeof body.name !== 'string' || typeof body.keyPrefix !== 'string' || typeof body.keyHash !== 'string'
    || (body.scopes !== undefined && (!Array.isArray(body.scopes) || !body.scopes.every(s => typeof s === 'string')))
    || (body.keyKind !== undefined && body.keyKind !== 'api' && body.keyKind !== 'desktop')) {
    return jsonResponse({ error: 'invalid_request' }, 400, cors);
  }
  try {
    const response = await deps.relay({
      userId, name: body.name, keyPrefix: body.keyPrefix, keyHash: body.keyHash,
      ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
      ...(body.keyKind !== undefined ? { keyKind: body.keyKind } : {}),
    });
    // A relay 401 is a gateway-secret mismatch (e.g. mid-rotation), not the caller's session.
    if (response.status === 401 || response.status === 404 || response.status >= 500) return unavailable();
    const result = await response.json();
    if (response.status >= 400 && response.status < 500 && typeof result?.error === 'string') {
      return jsonResponse({ error: result.error }, response.status, cors);
    }
    if (!response.ok) return unavailable();
    return jsonResponse(result, response.status, cors);
  } catch {
    return unavailable();
  }
}

export default async function handler(request: Request): Promise<Response> {
  return userApiKeyCreateHandler(request, {
    resolveSession: resolveVerifiedClerkSession,
    verifySession: verifyClerkSessionActive,
    rateLimit: (req, userId, cors) => checkRateLimit(req, cors, userApiKeyCreateRateLimitPolicy(userId)),
    relay: body => {
      const url = process.env.CONVEX_SITE_URL;
      const secret = process.env.CONVEX_TENANT_RELAY_SECRET;
      if (!url || !secret) throw new Error('Relay unavailable');
      return fetch(`${url}/relay/api-keys/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'User-Agent': 'worldmonitor-edge/1.0' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    },
  });
}
