'use strict';

const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const { BASE_URL, PATHS } = require('../constants');

const appTester = zapier.createAppTester(App);
const search = App.searches.find_news.operation;
const AUTH = { apiKey: 'wm_test' };

const DIGEST = {
  generatedAt: '2026-10-17T18:40:00.000Z',
  categories: {
    world: { items: [
      { title: 'Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz', link: 'https://www.rferl.org/a/1.html', source: 'RFE/RL', publishedAt: 1792261860000, importanceScore: 88, corroborationCount: 3, threat: { level: 'THREAT_LEVEL_CRITICAL', category: 'conflict' } },
      { title: 'Shipping insurers reprice Hormuz transits', link: 'https://example.com/ins', source: 'Lloyd\'s List', publishedAt: 1792262000000, importanceScore: 61, corroborationCount: 1, threat: { level: 'THREAT_LEVEL_MEDIUM', category: 'economic' } },
      { title: 'Untitled duplicate', link: 'https://www.rferl.org/a/1.html', source: 'Mirror', publishedAt: 1, importanceScore: 10 },
    ] },
    tech: { items: [{ title: 'Quiet day for chipmakers', link: 'https://example.com/chips', source: 'Reuters', publishedAt: 1792262100000, importanceScore: 40, threat: { level: 'THREAT_LEVEL_LOW', category: 'tech' } }] },
  },
};

describe('search find_news', () => {
  afterEach(() => nock.cleanAll());

  it('matches the keyword case-insensitively over headlines, most important first, de-duplicated by link', async () => {
    nock(BASE_URL).get(PATHS.feedDigest).query({ variant: 'full' }).reply(200, DIGEST);
    const rows = await appTester(search.perform, { authData: AUTH, inputData: { keyword: 'HORMUZ' } });
    assert.deepEqual(rows.map((r) => r.title), ['Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz', 'Shipping insurers reprice Hormuz transits']);
    assert.equal(rows[0].id, 'https://www.rferl.org/a/1.html');
    assert.equal(rows[0].category, 'conflict');
    assert.equal(rows[0].threatLevel, 'THREAT_LEVEL_CRITICAL');
    assert.equal(rows[0].publishedAt, '2026-10-17T18:31:00.000Z');
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(search.sample).sort());
  });

  it('narrows by category and searches the requested variant', async () => {
    nock(BASE_URL).get(PATHS.feedDigest).query({ variant: 'finance' }).reply(200, DIGEST);
    const rows = await appTester(search.perform, { authData: AUTH, inputData: { keyword: 'hormuz', category: 'economic', variant: 'finance' } });
    assert.deepEqual(rows.map((r) => r.title), ['Shipping insurers reprice Hormuz transits']);
    assert.equal(rows[0].variant, 'finance');
  });

  it('returns an empty list when nothing matches', async () => {
    nock(BASE_URL).get(PATHS.feedDigest).query({ variant: 'full' }).reply(200, DIGEST);
    assert.deepEqual(await appTester(search.perform, { authData: AUTH, inputData: { keyword: 'volcano' } }), []);
  });
});
