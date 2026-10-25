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
import { getHeaderApiKey, USER_API_KEY_GATEWAY_VALIDATION_ERROR, validateApiKey } from '../../../../api/_api-key.js';
import { validateUserApiKey } from '../../../_shared/user-api-key';
import {
  requirePremiumRpcAccess,
} from '../../../_shared/premium-check';
import { pruneOwnerWebhookIndex } from './webhook-owner-index';
import { isOccurrenceEvent, normalizeWebhookScope } from './webhook-scope';
import { runRedisPipeline } from '../../../_shared/redis';
import {
  ALL_INDEX_KEY,
  DEFAULT_EVENT_TYPE,
  MIN_LIVE_SIGNAL_MAX,
  RISK_SURGE_COUNTRIES,
  RISK_SURGE_EVENT_TYPE,
  VALID_EVENT_TYPES,
  WEBHOOK_TTL,
  VALID_CHOKEPOINT_IDS,
  assertCallbackUrlRegistrationSafe,
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
  // API key. Without forceKey, a Clerk-authenticated pro caller would reach
  // this handler with no API key; callerFingerprint() now throws 401 there
  // instead of folding every such caller into a shared 'anon' owner bucket
  // where one Clerk-session holder could enumerate/overwrite other tenants'
  // webhooks. forceKey stays the primary gate; the throw is the backstop.
  // Matches the legacy `api/v2/shipping/webhooks/[subscriberId]{,/[action]}.ts`
  // gate and the documented "X-WorldMonitor-Key required" contract in
  // docs/api-shipping-v2.mdx.
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

  const callbackUrl = (req.callbackUrl ?? '').trim();
  if (!callbackUrl) {
    throw new ValidationError([{ field: 'callbackUrl', description: 'callbackUrl is required' }]);
  }

  try {
    await assertCallbackUrlRegistrationSafe(callbackUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'callbackUrl is not allowed';
    throw new ValidationError([{ field: 'callbackUrl', description: message }]);
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

  // Event type and its scope come from shared/event-triggers.json. The wire
  // default keeps every pre-existing partner body meaning chokepoint alerts.
  const eventType = (req.eventType ?? '').trim() || DEFAULT_EVENT_TYPE;
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new ValidationError([
      { field: 'eventType', description: `Unknown eventType: ${eventType}. Expected one of ${[...VALID_EVENT_TYPES].join(', ')}` },
    ]);
  }
  // Occurrence events (news.breaking, market.move) take their filters in
  // `scope`, validated against the event's inputSchema in the registry with
  // defaults stored on the record. Threshold events accept no scope.
  const scope = normalizeWebhookScope(eventType, req.scope);
  const countries = Array.isArray(req.countries)
    ? [...new Set(req.countries.map((code) => String(code).trim().toUpperCase()).filter(Boolean))]
    : [];
  if (eventType === RISK_SURGE_EVENT_TYPE) {
    const invalidCountry = countries.find((code) => !RISK_SURGE_COUNTRIES.has(code));
    if (invalidCountry) {
      throw new ValidationError([
        { field: 'countries', description: `Unmonitored country code: ${invalidCountry}` },
      ]);
    }
  } else if (countries.length) {
    throw new ValidationError([
      { field: 'countries', description: `countries applies only to ${RISK_SURGE_EVENT_TYPE}` },
    ]);
  }
  const minLiveSignal = req.minLiveSignal ?? 0;
  if (!Number.isInteger(minLiveSignal) || minLiveSignal < 0 || minLiveSignal > MIN_LIVE_SIGNAL_MAX) {
    throw new ValidationError([
      { field: 'minLiveSignal', description: `minLiveSignal must be an integer between 0 and ${MIN_LIVE_SIGNAL_MAX}` },
    ]);
  }
  if (minLiveSignal > 0 && eventType !== DEFAULT_EVENT_TYPE) {
    throw new ValidationError([
      { field: 'minLiveSignal', description: `minLiveSignal applies only to ${DEFAULT_EVENT_TYPE}` },
    ]);
  }

  const ownerTag = await callerFingerprint(ctx.request, apiKeyResult.credential);
  await pruneOwnerWebhookIndex(ownerTag);
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
    eventType,
    ...(eventType === RISK_SURGE_EVENT_TYPE ? { countries } : {}),
    ...(minLiveSignal > 0 ? { minLiveSignal } : {}),
    ...(isOccurrenceEvent(eventType) ? { scope } : {}),
  };

  const results = await runRedisPipeline([
    ['SET', webhookKey(newSubscriberId), JSON.stringify(record), 'EX', String(WEBHOOK_TTL)],
    ['SADD', ownerIndexKey(ownerTag), newSubscriberId],
    ['EXPIRE', ownerIndexKey(ownerTag), String(WEBHOOK_TTL)],
    ['SADD', ALL_INDEX_KEY, newSubscriberId],
  ]);

  if (!Array.isArray(results) || results.length !== 4 || results.some(result => !result || result.error)
    || results[0]?.result !== 'OK'
    || ![0, 1, '0', '1'].includes(results[1]?.result as number | string)
    || (results[2]?.result !== 1 && results[2]?.result !== '1')
    || ![0, 1, '0', '1'].includes(results[3]?.result as number | string)) {
    throw new ApiError(503, 'Webhook registration could not be confirmed', '');
  }

  return { subscriberId: newSubscriberId, secret };
}
