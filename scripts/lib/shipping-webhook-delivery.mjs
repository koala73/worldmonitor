// Mirror of server/worldmonitor/shipping/v2/deliver-webhook.ts for the Railway
// worker, which runs from scripts/ with no TS loader. The wire format must stay
// byte-identical; tests/shipping-webhook-delivery-parity.test.mjs pins it.

import { createHmac, randomBytes } from 'node:crypto';

import {
  SSRF_BLOCKED_ERROR_CODE,
  assertNotificationWebhookDeliveryUrlSafe,
  postJsonWithPinnedAddress,
} from './notification-webhook-ssrf.cjs';

export const SHIPPING_WEBHOOK_EVENT = 'chokepoint.disruption';
export const ALL_INDEX_KEY = 'webhook:all:v1';
export const DELIVERY_FAILURE_CEILING = 5;
// DNS re-resolution has no timeout of its own and the HTTPS sender's 10 s
// starts after it, so one deadline covers both.
export const DELIVERY_DEADLINE_MS = 15_000;

export function webhookKey(subscriberId) {
  return `webhook:sub:${subscriberId}:v1`;
}

export function makeDeliveryId() {
  return `whd_${randomBytes(16).toString('hex')}`;
}

export function buildShippingWebhookDelivery({ record, payload, deliveryId }) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', record.secret).update(body).digest('hex');
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'WorldMonitor-ShippingV2-Webhooks/1.0',
      'x-wm-signature': `sha256=${signature}`,
      'x-wm-delivery-id': deliveryId,
      'x-wm-event': SHIPPING_WEBHOOK_EVENT,
    },
  };
}

function failureCode(error) {
  if (error?.code === SSRF_BLOCKED_ERROR_CODE) return 'ssrf';
  if (/timed out|timeout/i.test(String(error?.message ?? ''))) return 'timeout';
  return 'network';
}

/**
 * Never throws for a delivery failure: the worker counts every failure kind
 * against the subscriber, so it needs the outcome, not an exception.
 *
 * @returns {Promise<{ ok: boolean, status: number, error?: string }>}
 */
export async function deliverShippingWebhook(record, payload, options = {}) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, status: 0, error: 'timeout' }),
      options.deadlineMs ?? DELIVERY_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([attemptDelivery(record, payload, options), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function attemptDelivery(record, payload, options) {
  const deliveryId = options.deliveryId ?? makeDeliveryId();
  try {
    const { url, resolvedAddresses } = await assertNotificationWebhookDeliveryUrlSafe(
      record.callbackUrl,
      options.resolveHostname,
    );
    const { body, headers } = buildShippingWebhookDelivery({ record, payload, deliveryId });
    const response = options.fetchImpl
      ? await options.fetchImpl(url, { method: 'POST', headers, body })
      : await postJsonWithPinnedAddress(url, body, headers, resolvedAddresses);
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `http_${response.status}` };
  } catch (error) {
    if (error?.code === 'WEBHOOK_INVALID_STATUS') {
      return { ok: false, status: error.statusCode, error: `http_${error.statusCode}` };
    }
    return { ok: false, status: 0, error: failureCode(error) };
  }
}
