import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from '@e965/xlsx';
import { CII_COUNTRY_CODES } from '../shared/cii-weights.ts';
import { __testing__ as health } from '../api/health.js';
import {
  buildStructuralPrior, seedStructuralPrior, PRIOR_YEAR, PRIOR_INDICATOR,
  PRIOR_KEY, PRIOR_META_KEY, PRIOR_ACTIVATION_KEY, PRIOR_BULK_URL, PRIOR_SCORED_COUNTRIES,
} from '../scripts/seed-cii-structural-prior.mjs';

const NOW = Date.UTC(2026, 10, 12);
function bulk({ code = 'TWN', year = PRIOR_YEAR } = {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Economy (code)', 'Year', 'Governance dimension', 'Governance estimate (approx. -2.5 to +2.5)'],
    [code, year, 'pv', 0.9986707],
  ]), 'pv');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
function apiRows() {
  return [...PRIOR_SCORED_COUNTRIES.filter((code) => code !== 'TW'), 'PH', 'TH', 'ID', 'VN', 'MY', 'KH']
    .map((code) => ({ country: { id: code }, indicator: { id: PRIOR_INDICATOR }, date: String(PRIOR_YEAR), value: 0.2 }));
}
const api = (rows = apiRows()) => [{ pages: 1, total: rows.length }, rows];

test('prior seeder and health country sets match the scorer', () => {
  assert.deepEqual([...PRIOR_SCORED_COUNTRIES].sort(), [...CII_COUNTRY_CODES].sort());
  assert.deepEqual([...health.SEED_META.ciiStructuralPrior.requiredCountries].sort(), [...CII_COUNTRY_CODES].sort());
  assert.equal(health.SEED_META.ciiStructuralPrior.year, PRIOR_YEAR);
  assert.equal(health.STANDALONE_KEYS.ciiStructuralPrior, PRIOR_KEY);
  assert.equal(health.SEED_META.ciiStructuralPrior.key, PRIOR_META_KEY);
  assert.notEqual(PRIOR_KEY, PRIOR_META_KEY);
  assert.equal(health.ACTIVATION_MARKERS.ciiStructuralPrior, PRIOR_ACTIVATION_KEY);
  assert.ok(health.ON_DEMAND_KEYS.has('ciiStructuralPrior'));
});

test('pinned API values and Taiwan bulk value produce the complete country map', () => {
  const payload = buildStructuralPrior(api(), bulk(), NOW);
  assert.equal(Object.keys(payload.countries).length, 37);
  assert.equal(payload.year, PRIOR_YEAR);
  assert.deepEqual(payload.countries.TW, { pv: 0.9986707, year: PRIOR_YEAR, source: PRIOR_BULK_URL });
  assert.equal(payload.countries.PH.pv, 0.2);
});

test('newer years cannot replace the pinned values', () => {
  const rows = apiRows();
  rows.push(...rows.map((row) => ({ ...row, date: String(PRIOR_YEAR + 1), value: -2 })));
  assert.deepEqual(buildStructuralPrior(api(rows), bulk(), NOW), buildStructuralPrior(api(), bulk(), NOW));
});

test('missing or older-only scored values and missing Taiwan refuse the snapshot', () => {
  const rows = apiRows().filter((row) => row.country.id !== 'JP');
  assert.throws(() => buildStructuralPrior(api(rows), bulk()), /Missing.*JP/);
  rows.push({ country: { id: 'JP' }, indicator: { id: PRIOR_INDICATOR }, date: String(PRIOR_YEAR - 1), value: 0.3 });
  assert.throws(() => buildStructuralPrior(api(rows), bulk()), /Missing.*JP/);
  assert.throws(() => buildStructuralPrior(api(), bulk({ code: 'USA' })), /TWN/);
  assert.throws(() => buildStructuralPrior(api(), bulk({ year: PRIOR_YEAR - 1 })), /TWN/);
});

test('incomplete pagination and conflicting values refuse the snapshot', () => {
  assert.throws(() => buildStructuralPrior([{ pages: 2, total: 100 }, apiRows()], bulk()), /Incomplete/);
  const rows = apiRows();
  rows.push({ ...rows[0], value: -1 });
  assert.throws(() => buildStructuralPrior(api(rows), bulk()), /Conflicting/);
});

test('publication follows complete validation, with a distinct meta key and exact record count', async () => {
  const writes = [];
  const activate = async () => {
    assert.equal(writes.length, 1, 'activation follows both payload and metadata publication');
  };
  const fetchImpl = async (url, options) => {
    assert.ok(options.headers['User-Agent']);
    return new Response(url === PRIOR_BULK_URL ? bulk() : JSON.stringify(api()));
  };
  const payload = await seedStructuralPrior({ fetchImpl, nowMs: NOW, publish: async (args) => { writes.push(args); return true; }, activate });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, PRIOR_KEY);
  assert.equal(writes[0].recordCount, Object.keys(payload.countries).length);
  assert.equal(writes[0].metaKey, PRIOR_META_KEY);
  await seedStructuralPrior({ fetchImpl, dryRun: true, publish: async () => assert.fail('dry run wrote'), activate: async () => assert.fail('dry run activated') });
  const missing = async (url) => new Response(url === PRIOR_BULK_URL ? bulk() : JSON.stringify(api(apiRows().filter((row) => row.country.id !== 'US'))));
  await assert.rejects(seedStructuralPrior({ fetchImpl: missing, publish: async () => assert.fail('invalid snapshot wrote') }), /Missing.*US/);
  await assert.rejects(seedStructuralPrior({ fetchImpl, publish: async () => { throw new Error('publish failed'); }, activate: async () => assert.fail('failed publish activated') }), /publish failed/);
  await assert.rejects(seedStructuralPrior({ fetchImpl, publish: async () => false,
    activate: async () => assert.fail('failed metadata publication activated') }), /publish failed/);
});

test('fresh metadata cannot hide a payload coverage shortfall or a mixed year', () => {
  const payload = buildStructuralPrior(api(), bulk(), NOW);
  const entry = { status: 'OK', seedAge: 0 };
  assert.equal(health.composeCiiStructuralPriorHealth(entry, JSON.stringify(payload)).status, 'OK');
  delete payload.countries.US;
  assert.deepEqual(health.composeCiiStructuralPriorHealth(entry, JSON.stringify(payload)).missingCountries, ['US']);
  assert.equal(health.composeCiiStructuralPriorHealth(entry, JSON.stringify(payload)).status, 'COVERAGE_PARTIAL');
  payload.countries.US = { pv: 0.2, year: PRIOR_YEAR - 1, source: 'https://example.test' };
  assert.equal(health.composeCiiStructuralPriorHealth(entry, JSON.stringify(payload)).status, 'COVERAGE_PARTIAL');
  assert.equal(health.composeCiiStructuralPriorHealth(entry, null, true).status, 'REDIS_PARTIAL');
  assert.equal(health.composeCiiStructuralPriorHealth({ status: 'STALE_SEED' }, null).status, 'STALE_SEED');
});

test('the default publisher uses one transaction and refuses activation on a metadata error', async (t) => {
  const originalEnv = process.env;
  process.env = { ...originalEnv, UPSTASH_REDIS_REST_URL: 'https://prior-redis.test', UPSTASH_REDIS_REST_TOKEN: 'test-token' };
  t.after(() => { process.env = originalEnv; });
  const fetchImpl = async (url) => new Response(url === PRIOR_BULK_URL ? bulk() : JSON.stringify(api()));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://prior-redis.test/multi-exec');
    const commands = JSON.parse(options.body);
    assert.deepEqual(commands.map((c) => c.slice(0, 2)), [['SET', PRIOR_KEY], ['SET', PRIOR_META_KEY]]);
    assert.equal(JSON.parse(commands[1][2]).recordCount, 37);
    return Response.json([{ result: 'OK' }, { error: 'metadata rejected' }]);
  });
  await assert.rejects(seedStructuralPrior({ fetchImpl, nowMs: NOW,
    activate: async () => assert.fail('failed transaction activated') }), /Atomic extra-key publish failed/);
});

