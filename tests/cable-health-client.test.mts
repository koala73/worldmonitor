import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { GetCableHealthResponse } from '../src/generated/client/worldmonitor/infrastructure/v1/service_client';

// Real service and circuit breaker; only the generated RPC transport is controlled.
test('cable health retries unavailable data, preserves source clocks, clears faults on confirmed empty, and expires retained data', async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const rpc: { response: GetCableHealthResponse; calls: number } = { response: { generatedAt: 0, cables: {} }, calls: 0 };
  const testGlobal = globalThis as typeof globalThis & { __cableRpc?: typeof rpc };
  testGlobal.__cableRpc = rpc;
  try {
    const result = await build({
      entryPoints: ['src/services/cable-health.ts'], bundle: true, write: false,
      format: 'esm', platform: 'node', logLevel: 'silent',
      plugins: [{ name: 'transport', setup(b) {
        b.onResolve({ filter: /^@\/utils$/ }, args => args.importer.endsWith('/services/cable-health.ts') ? ({ path: resolve('src/utils/circuit-breaker.ts') }) : undefined);
        b.onResolve({ filter: /services\/persistent-cache$/ }, () => ({ path: 'persistent-cache', namespace: 'stub' }));
        b.onResolve({ filter: /^@\/services\/(rpc-client|generated-rpc-clients)$/ }, args => ({ path: args.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'persistent-cache'
          ? 'export const getPersistentCache = async () => null; export const setPersistentCache = async () => {}; export const deletePersistentCache = async () => {}; export const deletePersistentCacheByPrefix = async () => {};'
          : args.path.endsWith('rpc-client')
          ? 'export const getRpcBaseUrl = () => "https://test.invalid";'
          : 'export class InfrastructureServiceClient { async getCableHealth() { globalThis.__cableRpc.calls++; return globalThis.__cableRpc.response; } }' }));
      } }],
    });
    const service = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`);
    await assert.rejects(service.fetchCableHealth(), /unavailable/);
    assert.deepEqual(service.getCableHealthMap(), {});
    const observed = now - 60_000;
    rpc.response = { generatedAt: observed, cables: { test: {
      status: 'CABLE_HEALTH_STATUS_FAULT', score: 1, confidence: 1, lastUpdated: 0,
      evidence: [{ source: 'test', summary: 'fault', ts: 0 }],
    } } };
    const good = await service.fetchCableHealth();
    assert.equal(rpc.calls, 2, 'failed fallback must not fill the outer one-minute cache');
    assert.equal(good.generatedAt, new Date(observed).toISOString());
    assert.equal(good.cables.test.lastUpdated, '');
    assert.equal(good.cables.test.evidence[0].ts, '');
    for (const malformed of [null, {}, { evidence: null }, { evidence: [], lastUpdated: 1e20 }]) {
      now += 11 * 60_000;
      rpc.response = { generatedAt: now, cables: { test: malformed } } as unknown as GetCableHealthResponse;
      assert.deepEqual(await service.fetchCableHealth(), good, 'malformed records must preserve last-good data');
    }
    now += 11 * 60_000;
    rpc.response = { generatedAt: 0, cables: {} };
    assert.deepEqual(await service.fetchCableHealth(), good, 'failed refresh retains original source time');
    now += 6 * 60_000;
    rpc.response = { generatedAt: now, cables: {} };
    const empty = await service.fetchCableHealth();
    assert.deepEqual(empty.cables, {}, 'confirmed empty clears outdated fault records');
    assert.equal(empty.generatedAt, new Date(now).toISOString());
    assert.equal(service.getCableHealthRecord('test'), undefined);
    const calls = rpc.calls;
    await service.fetchCableHealth();
    assert.equal(rpc.calls, calls, 'confirmed empty is cacheable');
    now += 91 * 60_000;
    rpc.response = { generatedAt: 0, cables: {} };
    await assert.rejects(service.fetchCableHealth(), /unavailable/);
    assert.deepEqual(service.getCableHealthMap(), {});
  } finally {
    Date.now = originalNow;
    delete testGlobal.__cableRpc;
  }
});
