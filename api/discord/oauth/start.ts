/**
 * POST /api/discord/oauth/start
 *
 * Authenticated (Clerk JWT). Generates a one-time CSRF state token, stores
 * userId in Upstash keyed by state (TTL 10 min), and returns the Discord
 * OAuth authorize URL.
 *
 * The frontend opens that URL in a popup; Discord redirects the popup to
 * /api/discord/oauth/callback when the user approves and selects a channel.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, getOriginDeniedCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from '../../_rate-limit.js';
import { validateBearerToken } from '../../../server/auth-session';
import { checkTierProEntitlement } from '../../../server/_shared/pro-entitlement';
import { createChannelOAuthState } from '../../../server/_shared/channel-oauth-state';

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

export default async function handler(req: Request, ctx?: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: { 'Content-Type': 'application/json', ...getOriginDeniedCorsHeaders(req, 'POST, OPTIONS') } });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI || !UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Discord OAuth not configured' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const proAccess = await checkTierProEntitlement(session.userId, corsHeaders);
  if (!proAccess.allowed) {
    // #5600: an entitlement the backend could not VERIFY is not a confirmed
    // free user. Answer the shared retryable contract (503 + Retry-After) for
    // those states before falling back to the terminal upsell. Note this covers
    // lookup failure and renewal verification only — the day-0 poisoned-marker
    // cohort arrives as a plain tier-0 answer and still gets the 403; that
    // window is bounded by NOT_APPLICABLE_VERIFICATION_TTL_SECONDS instead.
    const { billingDenial } = proAccess;
    if (billingDenial) return billingDenial;
    return new Response(JSON.stringify({ error: 'pro_required', message: 'Discord notifications are available on the Pro plan.', upgradeUrl: 'https://worldmonitor.app/pro' }), { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // Same per-user, fail-closed budget as api/slack/oauth/start.ts: each
  // accepted start writes two state keys with a 10-minute TTL.
  const rateLimitResponse = await checkRateLimit(req, corsHeaders, {
    scope: 'discord-oauth-start', identifier: session.userId, limit: 5, window: '60 s', failClosed: true, ctx,
  });
  if (rateLimitResponse) return rateLimitResponse;

  // Generate one-time state token (20 random bytes → base64url)
  const stateBytes = crypto.getRandomValues(new Uint8Array(20));
  const state = btoa(String.fromCharCode(...stateBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Bind the state to this browser and opener origin (see channel-oauth-state).
  const oauthState = await createChannelOAuthState('discord', req, session.userId);

  const oauthUrl = new URL('https://discord.com/oauth2/authorize');
  oauthUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
  oauthUrl.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
  oauthUrl.searchParams.set('response_type', 'code');
  oauthUrl.searchParams.set('scope', 'webhook.incoming');
  oauthUrl.searchParams.set('state', state);

  // Store the state record in Upstash with 10-min TTL
  const pipelineRes = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-edge/1.0' },
    body: JSON.stringify([
      ['SET', `wm:discord:oauth:${state}`, oauthState.record, 'EX', '600'],
      ['SET', `wm:discord:oauth:launch:${state}`, JSON.stringify({ ...JSON.parse(oauthState.record), oauthUrl: oauthUrl.toString() }), 'EX', '600'],
    ]),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);

  if (!pipelineRes?.ok) {
    return new Response(JSON.stringify({ error: 'Failed to create OAuth state' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
  const pipelineBody = await pipelineRes.json().catch(() => null);
  if (!Array.isArray(pipelineBody) || pipelineBody.length !== 2 || pipelineBody.some((entry) => entry?.result !== 'OK')) {
    return new Response(JSON.stringify({ error: 'Failed to create OAuth state' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  return new Response(JSON.stringify({ oauthUrl: oauthUrl.toString(), browserBinding: {
    url: new URL(`/api/channel-oauth-bind?provider=discord&state=${state}`, req.url).toString(),
    token: oauthState.bindValue,
  } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': oauthState.setCookie, 'Cache-Control': 'no-store', ...corsHeaders },
  });
}
