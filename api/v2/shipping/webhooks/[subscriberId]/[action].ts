/**
 * POST /api/v2/shipping/webhooks/{subscriberId}/rotate-secret
 * POST /api/v2/shipping/webhooks/{subscriberId}/reactivate
 *
 * Preserved on the legacy path-param URL shape because sebuf does not
 * currently support path-parameter RPC paths; tracked for eventual
 * migration under #3207.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getHeaderApiKey, USER_API_KEY_GATEWAY_VALIDATION_ERROR, validateApiKey } from '../../../../_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../../../../_cors.js';
import { renderBillingVerificationDenial } from '../../../../../server/_shared/entitlement-check';
import { validateUserApiKey } from '../../../../../server/_shared/user-api-key';
import { checkFailClosedScopedIpRateLimit } from '../../../../../server/_shared/rate-limit';
import { resolvePremiumCallerIdentity } from '../../../../../server/_shared/premium-check';
import { getCachedJson, setCachedJson } from '../../../../../server/_shared/redis';
import {
  WEBHOOK_TTL,
  webhookKey,
  callerFingerprint,
  generateSecret,
  type WebhookRecord,
} from '../../../../../server/worldmonitor/shipping/v2/webhook-shared';

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const apiKeyResult = await validateApiKey(req, { forceKey: true });
  if (apiKeyResult.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR) {
    const validationGuard = await checkFailClosedScopedIpRateLimit(
      req, 'user-api-key:pre-auth-validation', 600, '60 s', cors,
    );
    if (validationGuard) return validationGuard;
    const credential = getHeaderApiKey(req);
    let userKey;
    try {
      userKey = credential ? await validateUserApiKey(credential) : null;
    } catch {
      return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
        status: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    if (!userKey) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    apiKeyResult.valid = true;
    apiKeyResult.credential = credential;
  }
  if (apiKeyResult.required && !apiKeyResult.valid) {
    return new Response(JSON.stringify({ error: apiKeyResult.error ?? 'API key required' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const identity = await resolvePremiumCallerIdentity(req);
  if (!identity.isPremium) {
    if (identity.billingDenial) return renderBillingVerificationDenial(identity.billingDenial, cors);
    return new Response(JSON.stringify({ error: 'PRO subscription required' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/');
  const action = parts[parts.length - 1];
  const subscriberId = parts[parts.length - 2];

  if (!subscriberId || !subscriberId.startsWith('wh_')) {
    return new Response(JSON.stringify({ error: 'Webhook not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  if (action !== 'rotate-secret' && action !== 'reactivate') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const record = (await getCachedJson(webhookKey(subscriberId)).catch(() => null)) as WebhookRecord | null;
  if (!record) {
    return new Response(JSON.stringify({ error: 'Webhook not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const ownerHash = await callerFingerprint(req, apiKeyResult.credential);
  if (record.ownerTag !== ownerHash) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (action === 'rotate-secret') {
    const newSecret = await generateSecret();
    await setCachedJson(webhookKey(subscriberId), { ...record, secret: newSecret }, WEBHOOK_TTL);
    return new Response(
      JSON.stringify({ subscriberId, secret: newSecret, rotatedAt: new Date().toISOString() }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  // action === 'reactivate'
  await setCachedJson(webhookKey(subscriberId), { ...record, active: true }, WEBHOOK_TTL);
  return new Response(JSON.stringify({ subscriberId, active: true }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
