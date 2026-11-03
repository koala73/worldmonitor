export const config = { runtime: 'edge' };

// @ts-expect-error JS module has no declaration file.
import { isDisallowedOrigin } from './_cors.js';
import {
  channelOAuthBindingMatches,
  channelOAuthCookieHeader,
  parseChannelOAuthState,
} from '../server/_shared/channel-oauth-state';
import { compareAndDeleteRedisKey } from '../server/_shared/redis';
import { checkFailClosedScopedIpRateLimit } from '../server/_shared/rate-limit';

const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' };

function errorResponse(message: string, status: number): Response {
  return new Response(`<p>${message}</p>`, { status, headers: HEADERS });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Start this connection from notification settings.', 405);
  if (isDisallowedOrigin(req)) return errorResponse('Origin not allowed.', 403);
  // Unauthenticated by design (the binding token is the credential), so bound
  // the Redis reads a stranger can trigger per IP before any lookup runs.
  // Fail closed: a limiter outage must not become an unmetered Redis probe.
  const admission = await checkFailClosedScopedIpRateLimit(req, 'channel-oauth-bind', 30, '60 s', {});
  if (admission) return admission;
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider');
  const stateToken = url.searchParams.get('state') ?? '';
  if ((provider !== 'slack' && provider !== 'discord') || !/^[A-Za-z0-9_-]{27}$/.test(stateToken)) {
    return errorResponse('Invalid connection.', 400);
  }
  const body = await req.text();
  if (body.length > 1024) return errorResponse('Invalid connection.', 400);
  const token = new URLSearchParams(body).get('token');
  if (!token) return errorResponse('Connection does not match this browser.', 403);
  const key = `wm:${provider}:oauth:launch:${stateToken}`;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) return errorResponse('Connection service unavailable. Try again.', 503);
  const res = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${redisToken}`, 'User-Agent': 'worldmonitor-edge/1.0' },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res?.ok) return errorResponse('Connection service unavailable. Try again.', 503);
  const data = await res.json().catch(() => null) as { result?: unknown } | null;
  if (!data || (data.result !== null && typeof data.result !== 'string')) return errorResponse('Connection service unavailable. Try again.', 503);
  if (data.result === null) return errorResponse('Connection expired. Start again from notification settings.', 400);
  const state = parseChannelOAuthState(data.result);
  if (!state?.cookieName || !state.cookieName.startsWith(`__Secure-wm_${provider}_oauth_`) ||
      !(await channelOAuthBindingMatches(provider, token, state))) {
    return errorResponse('Connection does not match this browser.', 403);
  }
  const { oauthUrl } = JSON.parse(data.result) as { oauthUrl?: unknown };
  let destination: URL;
  try { destination = new URL(typeof oauthUrl === 'string' ? oauthUrl : ''); }
  catch { return errorResponse('Invalid connection.', 400); }
  const allowedDestination = provider === 'slack' ? 'https://slack.com/oauth/v2/authorize' : 'https://discord.com/oauth2/authorize';
  if (`${destination.origin}${destination.pathname}` !== allowedDestination || destination.searchParams.get('state') !== stateToken) {
    return errorResponse('Invalid connection.', 400);
  }
  if (!(await compareAndDeleteRedisKey(key, data.result, true))) {
    return errorResponse('Connection expired or unavailable. Start again from notification settings.', 503);
  }
  const escapedUrl = destination.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // A new document avoids applying the opener's form-action policy to the provider navigation.
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Connect notifications</title><meta http-equiv="refresh" content="0;url=${escapedUrl}"></head><body><p>Connecting your notifications. <a href="${escapedUrl}">Continue</a></p></body></html>`, {
    headers: { ...HEADERS, 'Set-Cookie': channelOAuthCookieHeader(req, state, token) },
  });
}
