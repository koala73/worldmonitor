import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { deliverShippingV2Webhook } from '../server/worldmonitor/shipping/v2/deliver-webhook.ts';
import * as shared from '../server/worldmonitor/shipping/v2/webhook-shared.ts';
import {
  ALL_INDEX_KEY,
  DELIVERY_FAILURE_CEILING,
  buildShippingWebhookDelivery,
  deliverShippingWebhook,
  makeDeliveryId,
  webhookKey,
} from '../scripts/lib/shipping-webhook-delivery.mjs';

const record = {
  subscriberId: 'wh_abc123456789012345678901',
  ownerTag: 'owner',
  callbackUrl: 'https://hooks.example.com/wm?tenant=1',
  chokepointIds: ['hormuz_strait'],
  alertThreshold: 60,
  createdAt: '2026-04-01T00:00:00.000Z',
  active: true,
  secret: 'f'.repeat(64),
};
const payload = {
  subscriberId: record.subscriberId,
  chokepointId: 'hormuz_strait',
  score: 74,
  alertThreshold: 60,
  triggeredAt: '2026-10-17T12:00:00.000Z',
  reason: 'navigational_warning',
  details: { name: 'Strait of Hormuz', activeWarnings: 3, previousScore: 41, wowChangePct: null },
};
const resolveHostname = async () => ['93.184.216.34'];
const nowMs = Date.parse('2026-10-18T06:00:00.999Z');

function signatureV2(body, headers) {
  const message = `${headers['x-wm-timestamp']}.${headers['x-wm-delivery-id']}.${headers['x-wm-event']}.${body}`;
  return 'sha256=' + createHmac('sha256', record.secret).update(message).digest('hex');
}

function capture() {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(null, { status: 204 });
  };
  return { seen, fetchImpl };
}

describe('shipping webhook delivery parity (TS sender vs Railway worker)', () => {
  it('sends the same URL, body, and headers for the same delivery', async () => {
    const ts = capture();
    const mjs = capture();
    await deliverShippingV2Webhook(record, payload, { nowMs, deliveryId: 'whd_parity', fetchImpl: ts.fetchImpl, resolveHostname });
    const outcome = await deliverShippingWebhook(record, payload, { nowMs, deliveryId: 'whd_parity', fetchImpl: mjs.fetchImpl, resolveHostname });
    assert.deepEqual(outcome, { ok: true, status: 204 });
    assert.deepEqual(mjs.seen, ts.seen);
    assert.equal(ts.seen.length, 1);

    const built = buildShippingWebhookDelivery({ record, payload, nowMs, deliveryId: 'whd_parity' });
    assert.equal(built.body, ts.seen[0].body);
    assert.deepEqual(built.headers, ts.seen[0].headers);
  });

  it('sends the same event header for a country.risk_surge delivery', async () => {
    const riskPayload = {
      subscriberId: record.subscriberId,
      countryCode: 'IR',
      countryName: 'Iran',
      score: 84,
      previousScore: 60,
      delta24h: 24,
      trend: 'TREND_DIRECTION_RISING',
      advisoryLevel: 'do-not-travel',
      triggeredAt: '2026-10-01T04:49:00.000Z',
      reason: 'risk_surge',
      details: { riseThreshold: 15, floor: 50 },
    };
    const ts = capture();
    const mjs = capture();
    await deliverShippingV2Webhook(record, riskPayload, { nowMs, deliveryId: 'whd_parity2', event: 'country.risk_surge', fetchImpl: ts.fetchImpl, resolveHostname });
    await deliverShippingWebhook(record, riskPayload, { nowMs, deliveryId: 'whd_parity2', event: 'country.risk_surge', fetchImpl: mjs.fetchImpl, resolveHostname });
    assert.deepEqual(mjs.seen, ts.seen);
    assert.equal(ts.seen[0].headers['x-wm-event'], 'country.risk_surge');
    // The default stays the chokepoint event for every caller that passes no event.
    assert.equal(buildShippingWebhookDelivery({ record, payload, deliveryId: 'x' }).headers['x-wm-event'], 'chokepoint.disruption');
  });

  for (const [name, send] of [['API', deliverShippingV2Webhook], ['worker', deliverShippingWebhook]]) {
    it(`${name} signs a generated delivery id and the current send time by default`, async () => {
      const { seen, fetchImpl } = capture();
      const before = Math.floor(Date.now() / 1000);
      await send(record, payload, { fetchImpl, resolveHostname });
      const { body, headers } = seen[0];
      assert.match(headers['x-wm-delivery-id'], /^whd_[0-9a-f]{32}$/);
      assert.ok(Number(headers['x-wm-timestamp']) >= before);
      assert.ok(Number(headers['x-wm-timestamp']) <= Math.floor(Date.now() / 1000));
      assert.equal(headers['x-wm-signature-v2'], signatureV2(body, headers));
    });

    for (const event of ['chokepoint.disruption', 'country.risk_surge']) {
      it(`${name} authenticates timestamp, delivery id, event, and raw UTF-8 body for ${event}`, async () => {
        const { seen, fetchImpl } = capture();
        await send(record, { ...payload, reason: '航行警告' }, {
          nowMs, deliveryId: 'whd_signed', event, fetchImpl, resolveHostname,
        });
        const { body, headers } = seen[0];
        assert.equal(headers['x-wm-timestamp'], String(Math.floor(nowMs / 1000)));
        assert.equal(headers['x-wm-signature-v2'], signatureV2(body, headers));
        assert.equal(headers['x-wm-signature'], 'sha256=' + createHmac('sha256', record.secret).update(body).digest('hex'));
        for (const [field, value] of [
          ['x-wm-timestamp', String(Math.floor(nowMs / 1000) + 1)],
          ['x-wm-delivery-id', 'whd_replayed'],
          ['x-wm-event', event === 'country.risk_surge' ? 'chokepoint.disruption' : 'country.risk_surge'],
        ]) {
          assert.notEqual(headers['x-wm-signature-v2'], signatureV2(body, { ...headers, [field]: value }), field);
        }
        assert.notEqual(headers['x-wm-signature-v2'], signatureV2(body + ' ', headers));
      });
    }

    it(`${name} refreshes the signed timestamp on a retry with the same delivery id`, async () => {
      const { seen, fetchImpl } = capture();
      for (const attemptMs of [nowMs, nowMs + 300_000]) {
        await send(record, payload, { nowMs: attemptMs, deliveryId: 'whd_retry', fetchImpl, resolveHostname });
      }
      assert.equal(seen[0].headers['x-wm-delivery-id'], seen[1].headers['x-wm-delivery-id']);
      assert.notEqual(seen[0].headers['x-wm-timestamp'], seen[1].headers['x-wm-timestamp']);
      assert.notEqual(seen[0].headers['x-wm-signature-v2'], seen[1].headers['x-wm-signature-v2']);
    });
  }

  it('generates delivery ids in the documented whd_<32 hex> shape', () => {
    assert.match(makeDeliveryId(), /^whd_[0-9a-f]{32}$/);
  });

  it('refuses private and loopback callbacks without sending', async () => {
    for (const [callbackUrl, addresses] of [
      ['https://127.0.0.1/hook', ['127.0.0.1']],
      ['https://localhost/hook', ['127.0.0.1']],
      ['https://hooks.example.com/hook', ['10.0.0.9']],
      ['https://hooks.example.com/hook', ['93.184.216.34', '169.254.169.254']],
      ['http://hooks.example.com/hook', ['93.184.216.34']],
    ]) {
      const { seen, fetchImpl } = capture();
      const outcome = await deliverShippingWebhook({ ...record, callbackUrl }, payload, {
        fetchImpl, resolveHostname: async () => addresses,
      });
      assert.deepEqual(outcome, { ok: false, status: 0, error: 'ssrf' }, callbackUrl);
      assert.equal(seen.length, 0, `${callbackUrl} must not be fetched`);
    }
  });

  it('reports non-2xx and transport failures as outcomes', async () => {
    const http = await deliverShippingWebhook(record, payload, {
      resolveHostname, fetchImpl: async () => new Response('busy', { status: 503 }),
    });
    assert.deepEqual(http, { ok: false, status: 503, error: 'http_503' });
    const timeout = await deliverShippingWebhook(record, payload, {
      resolveHostname, fetchImpl: async () => { throw new Error('webhook delivery timed out'); },
    });
    assert.deepEqual(timeout, { ok: false, status: 0, error: 'timeout' });
  });

  it('shares storage keys and the failure ceiling with the API', () => {
    assert.equal(ALL_INDEX_KEY, shared.ALL_INDEX_KEY);
    assert.equal(DELIVERY_FAILURE_CEILING, shared.DELIVERY_FAILURE_CEILING);
    assert.equal(webhookKey(record.subscriberId), shared.webhookKey(record.subscriberId));
  });
});
