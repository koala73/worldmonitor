'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { EVENT_REGISTRY } = require('../constants');
const { SIGNATURE_TOLERANCE_SECONDS, verifySignatureV2 } = require('../lib/hooks');

const appTester = zapier.createAppTester(App);

const AUTH = { apiKey: 'wm_test' };
const SECRET = '7c'.repeat(32);
const DELIVERY_ID = 'whd_0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const OTHER_DELIVERY_ID = 'whd_ffffffffffffffffffffffffffffffff';

// X-WM-Signature-V2 as scripts/lib/shipping-webhook-delivery.mjs and
// deliver-webhook.ts sign it: HMAC(secret, `${timestamp}.${deliveryId}.${event}.${body}`).
const signV2 = (body, { timestamp, deliveryId, event }, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${event}.${body}`).digest('hex')}`;
const signLegacy = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const nowSeconds = (offset = 0) => String(Math.floor(Date.now() / 1000) + offset);

/** A delivery exactly as the worker sends it: legacy and V2 signatures over the same body. */
function signedRequest(body, event, { timestamp = nowSeconds(), deliveryId = DELIVERY_ID } = {}) {
  return {
    method: 'POST',
    content: body,
    headers: {
      'Http-Content-Type': 'application/json',
      'Http-X-Wm-Signature': signLegacy(body),
      'Http-X-Wm-Signature-V2': signV2(body, { timestamp, deliveryId, event }),
      'Http-X-Wm-Timestamp': timestamp,
      'Http-X-Wm-Event': event,
      'Http-X-Wm-Delivery-Id': deliveryId,
    },
  };
}

const CASES = [
  ['news_breaking', 'news.breaking'],
  ['market_move', 'market.move'],
  ['chokepoint_disruption', 'chokepoint.disruption'],
  ['country_risk_surge', 'country.risk_surge'],
];

for (const [key, event] of CASES) {
  const trigger = App.triggers[key].operation;
  const BODY = JSON.stringify({ ...EVENT_REGISTRY.events[event].sample, subscriberId: 'wh_041fef6d0657b56b75fb62cb' });
  const perform = (rawRequest, subscribeData = { secret: SECRET }) =>
    appTester(trigger.perform, { authData: AUTH, subscribeData, cleanedRequest: JSON.parse(BODY), rawRequest });

  describe(`${key}: X-WM-Signature-V2 verification`, () => {
    it('accepts a valid V2 delivery and keys the row by the authenticated delivery id', async () => {
      const rows = await perform(signedRequest(BODY, event, { timestamp: nowSeconds(-(SIGNATURE_TOLERANCE_SECONDS - 30)) }));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, DELIVERY_ID);
      assert.equal(rows[0].deliveryId, DELIVERY_ID);
    });

    it('V2 is authoritative: a valid V2 passes even when the legacy header is wrong', async () => {
      const request = signedRequest(BODY, event);
      request.headers['Http-X-Wm-Signature'] = signLegacy(BODY, 'e'.repeat(64));
      assert.equal((await perform(request)).length, 1);
    });

    it('rejects a replay under a tampered delivery id, with no fallback to the still-valid legacy signature', async () => {
      const request = signedRequest(BODY, event);
      request.headers['Http-X-Wm-Delivery-Id'] = OTHER_DELIVERY_ID;
      assert.equal(request.headers['Http-X-Wm-Signature'], signLegacy(BODY), 'the body-only signature still matches');
      await assert.rejects(() => perform(request), /X-WM-Signature-V2 did not verify/);
    });

    it('rejects a tampered timestamp, event or body, and missing or malformed V2 companions', async () => {
      for (const [header, value] of [
        ['Http-X-Wm-Timestamp', nowSeconds(1)],
        ['Http-X-Wm-Event', event === 'market.move' ? 'news.breaking' : 'market.move'],
        ['Http-X-Wm-Timestamp', undefined],
        ['Http-X-Wm-Timestamp', '1.5e9'],
        ['Http-X-Wm-Event', undefined],
        ['Http-X-Wm-Delivery-Id', undefined],
        ['Http-X-Wm-Delivery-Id', `${DELIVERY_ID}.x`],
        ['Http-X-Wm-Signature-V2', 'sha256=not-hex'],
        ['Http-X-Wm-Signature-V2', ''],
      ]) {
        const request = signedRequest(BODY, event);
        if (value === undefined) delete request.headers[header];
        else request.headers[header] = value;
        await assert.rejects(() => perform(request), /X-WM-Signature-V2 did not verify/, `${header}=${value}`);
      }
      const tampered = signedRequest(BODY, event);
      tampered.content = BODY.replace('"subscriberId":"wh_041fef6d0657b56b75fb62cb"', '"subscriberId":"wh_aaaaaaaaaaaaaaaaaaaaaaaa"');
      await assert.rejects(() => perform(tampered), /X-WM-Signature-V2 did not verify/);
    });

    it('rejects an authentic delivery whose timestamp is outside the 300-second window, past or future', async () => {
      assert.equal(SIGNATURE_TOLERANCE_SECONDS, 300);
      for (const offset of [-(SIGNATURE_TOLERANCE_SECONDS + 1), SIGNATURE_TOLERANCE_SECONDS + 1, -86_400]) {
        await assert.rejects(
          () => perform(signedRequest(BODY, event, { timestamp: nowSeconds(offset) })),
          /X-WM-Timestamp is more than 300 seconds from now/,
          String(offset),
        );
      }
    });

    it('rejects a V2 delivery when the Zap has no stored secret or the secret differs', async () => {
      await assert.rejects(() => perform(signedRequest(BODY, event), {}), /X-WM-Signature-V2 did not verify/);
      await assert.rejects(() => perform(signedRequest(BODY, event), { secret: 'd'.repeat(64) }), /X-WM-Signature-V2 did not verify/);
    });

    it('rejects a legacy-only delivery: no fallback to the body-only signature, even when it verifies', async () => {
      const legacyOnly = signedRequest(BODY, event);
      delete legacyOnly.headers['Http-X-Wm-Signature-V2'];
      delete legacyOnly.headers['Http-X-Wm-Timestamp'];
      assert.equal(legacyOnly.headers['Http-X-Wm-Signature'], signLegacy(BODY), 'the legacy header is genuine');
      await assert.rejects(() => perform(legacyOnly), (err) => JSON.parse(err.message).code === 'InvalidSignature' && JSON.parse(err.message).status === 401);
      const v2Stripped = signedRequest(BODY, event);
      delete v2Stripped.headers['Http-X-Wm-Signature-V2'];
      await assert.rejects(() => perform(v2Stripped), /X-WM-Signature-V2 did not verify/, 'stripping V2 from a captured delivery does not downgrade it');
    });
  });
}

describe('verifySignatureV2', () => {
  const body = '{"a":1}';
  const fields = { timestamp: '1783168496', deliveryId: DELIVERY_ID, event: 'news.breaking' };
  const at = (seconds) => Number(fields.timestamp) * 1000 + seconds * 1000;
  const signature = signV2(body, fields);

  it('accepts at both edges of the window and rejects one second past them', () => {
    for (const s of [-300, 0, 300]) assert.equal(verifySignatureV2(body, { ...fields, signature }, SECRET, at(s)), 'ok', String(s));
    for (const s of [-301, 301]) assert.equal(verifySignatureV2(body, { ...fields, signature }, SECRET, at(s)), 'stale', String(s));
  });

  it('reports a wrong signature as a mismatch even when the timestamp is stale, so staleness is only claimed for authentic deliveries', () => {
    assert.equal(verifySignatureV2(body, { ...fields, signature: signV2(body, fields, 'f'.repeat(64)) }, SECRET, at(10_000)), 'mismatch');
  });

  it('rejects a delivery id that shifts the dot boundaries even though the HMAC input is identical', () => {
    const shifted = { timestamp: fields.timestamp, deliveryId: `${DELIVERY_ID}.news`, event: 'breaking' };
    assert.equal(signV2(body, shifted), signature);
    assert.equal(verifySignatureV2(body, { ...shifted, signature }, SECRET, at(0)), 'mismatch');
  });
});
