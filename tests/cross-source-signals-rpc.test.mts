import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { createIntelligenceServiceRoutes } from '../src/generated/server/worldmonitor/intelligence/v1/service_server.ts';
import { intelligenceHandler } from '../server/worldmonitor/intelligence/v1/handler.ts';

const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const originalEnv = new Map<string, string | undefined>();

function routeHandler() {
  const descriptor = createIntelligenceServiceRoutes(intelligenceHandler, {})
    .find((route) => route.path === '/api/intelligence/v1/list-cross-source-signals');
  assert.ok(descriptor);
  return descriptor.handler;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('ListCrossSourceSignals public contract', () => {
  it('preserves a physical-premium regime transition through the generated public route', async () => {
    const payload = {
      signals: [{
        id: 'physical-premium:gold:normal-elevated:1788087600000',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_PHYSICAL_PREMIUM_REGIME_TRANSITION',
        theater: 'Global',
        summary: 'Gold physical premium moved from normal to elevated',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM',
        severityScore: 55,
        detectedAt: 1_788_087_600_000,
        contributingTypes: ['PHYSICAL_PREMIUM_REGIME_TRANSITION'],
        signalCount: 1,
      }],
      evaluatedAt: 1_788_087_600_000,
      compositeCount: 1,
    };
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      assert.match(String(input), /\/get\/intelligence%3Across-source-signals%3Av1$/);
      return new Response(JSON.stringify({ result: JSON.stringify(payload) }));
    });

    const response = await routeHandler()(new Request('https://worldmonitor.app/api/intelligence/v1/list-cross-source-signals'));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.signals.length, 1);
    assert.equal(body.signals[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_PHYSICAL_PREMIUM_REGIME_TRANSITION');
    assert.equal(body.signals[0].id, payload.signals[0].id);
  });

  it('preserves regulatory actions instead of downgrading them to unspecified', async () => {
    const payload = {
      signals: [{
        id: 'regulatory-action:test-authority:1788087600000',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION',
        theater: 'Global',
        summary: 'Test authority published a material action',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH',
        severityScore: 75,
        detectedAt: 1_788_087_600_000,
        contributingTypes: [],
        signalCount: 1,
      }],
      evaluatedAt: 1_788_087_600_000,
      compositeCount: 0,
    };
    mock.method(globalThis, 'fetch', async () => (
      new Response(JSON.stringify({ result: JSON.stringify(payload) }))
    ));

    const response = await routeHandler()(new Request('https://worldmonitor.app/api/intelligence/v1/list-cross-source-signals'));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.signals[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION');
  });
});
