/**
 * GET /api/slack/oauth/callback
 *
 * Unauthenticated — browser popup arrives here after Slack redirects.
 * Validates state → exchanges code → encrypts webhook → stores in Convex.
 *
 * Returns a minimal HTML page that posts a message to the opener and
 * closes itself. Falls back to a plain text success/error page if the
 * opener is unavailable.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../_sentry-edge.js';

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? '';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET ?? '';
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI ?? '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET ?? '';
const NOTIFICATION_ENCRYPTION_KEY = process.env.NOTIFICATION_ENCRYPTION_KEY ?? '';
// Use '*' targetOrigin so the message is delivered regardless of which WM subdomain or
// preview URL the opener is running on. There are no secrets in the payload (channelName,
// teamName are not sensitive), and the frontend listener already validates e.origin.
const APP_ORIGIN = '*';

// AES-256-GCM: matches crypto.cjs decrypt format
// v1:<base64(iv[12] | tag[16] | ciphertext)>
async function encryptWebhook(url: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(NOTIFICATION_ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(url);
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encoded));
  const ciphertext = result.slice(0, -16);
  const tag = result.slice(-16);
  const payload = new Uint8Array(12 + 16 + ciphertext.length);
  payload.set(iv, 0); payload.set(tag, 12); payload.set(ciphertext, 28);
  const binary = Array.from(payload, (b) => String.fromCharCode(b)).join('');
  return `v1:${btoa(binary)}`;
}

async function upstashGet(key: string): Promise<string | null> {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const json = await res.json() as { result: string | null };
  return json.result;
}

async function upstashDel(key: string): Promise<void> {
  await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function publishWelcome(userId: string, channelType: string): Promise<void> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('[slack-oauth] publishWelcome: UPSTASH env vars missing — welcome not queued');
    return;
  }
  console.log(`[slack-oauth] publishWelcome: queuing ${channelType} for ${userId}`);
  const msg = JSON.stringify({ eventType: 'channel_welcome', userId, channelType });
  try {
    const res = await fetch(`${UPSTASH_URL}/lpush/wm:events:queue/${encodeURIComponent(msg)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'User-Agent': 'worldmonitor-edge/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => null) as { result?: unknown } | null;
    console.log(`[slack-oauth] publishWelcome LPUSH: status=${res.status} result=${JSON.stringify(data?.result)}`);
  } catch (err) {
    console.error('[slack-oauth] publishWelcome LPUSH failed:', (err as Error).message);
    // publishWelcome runs inside the handler's ctx.waitUntil chain; await
    // keeps that chain pending until Sentry delivery completes.
    await captureSilentError(err, {
      tags: { route: 'api/slack/oauth/callback', step: 'publish-welcome' },
    });
  }
}

function htmlResponse(script: string, body: string): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Slack OAuth</title></head><body>
<p style="font-family:system-ui;padding:20px">${body}</p>
<script>
(function(){try{${script}}catch(e){}})();
</script>
</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function safeJsonInScript(data: unknown): string {
  // Escape </ to prevent </script> from closing the enclosing script tag prematurely.
  // \/ is a valid JSON escape for forward slash and is semantically identical.
  return JSON.stringify(data).replace(/<\//g, '<\\/');
}

function postAndClose(data: Record<string, unknown>): Response {
  const msg = safeJsonInScript(data);
  return htmlResponse(
    `window.opener&&window.opener.postMessage(${msg},'${APP_ORIGIN}');window.close();`,
    'Connected to Slack. You can close this window.',
  );
}

function errorAndClose(error: string): Response {
  const msg = safeJsonInScript({ type: 'wm:slack_error', error });
  return htmlResponse(
    `window.opener&&window.opener.postMessage(${msg},'${APP_ORIGIN}');window.close();`,
    `Slack connection failed: ${escapeHtml(error)}. You can close this window.`,
  );
}

export default async function handler(req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) return errorAndClose(errorParam);
  if (!code || !state) return errorAndClose('missing_params');

  if (!UPSTASH_URL || !SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET || !CONVEX_SITE_URL || !RELAY_SHARED_SECRET || !NOTIFICATION_ENCRYPTION_KEY) {
    return errorAndClose('misconfigured');
  }

  // Validate and consume state
  const stateKey = `wm:slack:oauth:${state}`;
  const userId = await upstashGet(stateKey);
  if (!userId) return errorAndClose('invalid_state');
  await upstashDel(stateKey); // consume — prevents replay

  // Exchange code for token
  const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);

  if (!tokenRes?.ok) return errorAndClose('token_exchange_failed');

  const tokenData = await tokenRes.json() as {
    ok: boolean;
    error?: string;
    incoming_webhook?: {
      url: string;
      channel: string;
      channel_id: string;
      configuration_url: string;
    };
    team?: { id: string; name: string };
  };

  if (!tokenData.ok) return errorAndClose(tokenData.error ?? 'slack_error');
  if (!tokenData.incoming_webhook?.url) return errorAndClose('no_webhook');

  // Encrypt webhook URL
  let webhookEnvelope: string;
  try {
    webhookEnvelope = await encryptWebhook(tokenData.incoming_webhook.url);
  } catch {
    return errorAndClose('encryption_failed');
  }

  // Store via Convex relay
  const convexRes = await fetch(`${CONVEX_SITE_URL}/relay/notification-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SHARED_SECRET}` },
    body: JSON.stringify({
      action: 'set-slack-oauth',
      userId,
      webhookEnvelope,
      slackChannelName: tokenData.incoming_webhook.channel,
      slackTeamName: tokenData.team?.name,
      slackConfigurationUrl: tokenData.incoming_webhook.configuration_url,
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);

  if (!convexRes?.ok) return errorAndClose('storage_failed');

  const stored = await convexRes.json() as { ok: boolean; isNew?: boolean };
  console.log(`[slack-oauth] Convex set-slack-oauth: isNew=${stored.isNew}`);
  if (stored.isNew) ctx.waitUntil(publishWelcome(userId, 'slack'));

  return postAndClose({
    type: 'wm:slack_connected',
    channelName: tokenData.incoming_webhook.channel,
    teamName: tokenData.team?.name ?? '',
  });
}
