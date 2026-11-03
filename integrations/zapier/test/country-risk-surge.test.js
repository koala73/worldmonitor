'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { signedRequest } = require('./helpers/signed-request');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);
const trigger = App.triggers.country_risk_surge.operation;

const AUTH = { apiKey: 'wm_test' };
const TARGET = 'https://hooks.zapier.com/hooks/standard/1/def/';
const SECRET = '7c'.repeat(32);
const DELIVERY_ID = 'whd_3c1b7f5e9d2a4c6e8f0b1d3a5c7e9f1b';

// Payload the worker builds (scripts/shipping-webhook-worker.mjs
// planRiskSurgeRecord) for the largest surge in the 90-day backtest archive:
// Iran, 2026-10-01 04:49 UTC, index 60 -> 84.
const BODY = JSON.stringify({
  subscriberId: 'wh_041fef6d0657b56b75fb62cb',
  countryCode: 'IR',
  countryName: 'Iran',
  score: 84,
  previousScore: 60,
  delta24h: 24,
  trend: 'TREND_DIRECTION_RISING',
  advisoryLevel: 'do-not-travel',
  triggeredAt: '2026-10-01T04:49:00.000Z',
  reason: 'risk_surge',
  details: { riseThreshold: 15, floor: 70, staticBaseline: 50, components: { newsActivity: 24, ciiContribution: 0, geoConvergence: 10, militaryActivity: 50 }, methodologyVersion: 'v8', computedAt: 1790830140000, scoresFetchedAt: '2026-10-01T04:49:00.000Z' },
});

const rawRequest = (body, overrides = {}) => signedRequest(body, { secret: SECRET, event: 'country.risk_surge', deliveryId: DELIVERY_ID, overrides });

// Recorded from risk:scores:sebuf:v8 on 2026-10-17 (trimmed to four countries).
const RISK_SCORES = {
  ciiScores: [
    { region: 'RU', staticBaseline: 35, dynamicScore: 0, combinedScore: 90, trend: 'TREND_DIRECTION_STABLE', components: { newsActivity: 10, ciiContribution: 0, geoConvergence: 0, militaryActivity: 71 }, computedAt: 1792240364085, methodologyVersion: 'v8', advisoryLevel: 'do-not-travel' },
    { region: 'IR', staticBaseline: 50, dynamicScore: 6, combinedScore: 72, trend: 'TREND_DIRECTION_RISING', components: {}, computedAt: 1792240364085, methodologyVersion: 'v8', advisoryLevel: 'do-not-travel' },
    { region: 'DE', staticBaseline: 10, dynamicScore: 12, combinedScore: 31, trend: 'TREND_DIRECTION_RISING', components: {}, computedAt: 1792240364085, methodologyVersion: 'v8', advisoryLevel: 'normal' },
    { region: 'BR', staticBaseline: 50, dynamicScore: 0, combinedScore: 50, trend: 'TREND_DIRECTION_STABLE', components: {}, computedAt: 1792240364085, methodologyVersion: 'v8' },
  ],
  strategicRisks: [],
  degraded: false,
  stale: false,
};

describe('trigger country_risk_surge (REST hook)', () => {
  afterEach(() => nock.cleanAll());

  it('subscribes with an upper-cased country scope and no chokepoint fields', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_r', secret: SECRET });
    const result = await appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: { countries: ['ir', 'UA', 'ir'] } });
    assert.deepEqual(posted, { callbackUrl: TARGET, eventType: 'country.risk_surge', chokepointIds: [], countries: ['IR', 'UA'] });
    assert.equal(result.eventType, 'country.risk_surge');
    assert.equal(result.secret, SECRET);
  });

  it('subscribes to every monitored country when the scope is empty', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_r', secret: SECRET });
    await appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: {} });
    assert.deepEqual(posted.countries, []);
  });

  it('surfaces the API validation message for an unmonitored country', async () => {
    nock(BASE_URL).post(PATHS.webhooks).reply(400, { violations: [{ field: 'countries', description: 'Unmonitored country code: ZZ' }] });
    await assert.rejects(
      () => appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: { countries: ['ZZ'] } }),
      /countries: Unmonitored country code: ZZ/,
    );
  });

  it('accepts a signed surge delivery and keys the row by X-WM-Delivery-Id', async () => {
    const rows = await appTester(trigger.perform, {
      authData: AUTH,
      subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET },
      cleanedRequest: JSON.parse(BODY),
      rawRequest: rawRequest(BODY),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, DELIVERY_ID);
    assert.equal(rows[0].countryCode, 'IR');
    assert.equal(rows[0].delta24h, 24);
    assert.equal(rows[0].score, 84);
    assert.ok(rows[0].delta24h >= rows[0].details.riseThreshold && rows[0].score >= rows[0].details.floor);
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(trigger.sample).sort());
  });

  it('rejects an unsigned or mis-signed delivery', async () => {
    const raw = rawRequest(BODY);
    raw.headers['Http-X-Wm-Signature-V2'] = `sha256=${'0'.repeat(64)}`;
    await assert.rejects(
      () => appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY), rawRequest: raw }),
      /did not verify/,
    );
  });

  it('performList returns the largest current movers in scope, newest rise first, with unique ids', async () => {
    nock(BASE_URL).get(PATHS.riskScores).reply(200, RISK_SCORES);
    const rows = await appTester(trigger.performList, { authData: AUTH, inputData: { countries: ['IR', 'DE', 'RU'] } });
    assert.deepEqual(rows.map((r) => r.countryCode), ['DE', 'IR', 'RU']);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    assert.equal(rows[0].id, 'sample:DE:1792240364085');
    assert.equal(rows[1].countryName, 'Iran');
    assert.equal(rows[1].previousScore, 66);
    assert.equal(rows[1].details.riseThreshold, 15);
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(trigger.sample).sort(), 'sample rows and deliveries share one field set');

    nock(BASE_URL).get(PATHS.riskScores).reply(200, RISK_SCORES);
    const all = await appTester(trigger.performList, { authData: AUTH, inputData: {} });
    assert.equal(all.length, 4);
  });
});
