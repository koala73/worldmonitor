import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getSectorDependency } from '../server/worldmonitor/supply-chain/v1/get-sector-dependency.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { groupByProduct, toCanonicalProduct } from '../scripts/shared/comtrade.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const env = { ...process.env };
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let sequence = 0;
afterEach(() => { process.env = { ...env }; globalThis.fetch = originalFetch; Date.now = originalNow; });
const codes = ['2709', '2710', '2711'];
const fixture = partners => ({
  iso2: 'US', requestedHs4s: codes, fetchedAt: '2026-09-14T00:00:00Z',
  products: groupByProduct(codes.flatMap(cmdCode => [['0', 100], ...partners].map(([partnerCode, primaryValue]) => ({
    cmdCode, partnerCode, primaryValue, year: 2025,
  })))).map(toCanonicalProduct),
});

async function call(payload, cached = {}) {
  const now = originalNow() + ++sequence * 180000;
  Date.now = () => now;
  process.env.WORLDMONITOR_VALID_KEYS = 'sector-fixture';
  process.env.VERCEL_ENV = 'production';
  const state = installRedis({
    ...cached,
    ...(payload == null ? {} : { 'comtrade:bilateral-hs4:US:v1': payload }),
  }, { keepVercelEnv: true });
  const request = new Request('https://app.fixture/api/supply-chain/v1/get-sector-dependency', { headers: { 'X-WorldMonitor-Key': 'sector-fixture' } });
  const result = await getSectorDependency({ request }, { iso2: 'US', hs2: '27' });
  return { result, state, headers: drainResponseHeaders(request) };
}

function assertNoData({ result, state, headers }) {
  assert.equal(result.iso2, 'US');
  assert.equal(result.hs2, '27');
  assert.equal(result.primaryExporterIso2, '');
  assert.equal(result.primaryExporterShare, 0);
  assert.deepEqual(result.flags, []);
  assert.equal(result.primaryChokepointId, '');
  assert.equal(result.primaryChokepointExposure, 0);
  assert.equal(result.fetchedAt, '');
  assert.equal(headers?.['X-No-Cache'], '1');
  for (const version of ['v1', 'v2']) assert.notEqual(state.expires.get(`supply-chain:sector-dep:US:27:${version}`), 86400);
}

test('selected HS27 headings cannot identify the chapter primary when coal is missing', async () => {
  const selected = fixture([['124', 90], ['484', 10]]);
  const selectedTotal = selected.products.reduce((sum, p) => sum + p.totalValue, 0);
  const omittedCoalImportsFromMexico = 2000;
  assert.equal(270 / selectedTotal, 0.9);
  assert.ok(270 / (selectedTotal + omittedCoalImportsFromMexico) < 0.2);
  assert.ok((30 + omittedCoalImportsFromMexico) / (selectedTotal + omittedCoalImportsFromMexico) > 0.8);
  assertNoData(await call(selected));
});

test('diversified selected headings cannot exclude chapter concentration in omitted coal', async () => {
  const selected = fixture([['124', 50], ['484', 30]]);
  const omittedCoalImportsFromCanada = 2000;
  assert.ok((150 + omittedCoalImportsFromCanada) / (300 + omittedCoalImportsFromCanada) > 0.8);
  assertNoData(await call(selected));
});

for (const [label, payload] of [['missing', null], ['World-only', fixture([['000', 100]])]]) {
  test(`${label} evidence returns no-data and no-store`, async () => {
    assertNoData(await call(payload));
  });
}

for (const version of ['v1', 'v2']) {
  test(`a cached ${version} result from unsupported evidence is not served`, async () => {
    assertNoData(await call(null, {
      [`supply-chain:sector-dep:US:27:${version}`]: {
        iso2: 'US', hs2: '27', flags: ['DEPENDENCY_FLAG_DIVERSIFIABLE'],
        primaryExporterIso2: 'CA', primaryExporterShare: 0.9,
        fetchedAt: '2026-09-14T00:00:00Z',
      },
    }));
  });
}
