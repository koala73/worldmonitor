'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { signedRequest } = require('./helpers/signed-request');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);
const trigger = App.triggers.chokepoint_disruption.operation;

const AUTH = { apiKey: 'wm_test' };
const TARGET = 'https://hooks.zapier.com/hooks/standard/1/abc/';
const SECRET = '9f'.repeat(32);

// Recorded in production on 2026-10-17 (issue #9217 acceptance): the first
// chokepoint.disruption delivery the worker ever sent, to a throwaway
// receiver; only the receiver URL is scrubbed. Signed here with a fixture
// secret because the real one belongs to that subscription.
const RECORDED_BODY = JSON.stringify({
  subscriberId: 'wh_041fef6d0657b56b75fb62cb',
  chokepointId: 'suez',
  score: 35,
  alertThreshold: 0,
  triggeredAt: '2026-10-17T12:02:07.248Z',
  reason: 'navigational_warning',
  details: {
    name: 'Suez Canal', status: 'yellow', activeWarnings: 1, aisDisruptions: 0, congestionLevel: 'normal',
    warRiskTier: 'WAR_RISK_TIER_HIGH', wowChangePct: null, previousScore: null, scoresFetchedAt: '2026-10-17T12:00:06.018Z',
  },
});
const RECORDED_DELIVERY_ID = 'whd_74f1d94e09a3968ee447b2a33513522b';

const rawRequest = (body, overrides = {}) => signedRequest(body, { secret: SECRET, event: 'chokepoint.disruption', deliveryId: RECORDED_DELIVERY_ID, overrides });

describe('trigger chokepoint_disruption (REST hook)', () => {
  afterEach(() => nock.cleanAll());

  it('subscribes the Zap target URL for one chokepoint with the threshold and live-signal floor', async () => {
    let posted;
    nock(BASE_URL)
      .post(PATHS.webhooks, (body) => { posted = body; return true; })
      .reply(200, { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET });

    const result = await appTester(trigger.performSubscribe, {
      authData: AUTH,
      targetUrl: TARGET,
      inputData: { chokepoint: 'hormuz_strait', alert_threshold: '60', min_live_signal: '15' },
    });

    assert.deepEqual(posted, {
      callbackUrl: TARGET,
      eventType: 'chokepoint.disruption',
      chokepointIds: ['hormuz_strait'],
      countries: [],
      alertThreshold: 60,
      minLiveSignal: 15,
    });
    assert.equal(result.id, 'wh_041fef6d0657b56b75fb62cb');
    assert.equal(result.subscriberId, 'wh_041fef6d0657b56b75fb62cb');
    assert.equal(result.secret, SECRET);
    assert.ok(Date.parse(result.expiration_date) > Date.now() + 28 * 86400000, 'renews before the 30-day TTL');
  });

  it('applies the registry defaults (threshold 50, live floor 15) when the fields are blank', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_x', secret: SECRET });
    await appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: { chokepoint: 'suez', alert_threshold: '', min_live_signal: '' } });
    assert.equal(posted.alertThreshold, 50);
    assert.equal(posted.minLiveSignal, 15);
  });

  it('unsubscribes by deleting the stored subscription and tolerates one already removed', async () => {
    nock(BASE_URL).delete(`${PATHS.webhooks}/wh_041fef6d0657b56b75fb62cb`).reply(200, { subscriberId: 'wh_041fef6d0657b56b75fb62cb', deleted: true });
    const ok = await appTester(trigger.performUnsubscribe, { authData: AUTH, subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET } });
    assert.deepEqual(ok, { subscriberId: 'wh_041fef6d0657b56b75fb62cb', deleted: true });

    nock(BASE_URL).delete(`${PATHS.webhooks}/wh_gone`).reply(404, { error: 'Webhook not found' });
    const gone = await appTester(trigger.performUnsubscribe, { authData: AUTH, subscribeData: { subscriberId: 'wh_gone', secret: SECRET } });
    assert.equal(gone.deleted, false);
  });

  it('accepts the recorded production delivery when the signature verifies and uses X-WM-Delivery-Id as the row id', async () => {
    const rows = await appTester(trigger.perform, {
      authData: AUTH,
      subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET },
      cleanedRequest: JSON.parse(RECORDED_BODY),
      rawRequest: rawRequest(RECORDED_BODY),
    });
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.id, RECORDED_DELIVERY_ID);
    assert.equal(row.deliveryId, RECORDED_DELIVERY_ID);
    assert.equal(row.eventType, 'chokepoint.disruption');
    assert.equal(row.chokepointId, 'suez');
    assert.equal(row.score, 35);
    assert.equal(row.reason, 'navigational_warning');
    assert.equal(row.details.name, 'Suez Canal');
    assert.equal(row.details.scoresFetchedAt, '2026-10-17T12:00:06.018Z');
  });

  it('rejects a delivery whose signature does not match the subscription secret', async () => {
    for (const headers of [
      { 'Http-X-Wm-Signature-V2': signedRequest(RECORDED_BODY, { secret: 'a'.repeat(64), event: 'chokepoint.disruption', deliveryId: RECORDED_DELIVERY_ID }).headers['Http-X-Wm-Signature-V2'] },
      { 'Http-X-Wm-Signature-V2': 'sha256=not-hex' },
      { 'Http-X-Wm-Signature-V2': undefined },
    ]) {
      await assert.rejects(
        () => appTester(trigger.perform, {
          authData: AUTH,
          subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET },
          cleanedRequest: JSON.parse(RECORDED_BODY),
          rawRequest: rawRequest(RECORDED_BODY, headers),
        }),
        /did not verify/,
      );
    }
    // A tampered body with the original signature must fail too.
    const tampered = RECORDED_BODY.replace('"score":35', '"score":99');
    await assert.rejects(
      () => appTester(trigger.perform, {
        authData: AUTH,
        subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET },
        cleanedRequest: JSON.parse(tampered),
        rawRequest: { ...rawRequest(RECORDED_BODY), content: tampered },
      }),
      /did not verify/,
    );
  });

  it('rejects a delivery when the Zap has no stored secret', async () => {
    await assert.rejects(
      () => appTester(trigger.perform, {
        authData: AUTH,
        subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb' },
        cleanedRequest: JSON.parse(RECORDED_BODY),
        rawRequest: rawRequest(RECORDED_BODY),
      }),
      /did not verify/,
    );
  });

  it('ignores a verified delivery for another event type', async () => {
    const rows = await appTester(trigger.perform, {
      authData: AUTH,
      subscribeData: { subscriberId: 'wh_x', secret: SECRET },
      cleanedRequest: JSON.parse(RECORDED_BODY),
      rawRequest: rawRequest(RECORDED_BODY, { 'Http-X-Wm-Event': 'country.risk_surge' }),
    });
    assert.deepEqual(rows, []);
  });

  it('retries carry the same delivery id, so one disruption is one row id', async () => {
    const first = await appTester(trigger.perform, {
      authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(RECORDED_BODY), rawRequest: rawRequest(RECORDED_BODY),
    });
    const retried = JSON.stringify({ ...JSON.parse(RECORDED_BODY), score: 40, details: { ...JSON.parse(RECORDED_BODY).details, previousScore: 35 } });
    const second = await appTester(trigger.perform, {
      authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(retried), rawRequest: rawRequest(retried),
    });
    assert.equal(first[0].id, second[0].id, 'the worker keeps X-WM-Delivery-Id across retries; Zapier does not dedupe hooks, so the id is the consumer dedupe key');
  });

  it('performList shapes live chokepoint status like a delivery with unique ids', async () => {
    // Recorded from supply_chain:chokepoints:v4 on 2026-10-17 (trimmed).
    nock(BASE_URL).get(PATHS.chokepointStatus).reply(200, {
      chokepoints: [
        { id: 'suez', name: 'Suez Canal', disruptionScore: 35, status: 'yellow', activeWarnings: 1, aisDisruptions: 0, congestionLevel: 'normal', warRiskTier: 'WAR_RISK_TIER_HIGH', transitSummary: { todayCountsAvailable: false, wowChangePct: -3.3 } },
        { id: 'hormuz_strait', name: 'Strait of Hormuz', disruptionScore: 85, status: 'red', activeWarnings: 0, aisDisruptions: 1, congestionLevel: 'high', warRiskTier: 'WAR_RISK_TIER_WAR_ZONE', transitSummary: { todayCountsAvailable: true, wowChangePct: 52.6 } },
      ],
      fetchedAt: '2026-10-17T12:15:26.890Z',
      upstreamUnavailable: false,
    });
    const rows = await appTester(trigger.performList, { authData: AUTH, inputData: { chokepoint: 'hormuz_strait', alert_threshold: '50' } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'sample:hormuz_strait:2026-10-17T12:15:26.890Z');
    assert.equal(rows[0].reason, 'ais_congestion_spike');
    assert.equal(rows[0].details.wowChangePct, 52.6);
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(trigger.sample).sort(), 'sample rows and deliveries share one field set');

    nock(BASE_URL).get(PATHS.chokepointStatus).reply(200, { chokepoints: [{ id: 'suez', disruptionScore: 35 }, { id: 'panama', disruptionScore: 0 }], fetchedAt: 't' });
    const all = await appTester(trigger.performList, { authData: AUTH, inputData: {} });
    assert.equal(new Set(all.map((r) => r.id)).size, all.length);
  });
});
