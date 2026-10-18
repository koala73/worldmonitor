import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { createIntelligenceServiceRoutes } from '../src/generated/server/worldmonitor/intelligence/v1/service_server.ts';
import { serverOptions } from '../server/gateway.ts';
import { intelligenceHandler } from '../server/worldmonitor/intelligence/v1/handler.ts';

const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const originalEnv = new Map<string, string | undefined>();

function routeHandler() {
  const descriptor = createIntelligenceServiceRoutes(intelligenceHandler, serverOptions)
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

describe('ListCrossSourceSignals malformed cache records', () => {
  it('skips null, primitive, and array rows while preserving valid records and their fallback IDs', async () => {
    const payload = {
      signals: [null, false, 42, 'broken', [], {
        type: 'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
        theater: 'Global Markets',
        summary: 'Volatility increased',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH',
        severityScore: 70,
        detectedAt: 123,
        signalCount: 2,
        contributingTypes: ['VIX_SPIKE'],
      }],
      evaluatedAt: 456,
      compositeCount: 1,
    };
    mock.method(globalThis, 'fetch', async () => Response.json({ result: JSON.stringify(payload) }));
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/intelligence/v1/list-cross-source-signals'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      signals: [{ id: 'signal:5', ...payload.signals[5] }],
      evaluatedAt: 456,
      compositeCount: 1,
    });
  });

  it('uses zero for missing detection time rather than marking a cached row as newly detected', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json({ result: JSON.stringify({ signals: [{}] }) }));
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/intelligence/v1/list-cross-source-signals'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      signals: [{
        id: 'signal:0', type: 'CROSS_SOURCE_SIGNAL_TYPE_UNSPECIFIED', theater: 'Global', summary: '',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_UNSPECIFIED', severityScore: 0, detectedAt: 0,
        contributingTypes: [], signalCount: 0,
      }],
      evaluatedAt: 0,
      compositeCount: 0,
    });
  });

  it('normalizes non-finite Redis JSON numbers before public serialization', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json({
      result: '{"signals":[{"severityScore":1e400,"detectedAt":1e400,"signalCount":1e400}],"evaluatedAt":1e400,"compositeCount":-1e400}',
    }));
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/intelligence/v1/list-cross-source-signals'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.signals[0].severityScore, 0);
    assert.equal(body.signals[0].detectedAt, 0);
    assert.equal(body.signals[0].signalCount, 0);
    assert.equal(body.evaluatedAt, 0);
    assert.equal(body.compositeCount, 0);
  });

  for (const payload of [null, { signals: [] }, { signals: [null, 1, false, []] }]) {
    it(`returns the empty contract for ${JSON.stringify(payload)}`, async () => {
      mock.method(globalThis, 'fetch', async () => Response.json({ result: payload === null ? null : JSON.stringify(payload) }));
      const response = await routeHandler()(new Request('https://worldmonitor.app/api/intelligence/v1/list-cross-source-signals'));
      if (payload === null) {
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
      } else {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { signals: [], evaluatedAt: 0, compositeCount: 0 });
      }
    });
  }
});
