/**
 * Notification channel management edge function.
 *
 * GET  /api/notification-channels → { channels, alertRules }
 * POST /api/notification-channels → various actions (see below)
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
import { validateBearerToken } from '../server/auth-session';
import { ConvexHttpClient } from 'convex/browser';

const CONVEX_URL = process.env.CONVEX_URL ?? '';

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function buildClient(token: string): ConvexHttpClient {
  const client = new ConvexHttpClient(CONVEX_URL);
  client.setAuth(token);
  return client;
}

function convexErrorStatus(err: unknown): number {
  if (err !== null && typeof err === 'object' && 'data' in err) {
    const msg = typeof (err as Record<string, unknown>).data === 'string'
      ? String((err as Record<string, unknown>).data)
      : '';
    if (msg.includes('UNAUTHENTICATED')) return 401;
  }
  return 500;
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

export default async function handler(req: Request): Promise<Response> {
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
  if (!session.valid) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  if (!CONVEX_URL) return json({ error: 'Service unavailable' }, 503, corsHeaders);

  if (req.method === 'GET') {
    try {
      const client = buildClient(token);
      const [channels, alertRules] = await Promise.all([
        client.query('notificationChannels:getChannels' as any, {}),
        client.query('alertRules:getAlertRules' as any, {}),
      ]);
      return json({ channels, alertRules }, 200, corsHeaders);
    } catch (err) {
      console.error('[notification-channels] GET error:', err);
      return json({ error: 'Failed to fetch' }, convexErrorStatus(err), corsHeaders);
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
      const client = buildClient(token);

      if (action === 'create-pairing-token') {
        const result = await client.mutation('notificationChannels:createPairingToken' as any, {});
        return json(result, 200, corsHeaders);
      }

      if (action === 'set-channel') {
        const { channelType, email, webhookEnvelope } = body;
        if (!channelType) return json({ error: 'channelType required' }, 400, corsHeaders);
        const args: Record<string, string> = { channelType };
        if (email !== undefined) args.email = email;
        if (webhookEnvelope !== undefined) args.webhookEnvelope = webhookEnvelope;
        await client.mutation('notificationChannels:setChannel' as any, args);
        return json({ ok: true }, 200, corsHeaders);
      }

      if (action === 'delete-channel') {
        const { channelType } = body;
        if (!channelType) return json({ error: 'channelType required' }, 400, corsHeaders);
        await client.mutation('notificationChannels:deleteChannel' as any, { channelType });
        return json({ ok: true }, 200, corsHeaders);
      }

      if (action === 'set-alert-rules') {
        const { variant, enabled, eventTypes, sensitivity, channels } = body;
        await client.mutation('alertRules:setAlertRules' as any, {
          variant,
          enabled,
          eventTypes,
          sensitivity,
          channels,
        });
        return json({ ok: true }, 200, corsHeaders);
      }

      return json({ error: 'Unknown action' }, 400, corsHeaders);
    } catch (err) {
      console.error('[notification-channels] POST error:', err);
      return json({ error: 'Operation failed' }, convexErrorStatus(err), corsHeaders);
    }
  }

  return json({ error: 'Method not allowed' }, 405, corsHeaders);
}
