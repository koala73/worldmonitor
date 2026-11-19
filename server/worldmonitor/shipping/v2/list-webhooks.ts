import type {
  ServerContext,
  ListWebhooksRequest,
  ListWebhooksResponse,
  WebhookSummary,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

// @ts-expect-error — JS module, no declaration file
import { getHeaderApiKey, USER_API_KEY_GATEWAY_VALIDATION_ERROR, validateApiKey } from '../../../../api/_api-key.js';
import { validateUserApiKey } from '../../../_shared/user-api-key';
import {
  requirePremiumRpcAccess,
} from '../../../_shared/premium-check';
import { readOwnerWebhooks } from './webhook-owner-index';
import {
  callerFingerprint,
  recordEventType,
  type WebhookRecord,
} from './webhook-shared';

export async function listWebhooks(
  ctx: ServerContext,
  _req: ListWebhooksRequest,
): Promise<ListWebhooksResponse> {
  // Without forceKey, Clerk-authenticated pro callers would reach this handler
  // with no API key. callerFingerprint() now throws 401 in that case rather
  // than folding such callers into a shared 'anon' owner bucket, but the
  // forceKey gate stays the primary control. See registerWebhook for rationale.
  const apiKeyResult = (await validateApiKey(ctx.request, { forceKey: true })) as {
    valid: boolean; required: boolean; error?: string; credential?: string;
  };
  if (apiKeyResult.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR) {
    const credential = getHeaderApiKey(ctx.request) as string;
    let userKey;
    try {
      userKey = credential ? await validateUserApiKey(credential) : null;
    } catch {
      throw new ApiError(503, 'Service temporarily unavailable', '');
    }
    if (!userKey) throw new ApiError(401, 'Invalid API key', '');
    // Revalidate the credential rather than trusting a caller-supplied user ID.
    apiKeyResult.valid = true;
    apiKeyResult.credential = credential;
  }
  if (apiKeyResult.required && !apiKeyResult.valid) {
    throw new ApiError(401, apiKeyResult.error ?? 'API key required', '');
  }

  await requirePremiumRpcAccess(ctx.request, ApiError, 'PRO subscription required');

  const ownerHash = await callerFingerprint(ctx.request, apiKeyResult.credential);
  const records = await readOwnerWebhooks(ownerHash);
  const webhooks: WebhookSummary[] = [];
  for (const value of records) {
    try {
      const record = JSON.parse(value) as WebhookRecord;
      if (record.ownerTag !== ownerHash) continue;
      webhooks.push({
        subscriberId: record.subscriberId,
        callbackUrl: record.callbackUrl,
        chokepointIds: record.chokepointIds,
        alertThreshold: record.alertThreshold,
        createdAt: record.createdAt,
        active: record.active,
        eventType: recordEventType(record),
        countries: Array.isArray(record.countries) ? record.countries : [],
        minLiveSignal: record.minLiveSignal ?? 0,
        // Stored keys only (the event's own inputSchema properties, defaults
        // applied). The generated type lists every repeated field, but proto3
        // JSON omits empty repeated fields, so the wire shape is the same.
        ...(record.scope ? { scope: record.scope as unknown as WebhookSummary['scope'] } : {}),
      });
    } catch {
      // skip malformed
    }
  }

  return { webhooks };
}
