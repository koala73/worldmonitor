import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { TOOL_REGISTRY } from '../api/mcp/registry/index';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config';

const tool = TOOL_REGISTRY.find(t => t.name === 'get_country_risk')!;
const originalFetch = globalThis.fetch, originalEnv = { ...process.env }, originalNow = Date.now;
const now = Date.UTC(2026, 9, 18, 12);
const risk = { countryCode: 'IR', cii: { methodologyVersion: CII_FORMULA_VERSION }, upstreamUnavailable: false };
let commands: string[][];
let reads: number;
let rows: unknown;
const point = (date: string, score: number, version = CII_FORMULA_VERSION) => JSON.stringify({ d: date, s: score, v: version, u: 1, c: 2, m: 3, n: 4, t: Date.parse(`${date}T12:00:00Z`) });

beforeEach(() => {
  commands = []; reads = 0;
  Date.now = () => now;
  rows = [point('2026-09-20', 10, 'v7'), point('2026-09-25', 20), point('2026-10-18', 40)];
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://upstash.test', UPSTASH_REDIS_REST_TOKEN: 'fixture', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'cii-history-test' });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://upstash.test') {
      reads++;
      commands = JSON.parse(String(init?.body));
      return Response.json(commands.map(() => ({ result: rows })));
    }
    assert.equal(url.pathname, '/api/intelligence/v1/get-country-risk');
    assert.equal(url.search, '?country_code=IR', 'history must not alter the public REST request');
    return Response.json(risk);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = originalEnv; Date.now = originalNow; });

test('country risk default stays byte-for-byte unchanged and makes no history read', async () => {
  assert.deepEqual(await tool._execute!({ country_code: 'IR' }, 'https://api.test', { kind: 'env_key', apiKey: 'fixture' }, {}), risk);
  assert.equal(reads, 0);
});

test('country history augments one gateway response with one bounded preview-owned Redis read', async () => {
  const result = await tool._execute!({ country_code: 'IR', history_days: 30 }, 'https://api.test', { kind: 'env_key', apiKey: 'fixture' }, {}) as any;
  assert.equal(reads, 1);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], ['ZRANGE', 'preview:cii-hist:risk:scores:history:IR', String(Math.floor(now / 86400000) - 29), String(Math.floor(now / 86400000)), 'BYSCORE']);
  assert.equal(result.ciiHistory.returnedDays, 2);
  assert.deepEqual(result.ciiHistory.versionBreaks, [{ date: '2026-09-25', from: 'v7', to: CII_FORMULA_VERSION }]);
  assert.equal(result.ciiHistory.change.delta, 20);
  assert.equal(result.ciiHistory.stale, false);
  assert.deepEqual(result.cii, risk.cii);
});

test('invalid history depth rejects before gateway or Redis IO', async () => {
  for (const history_days of [0, 91, 1.5, '30', null]) {
    await assert.rejects(() => tool._execute!({ country_code: 'IR', history_days }, 'https://api.test', { kind: 'env_key', apiKey: 'fixture' }, {}), /history_days/);
  }
  assert.equal(reads, 0);
});

test('missing, failed or corrupt history cannot report fresh empty history', async () => {
  for (const value of [[], null, ['bad-json']]) {
    rows = value;
    const result = await tool._execute!({ country_code: 'IR', history_days: 7 }, 'https://api.test', { kind: 'env_key', apiKey: 'fixture' }, {}) as any;
    assert.equal(result.ciiHistory.stale, true);
    assert.deepEqual(result.ciiHistory.points, []);
    assert.equal(result.ciiHistory.change, null);
  }
});
