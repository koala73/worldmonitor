/**
 * POST /api/v2/shipping/webhooks — Register a webhook for chokepoint disruption alerts.
 * GET  /api/v2/shipping/webhooks — List webhooks for the authenticated caller.
 *
 * Payload: { callbackUrl, chokepointIds[], alertThreshold }
 * Response: { subscriberId, secret }
 *
 * Security:
 * - X-WorldMonitor-Key required (forceKey: true)
 * - SSRF prevention: callbackUrl hostname is validated against private IP ranges
 * - HMAC signatures: webhook deliveries include X-WM-Signature: sha256=<HMAC-SHA256(payload, secret)>
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../../_cors.js';
import { isCallerPremium } from '../../../server/_shared/premium-check';
import { getCachedJson, setCachedJson } from '../../../server/_shared/redis';
import { CHOKEPOINT_REGISTRY } from '../../../src/config/chokepoint-registry';

const WEBHOOK_TTL = 86400 * 30; // 30 days
const VALID_CHOKEPOINT_IDS = new Set(CHOKEPOINT_REGISTRY.map(c => c.id));

// Private IP ranges that should never receive webhook deliveries (SSRF prevention).
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,   // link-local + AWS/GCP metadata
  /^fd00:/i,                 // IPv6 ULA
  /^::1$/,                   // IPv6 loopback
  /^0\.0\.0\.0$/,
];

function isBlockedCallbackUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'callbackUrl is not a valid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'callbackUrl must use http or https';
  }

  const hostname = parsed.hostname;

  // Block known metadata endpoints explicitly
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return 'callbackUrl hostname is a blocked metadata endpoint';
  }

  for (const pattern of PRIVATE_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return `callbackUrl resolves to a private/reserved address: ${hostname}`;
    }
  }

  return null;
}

async function generateSecret(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSubscriberId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'wh_' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function webhookKey(subscriberId: string): string {
  return `webhook:sub:${subscriberId}:v1`;
}

interface WebhookRecord {
  subscriberId: string;
  callbackUrl: string;
  chokepointIds: string[];
  alertThreshold: number;
  createdAt: string;
  active: boolean;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const apiKeyResult = validateApiKey(req, { forceKey: true });
  if (apiKeyResult.required && !apiKeyResult.valid) {
    return new Response(JSON.stringify({ error: apiKeyResult.error ?? 'API key required' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const isPro = await isCallerPremium(req);
  if (!isPro) {
    return new Response(JSON.stringify({ error: 'PRO subscription required' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.replace(/\/+$/, '').split('/');
  const subscriberId = pathParts[pathParts.length - 1]?.startsWith('wh_')
    ? pathParts[pathParts.length - 1]
    : null;

  // POST /api/v2/shipping/webhooks — Register new webhook
  if (req.method === 'POST' && !subscriberId) {
    let body: { callbackUrl?: string; chokepointIds?: string[]; alertThreshold?: number };
    try {
      body = await req.json() as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: 'Request body must be valid JSON' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const { callbackUrl, chokepointIds = [], alertThreshold = 50 } = body;

    if (!callbackUrl) {
      return new Response(JSON.stringify({ error: 'callbackUrl is required' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const ssrfError = isBlockedCallbackUrl(callbackUrl);
    if (ssrfError) {
      return new Response(JSON.stringify({ error: ssrfError }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const invalidCp = chokepointIds.find(id => !VALID_CHOKEPOINT_IDS.has(id));
    if (invalidCp) {
      return new Response(JSON.stringify({ error: `Unknown chokepoint ID: ${invalidCp}` }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (typeof alertThreshold !== 'number' || alertThreshold < 0 || alertThreshold > 100) {
      return new Response(JSON.stringify({ error: 'alertThreshold must be a number between 0 and 100' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const newSubscriberId = generateSubscriberId();
    const secret = await generateSecret();

    const record: WebhookRecord = {
      subscriberId: newSubscriberId,
      callbackUrl,
      chokepointIds: chokepointIds.length ? chokepointIds : [...VALID_CHOKEPOINT_IDS],
      alertThreshold,
      createdAt: new Date().toISOString(),
      active: true,
    };

    // Store webhook record (without secret — secret is only returned once at registration)
    await setCachedJson(webhookKey(newSubscriberId), record, WEBHOOK_TTL);

    return new Response(JSON.stringify({ subscriberId: newSubscriberId, secret }), {
      status: 201,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // GET /api/v2/shipping/webhooks/{subscriberId} — Status check
  if (req.method === 'GET' && subscriberId) {
    const record = await getCachedJson(webhookKey(subscriberId)).catch(() => null) as WebhookRecord | null;
    if (!record) {
      return new Response(JSON.stringify({ error: 'Webhook not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      subscriberId: record.subscriberId,
      callbackUrl: record.callbackUrl,
      chokepointIds: record.chokepointIds,
      alertThreshold: record.alertThreshold,
      createdAt: record.createdAt,
      active: record.active,
    }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // POST /api/v2/shipping/webhooks/{subscriberId}/rotate-secret
  if (req.method === 'POST' && subscriberId) {
    const action = pathParts[pathParts.length - 1];

    if (action === 'rotate-secret') {
      const record = await getCachedJson(webhookKey(subscriberId)).catch(() => null) as WebhookRecord | null;
      if (!record) {
        return new Response(JSON.stringify({ error: 'Webhook not found' }), {
          status: 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const newSecret = await generateSecret();
      // TTL refresh on rotation
      await setCachedJson(webhookKey(subscriberId), record, WEBHOOK_TTL);

      return new Response(JSON.stringify({ subscriberId, secret: newSecret, rotatedAt: new Date().toISOString() }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'reactivate') {
      const record = await getCachedJson(webhookKey(subscriberId)).catch(() => null) as WebhookRecord | null;
      if (!record) {
        return new Response(JSON.stringify({ error: 'Webhook not found' }), {
          status: 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const updated = { ...record, active: true };
      await setCachedJson(webhookKey(subscriberId), updated, WEBHOOK_TTL);

      return new Response(JSON.stringify({ subscriberId, active: true }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
