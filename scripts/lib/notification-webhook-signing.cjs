'use strict';

// Signed delivery headers for customer webhook channels. Shared by both
// producers (notification-relay.cjs, seed-digest-notifications.mjs) so a
// receiver sees one contract regardless of which one sent the event.
//
// Contract (docs/api-notifications.mdx, "Webhook delivery contract"):
//   X-WM-Timestamp: <unix seconds>
//   X-WM-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${deliveryId}.${rawBody}`)>
//   X-WM-Delivery-Id: <uuid>
//   X-WM-Event: <eventType>
// Signing the timestamp with the body lets receivers reject replays older
// than their tolerance window; signing the delivery id too means a replay
// inside that window can't dodge an id-based duplicate check by changing it. Channels registered before signing existed
// have no secret; they still get the delivery-id and event headers so
// receivers can tell an unsigned legacy delivery apart from a forgery.

const { createHmac, randomUUID } = require('node:crypto');

function signWebhookBody(secret, timestamp, deliveryId, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex');
}

/**
 * @param {object} opts
 * @param {string} opts.body          exact bytes that will be POSTed
 * @param {string} opts.eventType
 * @param {string|null|undefined} opts.secret  plaintext signing secret, or none
 * @param {number} [opts.nowMs]
 * @param {string} [opts.deliveryId]
 * @returns {Record<string,string>}
 */
function buildWebhookDeliveryHeaders({ body, eventType, secret, nowMs = Date.now(), deliveryId = randomUUID() }) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const headers = {
    'X-WM-Delivery-Id': deliveryId,
    'X-WM-Event': String(eventType ?? 'unknown'),
    'X-WM-Timestamp': timestamp,
  };
  if (typeof secret === 'string' && secret.length > 0) {
    headers['X-WM-Signature'] = `sha256=${signWebhookBody(secret, timestamp, deliveryId, body)}`;
  }
  return headers;
}

/**
 * Decrypt a channel's stored signing secret. Returns null for legacy channels
 * with no secret. Throws when a stored secret cannot be decrypted, so callers
 * skip the delivery instead of silently sending it unsigned.
 */
function resolveWebhookSigningSecret(decrypt, webhookSecretEnvelope) {
  if (typeof webhookSecretEnvelope !== 'string' || webhookSecretEnvelope.length === 0) return null;
  return decrypt(webhookSecretEnvelope);
}

module.exports = { buildWebhookDeliveryHeaders, resolveWebhookSigningSecret, signWebhookBody };
