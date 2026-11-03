'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { signedRequest } = require('./helpers/signed-request');
const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');

const appTester = zapier.createAppTester(App);
const trigger = App.triggers.news_breaking.operation;
const EVENT = EVENT_REGISTRY.events['news.breaking'];

const AUTH = { apiKey: 'wm_test' };
const TARGET = 'https://hooks.zapier.com/hooks/standard/1/news/';
const SECRET = '3a'.repeat(32);
const DELIVERY_ID = 'whd_5e2c8a1f7b9d4c3e6a0f1b2d3c4e5f60';

// The body scripts/shipping-webhook-worker.mjs builds for a teed rss_alert
// (tests/shipping-webhook-worker-occurrences.test.mjs pins the field set to
// the registry sample); signed here with a fixture secret.
const BODY = JSON.stringify({ ...EVENT.sample, subscriberId: 'wh_041fef6d0657b56b75fb62cb' });

const rawRequest = (body, overrides = {}) => signedRequest(body, { secret: SECRET, event: 'news.breaking', deliveryId: DELIVERY_ID, overrides });

// Trimmed list-feed-digest response (two categories, four items).
const DIGEST = {
  generatedAt: '2026-10-17T18:40:00.000Z',
  categories: {
    world: {
      items: [
        { title: 'Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz', link: 'https://www.rferl.org/a/1.html', source: 'RFE/RL', publishedAt: 1792261860000, importanceScore: 88, corroborationCount: 3, threat: { level: 'THREAT_LEVEL_CRITICAL', category: 'conflict' } },
        { title: 'Protesters clash with police in Belgium', link: 'https://example.com/be', source: 'Reuters', publishedAt: 1792261000000, importanceScore: 72, corroborationCount: 1, threat: { level: 'THREAT_LEVEL_HIGH', category: 'protest' } },
      ],
    },
    tech: {
      items: [
        { title: 'Hackers breach Microsoft 365 tenants via supply-chain flaw', link: 'https://example.com/ms', source: 'BleepingComputer', publishedAt: 1792262000000, importanceScore: 70, corroborationCount: 2, threat: { level: 'THREAT_LEVEL_HIGH', category: 'cyber' } },
        { title: 'Quiet day for chipmakers', link: 'https://example.com/chips', source: 'Reuters', publishedAt: 1792262100000, importanceScore: 40, corroborationCount: 1, threat: { level: 'THREAT_LEVEL_LOW', category: 'tech' } },
      ],
    },
  },
};

describe('trigger news_breaking (REST hook)', () => {
  afterEach(() => nock.cleanAll());

  it('subscribes with a scope built from the inputs: lower-cased keywords, upper-cased countries, floors', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_n', secret: SECRET });
    const result = await appTester(trigger.performSubscribe, {
      authData: AUTH,
      targetUrl: TARGET,
      inputData: { keywords: ['Hormuz', ' tanker '], categories: ['conflict'], countries: ['ir', 'ua'], importance_floor: '75', severity_floor: 'critical' },
    });
    assert.deepEqual(posted, {
      callbackUrl: TARGET,
      eventType: 'news.breaking',
      chokepointIds: [],
      countries: [],
      scope: { keywords: ['hormuz', 'tanker'], categories: ['conflict'], countries: ['IR', 'UA'], importanceFloor: 75, severityFloor: 'critical' },
    });
    assert.equal(result.eventType, 'news.breaking');
    assert.equal(result.secret, SECRET);
  });

  it('sends the registry defaults and no empty lists when the inputs are blank, and accepts a comma-separated list', async () => {
    let posted;
    nock(BASE_URL).post(PATHS.webhooks, (body) => { posted = body; return true; }).reply(200, { subscriberId: 'wh_n', secret: SECRET });
    await appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: { keywords: 'oil, Gas', importance_floor: '' } });
    assert.deepEqual(posted.scope, { keywords: ['oil', 'gas'], importanceFloor: 69, severityFloor: 'high' });
  });

  it('surfaces the API validation message for a scope the server rejects', async () => {
    nock(BASE_URL).post(PATHS.webhooks).reply(400, { violations: [{ field: 'scope.countries', description: 'Unknown country code: ZZ. Expected ISO 3166-1 alpha-2' }] });
    await assert.rejects(
      () => appTester(trigger.performSubscribe, { authData: AUTH, targetUrl: TARGET, inputData: { countries: ['ZZ'] } }),
      /scope\.countries: Unknown country code: ZZ/,
    );
  });

  it('accepts a signed delivery, keys the row by X-WM-Delivery-Id and keeps eventId for cross-Zap dedupe', async () => {
    const rows = await appTester(trigger.perform, {
      authData: AUTH,
      subscribeData: { subscriberId: 'wh_041fef6d0657b56b75fb62cb', secret: SECRET },
      cleanedRequest: JSON.parse(BODY),
      rawRequest: rawRequest(BODY),
    });
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.id, DELIVERY_ID);
    assert.equal(row.eventId, EVENT.sample.eventId);
    assert.equal(row.title, EVENT.sample.title);
    assert.deepEqual(row.matchedKeywords, ['hormuz']);
    assert.deepEqual(row.countryCodes, ['IR']);
    assert.deepEqual(Object.keys(row).sort(), Object.keys(trigger.sample).sort(), 'deliveries and the sample share one field set');
  });

  it('rejects a mis-signed delivery and ignores one for another event', async () => {
    await assert.rejects(
      () => appTester(trigger.perform, {
        authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY),
        rawRequest: rawRequest(BODY, { 'Http-X-Wm-Signature-V2': signedRequest(BODY, { secret: 'b'.repeat(64), event: 'news.breaking', deliveryId: DELIVERY_ID }).headers['Http-X-Wm-Signature-V2'] }),
      }),
      /did not verify/,
    );
    const rows = await appTester(trigger.perform, {
      authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY),
      rawRequest: rawRequest(BODY, { 'Http-X-Wm-Event': 'market.move' }),
    });
    assert.deepEqual(rows, []);
  });

  it('a retried delivery carries the same id, so one story is one row id', async () => {
    const first = await appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY) });
    const second = await appTester(trigger.perform, { authData: AUTH, subscribeData: { secret: SECRET }, cleanedRequest: JSON.parse(BODY), rawRequest: rawRequest(BODY) });
    assert.equal(first[0].id, second[0].id);
  });

  it('performList shapes digest headlines like deliveries, applies the scope, and keeps ids unique', async () => {
    nock(BASE_URL).get(PATHS.feedDigest).query({ variant: 'full' }).reply(200, DIGEST);
    const rows = await appTester(trigger.performList, { authData: AUTH, inputData: { keywords: ['hormuz', 'microsoft'], importance_floor: '69' } });
    assert.deepEqual(rows.map((r) => r.title), ['Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz', 'Hackers breach Microsoft 365 tenants via supply-chain flaw']);
    assert.deepEqual(rows[0].matchedKeywords, ['hormuz']);
    assert.equal(rows[0].severity, 'critical');
    assert.equal(rows[0].category, 'conflict');
    assert.equal(rows[0].publishedAt, '2026-10-17T18:31:00.000Z');
    assert.equal(rows[0].triggeredAt, DIGEST.generatedAt);
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(trigger.sample).sort(), 'sample rows and deliveries share one field set');
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);

    nock(BASE_URL).get(PATHS.feedDigest).query({ variant: 'full' }).reply(200, DIGEST);
    const critical = await appTester(trigger.performList, { authData: AUTH, inputData: { severity_floor: 'critical' } });
    assert.deepEqual(critical.map((r) => r.severity), ['critical']);

    nock(BASE_URL).get(PATHS.feedDigest).query({ variant: 'full' }).reply(200, DIGEST);
    const fallback = await appTester(trigger.performList, { authData: AUTH, inputData: { keywords: ['nothing-matches-this'] } });
    assert.equal(fallback.length, 3, 'when the scope leaves nothing, the top headlines above the floor are shown so the editor has rows');
  });
});
