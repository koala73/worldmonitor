/**
 * Notification channel management edge function.
 *
 * GET  /api/notification-channels → { channels, alertRules }
 * POST /api/notification-channels → various actions (see below)
 *
 * Authenticates the caller via Clerk JWKS (bearer token), then forwards
 * to the Convex /relay/notification-channels HTTP action using the
 * RELAY_SHARED_SECRET — no Convex-specific JWT template required.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureEdgeException } from './_sentry-edge.js';
import { validateBearerToken } from '../server/auth-session';

// Prefer explicit CONVEX_SITE_URL; fall back to deriving from CONVEX_URL (same pattern as notification-relay.cjs).
const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET ?? '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

// AES-256-GCM encryption using Web Crypto (matches Node crypto.cjs decrypt format).
// Format stored: v1:<base64(iv[12] || tag[16] || ciphertext)>
async function encryptSlackWebhook(webhookUrl: string): Promise<string> {
  const rawKey = process.env.NOTIFICATION_ENCRYPTION_KEY;
  if (!rawKey) throw new Error('NOTIFICATION_ENCRYPTION_KEY not set');
  const keyBytes = Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(webhookUrl);
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encoded));
  const ciphertext = result.slice(0, -16);
  const tag = result.slice(-16);
  const payload = new Uint8Array(12 + 16 + ciphertext.length);
  payload.set(iv, 0);
  payload.set(tag, 12);
  payload.set(ciphertext, 28);
  const binary = Array.from(payload, (b) => String.fromCharCode(b)).join('');
  return `v1:${btoa(binary)}`;
}

async function publishWelcome(userId: string, channelType: string): Promise<void> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const msg = JSON.stringify({ eventType: 'channel_welcome', userId, channelType });
  try {
    await fetch(`${UPSTASH_URL}/publish/wm:events:notify/${encodeURIComponent(msg)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'User-Agent': 'worldmonitor-edge/1.0',
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best-effort
  }
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function convexRelay(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${CONVEX_SITE_URL}/relay/notification-channels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RELAY_SHARED_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

interface PostBody {
  action?: string;
  channelType?: string;
  email?: string;
  webhookEnvelope?: string;
  variant?: string;
  enabled?: boolean;
  eventTypes?: string[];
  sensitivity?: string;
  channels?: string[];
}

export default async function handler(req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  if (!CONVEX_SITE_URL || !RELAY_SHARED_SECRET) {
    return json({ error: 'Service unavailable' }, 503, corsHeaders);
  }

  if (req.method === 'GET') {
    try {
      const resp = await convexRelay({ action: 'get', userId: session.userId });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('[notification-channels] GET relay error:', resp.status, errText);
        return json({ error: 'Failed to fetch' }, 500, corsHeaders);
      }
      const data = await resp.json();
      return json(data, 200, corsHeaders);
    } catch (err) {
      console.error('[notification-channels] GET error:', err);
      void captureEdgeException(err, { handler: 'notification-channels', method: 'GET' });
      return json({ error: 'Failed to fetch' }, 500, corsHeaders);
    }
  }

  if (req.method === 'POST') {
    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    const { action } = body;

    try {
      if (action === 'create-pairing-token') {
        const resp = await convexRelay({ action: 'create-pairing-token', userId: session.userId });
        if (!resp.ok) {
          console.error('[notification-channels] POST create-pairing-token relay error:', resp.status);
          return json({ error: 'Operation failed' }, 500, corsHeaders);
        }
        return json(await resp.json(), 200, corsHeaders);
      }

      if (action === 'set-channel') {
        const { channelType, email, webhookEnvelope } = body;
        if (!channelType) return json({ error: 'channelType required' }, 400, corsHeaders);
        const relayBody: Record<string, unknown> = { action: 'set-channel', userId: session.userId, channelType };
        if (email !== undefined) relayBody.email = email;
        if (webhookEnvelope !== undefined) {
          try {
            relayBody.webhookEnvelope = await encryptSlackWebhook(webhookEnvelope);
          } catch {
            return json({ error: 'Encryption unavailable' }, 503, corsHeaders);
          }
        }
        const resp = await convexRelay(relayBody);
        if (!resp.ok) {
          console.error('[notification-channels] POST set-channel relay error:', resp.status);
          return json({ error: 'Operation failed' }, 500, corsHeaders);
        }
        const setResult = await resp.json() as { ok: boolean; isNew?: boolean };
        // Only send welcome on first connect, not re-links; use waitUntil so the edge isolate doesn't terminate early
        if (setResult.isNew) ctx.waitUntil(publishWelcome(session.userId, channelType));
        return json({ ok: true }, 200, corsHeaders);
      }

      if (action === 'delete-channel') {
        const { channelType } = body;
        if (!channelType) return json({ error: 'channelType required' }, 400, corsHeaders);
        const resp = await convexRelay({ action: 'delete-channel', userId: session.userId, channelType });
        if (!resp.ok) {
          console.error('[notification-channels] POST delete-channel relay error:', resp.status);
          return json({ error: 'Operation failed' }, 500, corsHeaders);
        }
        return json({ ok: true }, 200, corsHeaders);
      }

      if (action === 'set-alert-rules') {
        const { variant, enabled, eventTypes, sensitivity, channels } = body;
        const resp = await convexRelay({
          action: 'set-alert-rules',
          userId: session.userId,
          variant,
          enabled,
          eventTypes,
          sensitivity,
          channels,
        });
        if (!resp.ok) {
          console.error('[notification-channels] POST set-alert-rules relay error:', resp.status);
          return json({ error: 'Operation failed' }, 500, corsHeaders);
        }
        return json({ ok: true }, 200, corsHeaders);
      }

      return json({ error: 'Unknown action' }, 400, corsHeaders);
    } catch (err) {
      console.error('[notification-channels] POST error:', err);
      void captureEdgeException(err, { handler: 'notification-channels', method: 'POST' });
      return json({ error: 'Operation failed' }, 500, corsHeaders);
    }
  }

  return json({ error: 'Method not allowed' }, 405, corsHeaders);
}
