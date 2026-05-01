import type {
  ServerContext,
  RegisterWebhookRequest,
  RegisterWebhookResponse,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';
import {
  ApiError,
  ValidationError,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../../../api/_api-key.js';
import { isCallerPremium } from '../../../_shared/premium-check';
import { runRedisPipeline } from '../../../_shared/redis';
import {
  WEBHOOK_TTL,
  VALID_CHOKEPOINT_IDS,
  isBlockedCallbackUrl,
  generateSecret,
  generateSubscriberId,
  webhookKey,
  ownerIndexKey,
  callerFingerprint,
  type WebhookRecord,
} from './webhook-shared';

export async function registerWebhook(
  ctx: ServerContext,
  req: RegisterWebhookRequest,
): Promise<RegisterWebhookResponse> {
  // Webhooks are per-tenant keyed on callerFingerprint(), which hashes the
  // API key. Without forceKey, a Clerk-authenticated pro caller reaches this
  // handler with no API key, callerFingerprint() falls back to 'anon', and
  // every such caller collapses into a shared 'anon' owner bucket — letting
  // one Clerk-session holder enumerate/overwrite other tenants' webhooks.
  // Matches the legacy `api/v2/shipping/webhooks/[subscriberId]{,/[action]}.ts`
  // gate and the documented "X-WorldMonitor-Key required" contract in
  // docs/api-shipping-v2.mdx.
  const apiKeyResult = (await validateApiKey(ctx.request, { forceKey: true })) as {
    valid: boolean; required: boolean; error?: string;
  };
  if (apiKeyResult.required && !apiKeyResult.valid) {
    throw new ApiError(401, apiKeyResult.error ?? 'API key required', '');
  }

  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    throw new ApiError(403, 'PRO subscription required', '');
  }

  const callbackUrl = (req.callbackUrl ?? '').trim();
  if (!callbackUrl) {
    throw new ValidationError([{ field: 'callbackUrl', description: 'callbackUrl is required' }]);
  }

  const ssrfError = isBlockedCallbackUrl(callbackUrl);
  if (ssrfError) {
    throw new ValidationError([{ field: 'callbackUrl', description: ssrfError }]);
  }

  const chokepointIds = Array.isArray(req.chokepointIds) ? req.chokepointIds : [];
  const invalidCp = chokepointIds.find(id => !VALID_CHOKEPOINT_IDS.has(id));
  if (invalidCp) {
    throw new ValidationError([
      { field: 'chokepointIds', description: `Unknown chokepoint ID: ${invalidCp}` },
    ]);
  }

  // alert_threshold is `optional int32` (#3242 followup #4) — undefined means
  // the partner omitted the field, so apply the legacy default of 50. An
  // explicit 0 is preserved (deliver every alert). The 0..100 range is
  // normally enforced by buf.validate at the wire layer, but we re-enforce
  // it here so direct handler calls (internal jobs, test harnesses, future
  // transports that bypass buf.validate) can't store out-of-range values.
  const alertThreshold = req.alertThreshold ?? 50;
  if (alertThreshold < 0 || alertThreshold > 100) {
    throw new ValidationError([
      { field: 'alertThreshold', description: 'alertThreshold must be between 0 and 100' },
    ]);
  }

  const ownerTag = await callerFingerprint(ctx.request);
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
    secret,
  };

  await runRedisPipeline([
    ['SET', webhookKey(newSubscriberId), JSON.stringify(record), 'EX', String(WEBHOOK_TTL)],
    ['SADD', ownerIndexKey(ownerTag), newSubscriberId],
    ['EXPIRE', ownerIndexKey(ownerTag), String(WEBHOOK_TTL)],
  ]);

  return { subscriberId: newSubscriberId, secret };
}
