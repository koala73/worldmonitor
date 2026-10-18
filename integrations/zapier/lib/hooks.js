'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const { BASE_URL, PATHS, EVENT_REGISTRY, SUBSCRIPTION_RENEW_DAYS } = require('../constants');

const SIGNATURE_HEADER = EVENT_REGISTRY.subscription.signature.header; // X-WM-Signature
const EVENT_HEADER = EVENT_REGISTRY.subscription.signature.eventHeader; // X-WM-Event
const DELIVERY_ID_HEADER = EVENT_REGISTRY.subscription.signature.deliveryIdHeader; // X-WM-Delivery-Id

/**
 * Registers the Zap's target URL as a WorldMonitor webhook subscription for
 * one event. Zapier stores the returned object as bundle.subscribeData, so it
 * carries the subscriberId (for performUnsubscribe) and the signing secret
 * (for signature verification in perform). WorldMonitor never returns the
 * secret again.
 */
async function subscribe(z, bundle, { eventType, chokepointIds, alertThreshold, minLiveSignal, countries }) {
  const body = { callbackUrl: bundle.targetUrl, eventType, chokepointIds: chokepointIds || [], countries: countries || [] };
  if (Number.isFinite(alertThreshold)) body.alertThreshold = alertThreshold;
  if (Number.isFinite(minLiveSignal) && minLiveSignal > 0) body.minLiveSignal = minLiveSignal;
  const response = await z.request({ method: 'POST', url: `${BASE_URL}${PATHS.webhooks}`, body });
  const data = response.data || {};
  if (!data.subscriberId || !data.secret) {
    throw new z.errors.Error('WorldMonitor did not return a webhook subscription id and secret.', 'SubscribeFailed', 502);
  }
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_RENEW_DAYS * 86400000);
  return {
    id: data.subscriberId,
    subscriberId: data.subscriberId,
    secret: data.secret,
    eventType,
    expiration_date: expiresAt.toISOString(),
  };
}

/** Deletes the subscription. A 404 means it is already gone, which is fine. */
async function unsubscribe(z, bundle) {
  const subscriberId = bundle.subscribeData && bundle.subscribeData.subscriberId;
  if (!subscriberId) return { deleted: false, reason: 'no subscription recorded' };
  const response = await z.request({
    method: 'DELETE',
    url: `${BASE_URL}${PATHS.webhooks}/${encodeURIComponent(subscriberId)}`,
    skipThrowForStatus: true,
  });
  if (response.status === 404) return { subscriberId, deleted: false, reason: 'already removed' };
  if (response.status >= 400) {
    throw new z.errors.Error(`WorldMonitor refused to delete webhook ${subscriberId}: HTTP ${response.status}`, 'UnsubscribeFailed', response.status);
  }
  return { subscriberId, deleted: true };
}

/** Zapier prefixes raw request headers with `Http-`; look a header up either way. */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    const normalized = key.toLowerCase().replace(/^http[-_]/, '').replace(/_/g, '-');
    if (normalized === wanted) return headers[key];
  }
  return undefined;
}

function signatureMatches(rawBody, header, secret) {
  if (typeof rawBody !== 'string' || typeof header !== 'string' || typeof secret !== 'string' || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies the HMAC on an inbound delivery with the secret Zapier stored at
 * subscribe time and returns the event rows for the Zap, or throws when the
 * delivery cannot be trusted. The row id is the X-WM-Delivery-Id: WorldMonitor
 * mints it once per crossing and reuses it on retries, so a retried POST
 * carries the same id. Zapier does not dedupe REST-hook deliveries itself.
 */
function receive(z, bundle, { eventType }) {
  const raw = bundle.rawRequest || {};
  const headers = raw.headers || {};
  const rawBody = typeof raw.content === 'string' ? raw.content : undefined;
  const secret = bundle.subscribeData && bundle.subscribeData.secret;
  const signature = headerValue(headers, SIGNATURE_HEADER);
  if (rawBody === undefined || !secret || !signatureMatches(rawBody, signature, secret)) {
    throw new z.errors.Error(
      `Rejected a delivery whose ${SIGNATURE_HEADER} did not verify against this Zap's subscription secret.`,
      'InvalidSignature',
      401,
    );
  }
  const event = headerValue(headers, EVENT_HEADER);
  if (event && event !== eventType) return [];
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new z.errors.Error('Delivery body was not JSON.', 'InvalidPayload', 400);
  }
  const deliveryId = headerValue(headers, DELIVERY_ID_HEADER);
  const id = typeof deliveryId === 'string' && deliveryId ? deliveryId : `${eventType}:${payload.subscriberId}:${payload.triggeredAt}`;
  return [{ id, eventType, deliveryId: deliveryId || null, ...payload }];
}

function toInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

module.exports = {
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_ID_HEADER,
  subscribe,
  unsubscribe,
  receive,
  headerValue,
  signatureMatches,
  toInteger,
};
