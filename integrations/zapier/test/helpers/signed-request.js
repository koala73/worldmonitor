'use strict';

const { createHmac } = require('node:crypto');

const SIGNED_HEADERS = ['Http-X-Wm-Timestamp', 'Http-X-Wm-Delivery-Id', 'Http-X-Wm-Event'];
const SIGNATURE_HEADERS = ['Http-X-Wm-Signature', 'Http-X-Wm-Signature-V2'];

/** X-WM-Signature-V2 as the senders build it: HMAC(secret, `${timestamp}.${deliveryId}.${event}.${body}`). */
function signV2(body, { timestamp, deliveryId, event }, secret) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${event}.${body}`).digest('hex')}`;
}

function signLegacy(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function nowSeconds(offset = 0) {
  return String(Math.floor(Date.now() / 1000) + offset);
}

/**
 * A Zapier rawRequest for a delivery as scripts/lib/shipping-webhook-delivery.mjs
 * sends it: both signatures, the timestamp, delivery id and event, under the
 * `Http-` prefix Zapier adds. Overrides of the timestamp, delivery id or event
 * are signed (a genuine delivery with those values); overrides of either
 * signature header replace it after signing. An `undefined` override removes
 * the header.
 */
function signedRequest(body, { secret, event, deliveryId, overrides = {} }) {
  const headers = {
    'Http-Content-Type': 'application/json',
    'Http-X-Wm-Timestamp': nowSeconds(),
    'Http-X-Wm-Delivery-Id': deliveryId,
    'Http-X-Wm-Event': event,
  };
  for (const name of SIGNED_HEADERS) if (name in overrides) headers[name] = overrides[name];
  headers['Http-X-Wm-Signature'] = signLegacy(body, secret);
  headers['Http-X-Wm-Signature-V2'] = signV2(body, {
    timestamp: headers['Http-X-Wm-Timestamp'],
    deliveryId: headers['Http-X-Wm-Delivery-Id'],
    event: headers['Http-X-Wm-Event'],
  }, secret);
  for (const name of SIGNATURE_HEADERS) if (name in overrides) headers[name] = overrides[name];
  for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name];
  return { method: 'POST', content: body, headers };
}

module.exports = { signV2, signLegacy, nowSeconds, signedRequest };
