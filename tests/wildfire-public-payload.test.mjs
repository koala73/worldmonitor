import assert from 'node:assert/strict';
import test from 'node:test';
import bootstrap from '../api/bootstrap.js';
import { compactWildfireDashboardPayload as edgeCompact } from '../api/_wildfire-dashboard.js';
import { compactWildfireDashboardPayload as seedCompact, WILDFIRE_CANONICAL_DETECTION_LIMIT } from '../scripts/_wildfire-dashboard.mjs';
import { mergeWildfireSourcesWithBc, wildfirePublishData } from '../scripts/wildfire/bc-fire-points.mjs';
import { assembleBootstrapTierPayload } from '../scripts/publish-bootstrap-tiers.mjs';
import { buildEnvelope } from '../scripts/_seed-envelope-source.mjs';

const NOW = 1_789_000_000_000;
const KEY = 'wildfire:fires-bootstrap:v1';
const PUBLIC_FIELDS = ['dataAvailable', 'fetchedAt', 'fireDetections', 'pagination'];

async function mergedFixture(count) {
  const merged = await mergeWildfireSourcesWithBc({
    fetchFirms: async () => ({
      fireDetections: Array.from({ length: count }, (_, i) => ({ id: `firms:${i}`, detectedAt: NOW, region: 'Ukraine' })),
      _firmsFulfilledCalls: 26, _firmsFailedCalls: 1,
    }),
    fetchCwfis: async () => ({ fireDetections: [], _cwfisState: 'degraded', _cwfisErrorCode: 'CWFIS_PRESCRIBED_FAILED' }),
    fetchBcWildfire: async () => ({ fireDetections: [], _bcVia: 'kml' }),
  });
  return { ...merged, fetchedAt: NOW, dataAvailable: true, futureInternalField: 'fixture-only' };
}

function assertPublic(payload) {
  assert.deepEqual(Object.keys(payload).sort(), PUBLIC_FIELDS);
  assert.equal(payload.fetchedAt, NOW);
  assert.equal(payload.dataAvailable, true);
}

for (const count of [0, 1, 501]) {
  test(`public compaction removes producer diagnostics for ${count} detections and preserves canonical metadata`, async () => {
    const merged = await mergedFixture(count);
    const publishData = wildfirePublishData(merged);
    assert.equal(publishData._firmsPartial, true);
    assert.equal(publishData._firmsFailedCalls, 1);
    assert.equal(publishData._cwfisErrorCode, 'CWFIS_PRESCRIBED_FAILED');
    assert.equal(publishData._bcVia, 'kml');
    const before = structuredClone(publishData);
    for (const compact of [seedCompact, edgeCompact]) {
      const publicData = compact(publishData);
      assertPublic(publicData);
      assert.equal(publicData.fireDetections.length, Math.min(count, 500));
      assert.equal(publicData.pagination.totalCount, count);
      assert.deepEqual(compact(publishData, WILDFIRE_CANONICAL_DETECTION_LIMIT), before);
      assert.deepEqual(compact(publishData, 1)._firmsPartial, true);
    }
    assert.deepEqual(publishData, before);
  });
}

test('public Redis fallback and CDN assembly strip diagnostics from legacy seed envelopes', async (t) => {
  const merged = await mergedFixture(1);
  const envelope = buildEnvelope({ fetchedAt: NOW, recordCount: 1, sourceVersion: 'fixture', schemaVersion: 1, state: 'OK', data: wildfirePublishData(merged) });
  for (const [name, value] of Object.entries({
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
    BOOTSTRAP_R2_SHADOW_MEASURE: '0',
  })) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
  const fetchFn = async (input, init) => {
    assert.equal(new URL(String(input)).origin, 'https://redis.test');
    const commands = JSON.parse(String(init.body));
    assert.ok(commands.every(([command]) => command === 'GET'));
    return Response.json(commands.map(([, key]) => ({ result: key === KEY ? JSON.stringify(envelope) : null })));
  };
  t.mock.method(globalThis, 'fetch', fetchFn);
  const response = await bootstrap(new Request('https://api.worldmonitor.app/api/bootstrap?tier=slow&public=1'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const fallback = (await response.json()).data.wildfires;
  assertPublic(fallback);
  const cdn = await assembleBootstrapTierPayload({ wildfires: KEY }, { fetchFn });
  assertPublic(cdn.data.wildfires);
  assert.deepEqual(cdn.data.wildfires, fallback);
  assert.equal(fallback.pagination.totalCount, 1);
});

test('dashboard byte measurement excludes internal fields while canonical retains them', async () => {
  const payload = await mergedFixture(1);
  payload.futureInternalField = 'x'.repeat(10_000);
  const measureBytes = (value) => Buffer.byteLength(JSON.stringify(value));
  for (const compact of [seedCompact, edgeCompact]) {
    const result = compact(payload, 500, { maxBytes: 1_000, measureBytes });
    assertPublic(result);
    assert.equal(result.fireDetections.length, 1);
    assert.ok(measureBytes(result) <= 1_000);
    const canonical = compact(payload, WILDFIRE_CANONICAL_DETECTION_LIMIT, { maxBytes: 20_000, measureBytes });
    assert.equal(canonical.futureInternalField, payload.futureInternalField);
  }
});
