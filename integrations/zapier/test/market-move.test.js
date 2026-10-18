'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { signedRequest } = require('./helpers/signed-request');
const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');

const appTester = zapier.createAppTester(App);
const trigger = App.triggers.market_move.operation;
const EVENT = EVENT_REGISTRY.events['market.move'];

const AUTH = { apiKey: 'wm_test' };
const TARGET = 'https://hooks.zapier.com/hooks/standard/1/mkt/';
const SECRET = '5d'.repeat(32);
const DELIVERY_ID = 'whd_9b4d2e7f1a3c5e8d0f2b4a6c8e1d3f50';

const BODY = JSON.stringify({ ...EVENT.sample, subscriberId: 'wh_041fef6d0657b56b75fb62cb' });
const rawRequest = (body, overrides = {}) => signedRequest(body, { secret: SECRET, event: 'market.move', deliveryId: DELIVERY_ID, overrides });

describe('trigger market_move (REST hook)', () => {
  afterEach(() => nock.cleanAll());

  it('subscribes with a scope built from the inputs (upper-cased symbols, numeric floor)', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_m', secret: SECRET });
    await appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: { asset_classes: ['equity', 'commodity'], symbols: ['vix', ' gc=f'], min_abs_pct: '12.5', direction: 'down' } });
    assert.deepEqual(posted, {
      callbackUrl: TARGET,
      eventType: 'market.move',
      chokepointIds: [],
      countries: [],
      scope: { assetClasses: ['equity', 'commodity'], symbols: ['VIX', 'GC=F'], minAbsPct: 12.5, direction: 'down' },
    });
  });

  it('sends the registry defaults (10 percent, any direction) when the inputs are blank', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_m', secret: SECRET });
    await appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: {} });
    assert.deepEqual(posted.scope, { minAbsPct: 10, direction: 'any' });
  });

  it('accepts a signed delivery keyed by X-WM-Delivery-Id with the sample field set', async () => {
    const rows = await appTester(trigger.perform, {
      authData: AUTH, subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET },
      cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, DELIVERY_ID);
    assert.equal(rows[0].symbol, 'VIX');
    assert.equal(rows[0].changePct, 21.3);
    assert.equal(rows[0].direction, 'up');
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(trigger.sample).sort());
  });

  it('rejects an unsigned delivery and ignores a news delivery on this hook', async () => {
    await assert.rejects(
      () => appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY, { 'Http-X-Wm-Signature-V2': undefined }) }),
      /did not verify/,
    );
    const rows = await appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY, { 'Http-X-Wm-Event': 'news.breaking' }) });
    assert.deepEqual(rows, []);
  });

  it('performList ranks the largest current moves across the classes in scope, shaped like deliveries, with unique ids', async () => {
    nock(BASE_URL).get(PATHS.marketQuotes).reply(200, { quotes: [
      { symbol: 'VIX', name: 'CBOE Volatility Index', price: 28.41, change: 21.3 },
      { symbol: 'SPY', name: 'S&P 500 ETF', price: 512.1, change: -1.2 },
    ], asOf: '2026-10-17T17:45:00.000Z' });
    nock(BASE_URL).get(PATHS.cryptoQuotes).reply(200, { quotes: [
      { symbol: 'BTC', name: 'Bitcoin', price: 61000, change: -22.4 },
      { symbol: 'ETH', name: 'Ethereum', price: 2400, change: 3.1 },
    ] });
    const rows = await appTester(trigger.performList, { authData: AUTH, inputData: { asset_classes: ['equity', 'crypto'] } });
    assert.deepEqual(rows.map((r) => r.symbol), ['BTC', 'VIX', 'ETH', 'SPY']);
    assert.equal(rows[0].severity, 'critical', 'crypto is critical from 20 percent');
    assert.equal(rows[0].direction, 'down');
    assert.equal(rows[0].source, 'Crypto Market');
    assert.equal(rows[1].publishedAt, '2026-10-17T17:45:00.000Z');
    assert.equal(rows[2].severity, 'high');
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(trigger.sample).sort(), 'sample rows and deliveries share one field set');
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);

    nock(BASE_URL).get(PATHS.marketQuotes).reply(200, { quotes: [{ symbol: 'VIX', change: 21.3 }, { symbol: 'SPY', change: -1.2 }] });
    const scoped = await appTester(trigger.performList, { authData: AUTH, inputData: { asset_classes: ['equity'], symbols: ['spy'], direction: 'down' } });
    assert.deepEqual(scoped.map((r) => r.symbol), ['SPY']);
    assert.equal(scoped[0].name, 'SPY', 'name falls back to the symbol');
  });
});
