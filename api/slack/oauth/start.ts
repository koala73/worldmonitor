/**
 * POST /api/slack/oauth/start
 *
 * Authenticated (Clerk JWT). Generates a one-time CSRF state token, stores
 * userId in Upstash keyed by state (TTL 10 min), and returns the Slack
 * OAuth authorize URL.
 *
 * The frontend opens that URL in a popup; Slack redirects the popup to
 * /api/slack/oauth/callback when the user approves.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../../_cors.js';
import { validateBearerToken } from '../../../server/auth-session';
import { getEntitlements } from '../../../server/_shared/entitlement-check';

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? '';
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI ?? '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  if (!SLACK_CLIENT_ID || !SLACK_REDIRECT_URI || !UPSTASH_URL) {
    return new Response(JSON.stringify({ error: 'Slack OAuth not configured' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const ent = await getEntitlements(session.userId);
  if (!ent || ent.features.tier < 1) {
    return new Response(JSON.stringify({ error: 'pro_required', message: 'Slack notifications are available on the Pro plan.', upgradeUrl: 'https://worldmonitor.app/pro' }), { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // Generate one-time state token (20 random bytes → base64url)
  const stateBytes = crypto.getRandomValues(new Uint8Array(20));
  const state = btoa(String.fromCharCode(...stateBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Store userId in Upstash with 10-min TTL — pipeline for atomicity
  const pipelineRes = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', `wm:slack:oauth:${state}`, session.userId, 'EX', '600']]),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);

  if (!pipelineRes?.ok) {
    return new Response(JSON.stringify({ error: 'Failed to create OAuth state' }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const oauthUrl = new URL('https://slack.com/oauth/v2/authorize');
  oauthUrl.searchParams.set('client_id', SLACK_CLIENT_ID);
  oauthUrl.searchParams.set('scope', 'incoming-webhook');
  oauthUrl.searchParams.set('redirect_uri', SLACK_REDIRECT_URI);
  oauthUrl.searchParams.set('state', state);

  return new Response(JSON.stringify({ oauthUrl: oauthUrl.toString() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
