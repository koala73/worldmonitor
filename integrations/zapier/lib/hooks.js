'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const { BASE_URL, PATHS, EVENT_REGISTRY, SUBSCRIPTION_RENEW_DAYS } = require('../constants');

const SIGNATURE = EVENT_REGISTRY.subscription.signature;
const SIGNATURE_V2_HEADER = SIGNATURE.v2Header; // X-WM-Signature-V2
const TIMESTAMP_HEADER = SIGNATURE.timestampHeader; // X-WM-Timestamp
const EVENT_HEADER = SIGNATURE.eventHeader; // X-WM-Event
const DELIVERY_ID_HEADER = SIGNATURE.deliveryIdHeader; // X-WM-Delivery-Id
const SIGNATURE_TOLERANCE_SECONDS = SIGNATURE.toleranceSeconds; // 300

/**
 * Registers the Zap's target URL as a WorldMonitor webhook subscription for
 * one event. Zapier stores the returned object as bundle.subscribeData, so it
 * carries the subscriberId (for performUnsubscribe) and the signing secret
 * (for signature verification in perform). WorldMonitor never returns the
 * secret again.
 */
async function subscribe(z, bundle, { eventType, chokepointIds, alertThreshold, minLiveSignal, countries, scope }) {
  const body = { callbackUrl: bundle.targetUrl, eventType, chokepointIds: chokepointIds || [], countries: countries || [] };
  if (Number.isFinite(alertThreshold)) body.alertThreshold = alertThreshold;
  if (Number.isFinite(minLiveSignal) && minLiveSignal > 0) body.minLiveSignal = minLiveSignal;
  // Occurrence events (news.breaking, market.move) carry their filters in
  // `scope`; the server validates the keys against the event's inputSchema and
  // stores the registry defaults for anything left out. Threshold events send
  // no scope, so their bodies stay byte-identical to 1.1.0.
  if (scope && Object.keys(scope).length) body.scope = scope;
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

function hmacHeaderEquals(header, secret, ...parts) {
  const hmac = createHmac('sha256', secret);
  for (const part of parts) hmac.update(part);
  const a = Buffer.from(header);
  const b = Buffer.from(`sha256=${hmac.digest('hex')}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * X-WM-Signature-V2: HMAC over `${timestamp}.${deliveryId}.${event}.${rawBody}`,
 * and the timestamp within SIGNATURE_TOLERANCE_SECONDS of this clock either way.
 * Every header must be one well-formed string; the formats are those in
 * docs/api-shipping-v2.mdx ("Verifying deliveries"), which also keep a
 * crafted delivery id from shifting the `.` boundaries. Returns 'ok',
 * 'mismatch' (malformed or wrong HMAC) or 'stale' (authentic but outside the
 * window, i.e. a replay or a skewed clock).
 */
function verifySignatureV2(rawBody, { signature, timestamp, deliveryId, event }, secret, nowMs = Date.now()) {
  if (typeof rawBody !== 'string' || typeof secret !== 'string' || !secret) return 'mismatch';
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return 'mismatch';
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return 'mismatch';
  if (typeof deliveryId !== 'string' || !/^whd_[0-9a-f]{32}$/.test(deliveryId)) return 'mismatch';
  if (typeof event !== 'string' || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(event)) return 'mismatch';
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return 'mismatch';
  if (!hmacHeaderEquals(signature, secret, `${timestamp}.${deliveryId}.${event}.`, rawBody)) return 'mismatch';
  return Math.abs(Math.floor(nowMs / 1000) - seconds) > SIGNATURE_TOLERANCE_SECONDS ? 'stale' : 'ok';
}

/**
 * Verifies an inbound delivery with the secret Zapier stored at subscribe time
 * and returns the event rows for the Zap, or throws when the delivery cannot
 * be trusted. Every delivery must carry X-WM-Signature-V2 with its
 * X-WM-Timestamp, X-WM-Delivery-Id and X-WM-Event; there is no fallback to the
 * body-only X-WM-Signature, which a captured delivery could be replayed under
 * with a new delivery id or with the V2 headers stripped. Both senders sign V2
 * on every delivery, and this version ships only after they do.
 * The row id is the X-WM-Delivery-Id: WorldMonitor mints it once per crossing
 * or occurrence and reuses it on retries, so a retried POST carries the same
 * id. Zapier does not dedupe REST-hook deliveries itself.
 */
function receive(z, bundle, { eventType }) {
  const raw = bundle.rawRequest || {};
  const headers = raw.headers || {};
  const rawBody = typeof raw.content === 'string' ? raw.content : undefined;
  const secret = bundle.subscribeData && bundle.subscribeData.secret;
  const verdict = verifySignatureV2(rawBody, {
    signature: headerValue(headers, SIGNATURE_V2_HEADER),
    timestamp: headerValue(headers, TIMESTAMP_HEADER),
    deliveryId: headerValue(headers, DELIVERY_ID_HEADER),
    event: headerValue(headers, EVENT_HEADER),
  }, secret);
  if (verdict === 'stale') {
    throw new z.errors.Error(
      `Rejected a delivery whose ${TIMESTAMP_HEADER} is more than ${SIGNATURE_TOLERANCE_SECONDS} seconds from now (a replay, or a skewed clock).`,
      'StaleSignature',
      401,
    );
  }
  if (verdict !== 'ok') {
    throw new z.errors.Error(
      `Rejected a delivery whose ${SIGNATURE_V2_HEADER} did not verify against this Zap's subscription secret (or was missing).`,
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

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** A Zapier list input arrives as an array, or as one comma-separated string when mapped from a prior step. */
function readList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',') : [];
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

/** Scope fields stored by the server, keyed by the registry inputSchema property names. */
function scopeFromInputs(inputs) {
  const scope = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    scope[key] = value;
  }
  return scope;
}

module.exports = {
  SIGNATURE_V2_HEADER,
  TIMESTAMP_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  EVENT_HEADER,
  DELIVERY_ID_HEADER,
  subscribe,
  unsubscribe,
  receive,
  headerValue,
  verifySignatureV2,
  toInteger,
  toNumber,
  readList,
  scopeFromInputs,
};
