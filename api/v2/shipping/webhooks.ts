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
import { CHOKEPOINT_REGISTRY } from '../../../server/_shared/chokepoint-registry';

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

/** Stable identifier for the caller derived from their API key. Not secret. */
function callerFingerprint(req: Request): string {
  const key = req.headers.get('X-WorldMonitor-Key') ?? '';
  // Use last 12 chars of the key as a non-secret owner tag. Full key is never stored.
  return key.length >= 12 ? key.slice(-12) : key || 'anon';
}

interface WebhookRecord {
  subscriberId: string;
  ownerTag: string;      // last-12 chars of the registrant's API key for ownership checks
  callbackUrl: string;
  chokepointIds: string[];
  alertThreshold: number;
  createdAt: string;
  active: boolean;
  // secret is persisted so delivery workers can sign payloads via HMAC-SHA256.
  // Stored in trusted Redis; rotated via /rotate-secret.
  secret: string;
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

  // Find the wh_* segment anywhere in the path (handles /webhooks/wh_xxx/action)
  const whIndex = pathParts.findIndex(p => p.startsWith('wh_'));
  const subscriberId = whIndex !== -1 ? pathParts[whIndex] : null;
  // Action is the segment after the wh_* segment, if present
  const action = whIndex !== -1 ? (pathParts[whIndex + 1] ?? null) : null;

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
      ownerTag: callerFingerprint(req),
      callbackUrl,
      chokepointIds: chokepointIds.length ? chokepointIds : [...VALID_CHOKEPOINT_IDS],
      alertThreshold,
      createdAt: new Date().toISOString(),
      active: true,
      secret, // persisted so delivery workers can compute HMAC signatures
    };

    await setCachedJson(webhookKey(newSubscriberId), record, WEBHOOK_TTL);

    return new Response(JSON.stringify({ subscriberId: newSubscriberId, secret }), {
      status: 201,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Helper: load record + verify ownership in one place
  async function loadOwned(subId: string): Promise<WebhookRecord | 'not_found' | 'forbidden'> {
    const record = await getCachedJson(webhookKey(subId)).catch(() => null) as WebhookRecord | null;
    if (!record) return 'not_found';
    if (record.ownerTag !== callerFingerprint(req)) return 'forbidden';
    return record;
  }

  // GET /api/v2/shipping/webhooks/{subscriberId} — Status check
  if (req.method === 'GET' && subscriberId && !action) {
    const result = await loadOwned(subscriberId);
    if (result === 'not_found') {
      return new Response(JSON.stringify({ error: 'Webhook not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (result === 'forbidden') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      subscriberId: result.subscriberId,
      callbackUrl: result.callbackUrl,
      chokepointIds: result.chokepointIds,
      alertThreshold: result.alertThreshold,
      createdAt: result.createdAt,
      active: result.active,
      // secret is intentionally omitted from status responses
    }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // POST /api/v2/shipping/webhooks/{subscriberId}/rotate-secret
  if (req.method === 'POST' && subscriberId && action === 'rotate-secret') {
    const result = await loadOwned(subscriberId);
    if (result === 'not_found') {
      return new Response(JSON.stringify({ error: 'Webhook not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (result === 'forbidden') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const newSecret = await generateSecret();
    await setCachedJson(webhookKey(subscriberId), { ...result, secret: newSecret }, WEBHOOK_TTL);

    return new Response(JSON.stringify({ subscriberId, secret: newSecret, rotatedAt: new Date().toISOString() }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // POST /api/v2/shipping/webhooks/{subscriberId}/reactivate
  if (req.method === 'POST' && subscriberId && action === 'reactivate') {
    const result = await loadOwned(subscriberId);
    if (result === 'not_found') {
      return new Response(JSON.stringify({ error: 'Webhook not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (result === 'forbidden') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    await setCachedJson(webhookKey(subscriberId), { ...result, active: true }, WEBHOOK_TTL);

    return new Response(JSON.stringify({ subscriberId, active: true }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
