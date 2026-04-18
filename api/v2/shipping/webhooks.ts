/**
 * POST /api/v2/shipping/webhooks — Register a webhook for chokepoint disruption alerts.
 * GET  /api/v2/shipping/webhooks — List webhooks for the authenticated caller.
 *
 * Payload: { callbackUrl, chokepointIds[], alertThreshold }
 * Response: { subscriberId, secret }
 *
 * Security:
 * - X-WorldMonitor-Key required (forceKey: true)
 * - SSRF prevention: callbackUrl hostname is validated against private IP ranges.
 *   LIMITATION: DNS rebinding is not mitigated in the edge runtime (no DNS resolution
 *   at registration time). The delivery worker MUST resolve the URL before sending and
 *   re-check it against PRIVATE_HOSTNAME_PATTERNS. HTTPS-only is required to limit
 *   exposure (TLS certs cannot be issued for private IPs via public CAs).
 * - HMAC signatures: webhook deliveries include X-WM-Signature: sha256=<HMAC-SHA256(payload, secret)>
 * - Ownership: SHA-256 of the caller's API key is stored as ownerTag; an owner index (Redis Set)
 *   enables list queries without a full scan.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../../_cors.js';
import { isCallerPremium } from '../../../server/_shared/premium-check';
import { getCachedJson, setCachedJson, runRedisPipeline } from '../../../server/_shared/redis';
import { CHOKEPOINT_REGISTRY } from '../../../server/_shared/chokepoint-registry';

const WEBHOOK_TTL = 86400 * 30; // 30 days
const VALID_CHOKEPOINT_IDS = new Set(CHOKEPOINT_REGISTRY.map(c => c.id));

// Private IP ranges + known cloud metadata hostnames blocked at registration.
// NOTE: DNS rebinding bypass is not mitigated here (no DNS resolution in edge runtime).
// The delivery worker must re-validate the resolved IP before sending.
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,   // link-local + AWS/GCP/Azure IMDS
  /^fd[0-9a-f]{2}:/i,       // IPv6 ULA (fd00::/8)
  /^fe80:/i,                 // IPv6 link-local
  /^::1$/,                   // IPv6 loopback
  /^0\.0\.0\.0$/,
  /^0\.\d+\.\d+\.\d+$/,     // RFC 1122 "this network"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/,  // RFC 6598 shared address
];

// Known cloud metadata endpoints that must be blocked explicitly even if the
// IP regex above misses a future alias or IPv6 variant.
const BLOCKED_METADATA_HOSTNAMES = new Set([
  '169.254.169.254',          // AWS/Azure/GCP IMDS (IPv4)
  'metadata.google.internal', // GCP metadata server
  'metadata.internal',        // GCP alternative alias
  'instance-data',            // OpenStack metadata
  'metadata',                 // generic cloud metadata alias
  'computemetadata',          // GCP legacy
  'link-local.s3.amazonaws.com',
]);

function isBlockedCallbackUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'callbackUrl is not a valid URL';
  }

  // HTTPS is required — TLS certs cannot be issued for private IPs via public CAs,
  // which prevents the most common DNS-rebinding variant in practice.
  if (parsed.protocol !== 'https:') {
    return 'callbackUrl must use https';
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_METADATA_HOSTNAMES.has(hostname)) {
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

function ownerIndexKey(ownerHash: string): string {
  return `webhook:owner:${ownerHash}:v1`;
}

/** SHA-256 hash of the caller's API key — used as ownerTag and owner index key. Never secret. */
async function callerFingerprint(req: Request): Promise<string> {
  const key =
    req.headers.get('X-WorldMonitor-Key') ??
    req.headers.get('X-Api-Key') ??
    '';
  if (!key) return 'anon';
  const encoded = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

interface WebhookRecord {
  subscriberId: string;
  ownerTag: string;      // SHA-256 hash of the registrant's API key for ownership checks
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

    const ownerTag = await callerFingerprint(req);
    const newSubscriberId = generateSubscriberId();
    const secret = await generateSecret();

    const record: WebhookRecord = {
      subscriberId: newSubscriberId,
      ownerTag,
      callbackUrl,
      chokepointIds: chokepointIds.length ? chokepointIds : [...VALID_CHOKEPOINT_IDS],
      alertThreshold,
      createdAt: new Date().toISOString(),
      active: true,
      secret, // persisted so delivery workers can compute HMAC signatures
    };

    // Persist record + update owner index (Redis Set) atomically via pipeline.
    // raw = false so all keys are prefixed consistently with getCachedJson reads.
    await runRedisPipeline([
      ['SET', webhookKey(newSubscriberId), JSON.stringify(record), 'EX', String(WEBHOOK_TTL)],
      ['SADD', ownerIndexKey(ownerTag), newSubscriberId],
      ['EXPIRE', ownerIndexKey(ownerTag), String(WEBHOOK_TTL)],
    ]);

    return new Response(JSON.stringify({ subscriberId: newSubscriberId, secret }), {
      status: 201,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Helper: load record + verify ownership in one place
  async function loadOwned(subId: string): Promise<WebhookRecord | 'not_found' | 'forbidden'> {
    const record = await getCachedJson(webhookKey(subId)).catch(() => null) as WebhookRecord | null;
    if (!record) return 'not_found';
    const ownerHash = await callerFingerprint(req);
    if (record.ownerTag !== ownerHash) return 'forbidden';
    return record;
  }

  // GET /api/v2/shipping/webhooks — List caller's webhooks
  if (req.method === 'GET' && !subscriberId) {
    const ownerHash = await callerFingerprint(req);
    const smembersResult = await runRedisPipeline([['SMEMBERS', ownerIndexKey(ownerHash)]]);
    const memberIds = (smembersResult[0]?.result as string[] | null) ?? [];

    if (memberIds.length === 0) {
      return new Response(JSON.stringify({ webhooks: [] }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const getResults = await runRedisPipeline(memberIds.map(id => ['GET', webhookKey(id)]));
    const webhooks = getResults
      .map((r) => {
        if (!r.result || typeof r.result !== 'string') return null;
        try {
          const record = JSON.parse(r.result) as WebhookRecord;
          if (record.ownerTag !== ownerHash) return null; // defensive ownership check
          return {
            subscriberId: record.subscriberId,
            callbackUrl: record.callbackUrl,
            chokepointIds: record.chokepointIds,
            alertThreshold: record.alertThreshold,
            createdAt: record.createdAt,
            active: record.active,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return new Response(JSON.stringify({ webhooks }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
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
