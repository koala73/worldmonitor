import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { getCountryRisk } from '../server/worldmonitor/intelligence/v1/get-country-risk.ts';
import { CII_RISK_SCORE_CACHE_KEYS } from '../server/_shared/cache-keys.ts';
import { isAssignedCountryCode } from '../shared/country-code-resolve.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { validationFailure } from './helpers/validation-failure.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const ctx = { request: new Request('https://api.worldmonitor.app/api/intelligence/v1/get-country-risk'), pathParams: {}, headers: {} };
const read = (countryCode: string) => getCountryRisk(ctx, { countryCode });

let redisReads: string[];

beforeEach(() => {
  delete process.env.LOCAL_API_MODE;
  const redis = installRedis({
    [CII_RISK_SCORE_CACHE_KEYS.stale]: { ciiScores: [] },
    'intelligence:advisories:v1': { byCountry: { FR: 'normal' }, byCountryName: {} },
    'sanctions:country-counts:v1': { RU: 12 },
  });
  redisReads = [];
  globalThis.fetch = (async (input, init) => {
    redisReads.push(String(input));
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

test('unassigned two-letter codes are rejected on country_code before any cache read', async () => {
  for (const code of ['ZZ', 'zz', 'XX', 'AA', 'QQ', 'UK', 'EU', 'UN']) {
    await assert.rejects(read(code), validationFailure('country_code', /ISO 3166-1 alpha-2/), code);
  }
  assert.deepEqual(redisReads, []);
});

test('assigned codes, including small territories and Kosovo, still resolve', async () => {
  for (const [code, name] of [
    ['RU', 'Russia'],
    ['GB', 'United Kingdom'],
    ['XK', 'Kosovo'],
    ['RE', 'Réunion'],
    ['CX', 'Christmas Island'],
    ['TK', 'Tokelau'],
    ['BQ', 'Caribbean Netherlands'],
    ['BV', 'Bouvet Island'],
    ['YT', 'Mayotte'],
  ] as const) {
    const response = await read(code);
    assert.equal(response.countryCode, code);
    assert.equal(response.upstreamUnavailable, false, code);
    assert.notEqual(response.countryName, code, `${code} should resolve to a name, not echo the code`);
    assert.equal(response.countryName, name);
  }
  const russia = await read('ru');
  assert.equal(russia.sanctionsCount, 12);
  assert.equal(russia.sanctionsActive, true);
});

test('an empty country_code is rejected rather than answered with a blank record', async () => {
  await assert.rejects(read(''), validationFailure('country_code'));
  assert.deepEqual(redisReads, []);
});

test('membership covers all 249 assigned ISO 3166-1 codes plus XK and nothing else', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const members = [...letters].flatMap(a => [...letters].map(b => a + b)).filter(isAssignedCountryCode);
  assert.equal(members.length, 250);
  assert.ok(members.includes('XK'));
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (const code of members) {
    const name = names.of(code);
    assert.ok(name && name !== code && name !== 'Unknown Region', `${code} has no region name`);
  }
});
