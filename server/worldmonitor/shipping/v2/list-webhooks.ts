import type {
  ServerContext,
  ListWebhooksRequest,
  ListWebhooksResponse,
  WebhookSummary,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../../../api/_api-key.js';
import { isCallerPremium } from '../../../_shared/premium-check';
import { runRedisPipeline } from '../../../_shared/redis';
import {
  webhookKey,
  ownerIndexKey,
  callerFingerprint,
  type WebhookRecord,
} from './webhook-shared';

export async function listWebhooks(
  ctx: ServerContext,
  _req: ListWebhooksRequest,
): Promise<ListWebhooksResponse> {
  // Without forceKey, Clerk-authenticated pro callers reach this handler with
  // no API key, callerFingerprint() returns the 'anon' fallback, and the
  // ownerTag !== ownerHash defense-in-depth below collapses because both
  // sides equal 'anon' — exposing every 'anon'-bucket tenant's webhooks to
  // every Clerk-session holder. See registerWebhook for full rationale.
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

  const ownerHash = await callerFingerprint(ctx.request);
  const smembersResult = await runRedisPipeline([['SMEMBERS', ownerIndexKey(ownerHash)]]);
  const memberIds = (smembersResult[0]?.result as string[] | null) ?? [];

  if (memberIds.length === 0) {
    return { webhooks: [] };
  }

  const getResults = await runRedisPipeline(memberIds.map(id => ['GET', webhookKey(id)]));
  const webhooks: WebhookSummary[] = [];
  for (const r of getResults) {
    if (!r.result || typeof r.result !== 'string') continue;
    try {
      const record = JSON.parse(r.result) as WebhookRecord;
      if (record.ownerTag !== ownerHash) continue;
      webhooks.push({
        subscriberId: record.subscriberId,
        callbackUrl: record.callbackUrl,
        chokepointIds: record.chokepointIds,
        alertThreshold: record.alertThreshold,
        createdAt: record.createdAt,
        active: record.active,
      });
    } catch {
      // skip malformed
    }
  }

  return { webhooks };
}
