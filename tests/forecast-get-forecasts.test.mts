import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalEnv = { ...process.env };

const REDIS_KEY = 'forecast:predictions:v2';

function makeCtx() {
  const req = new Request('https://worldmonitor.app/api/forecast/v1/get-forecasts');
  return { request: req, pathParams: {}, headers: {} };
}

function makeForecast(overrides: Partial<import('../src/generated/server/worldmonitor/forecast/v1/service_server').Forecast>) {
  return {
    id: 'forecast-default',
    domain: 'market',
    region: 'Global',
    title: 'Default forecast',
    scenario: 'Base case',
    feedSummary: 'Default feed summary',
    probability: 0.5,
    confidence: 0.7,
    timeHorizon: '7d',
    signals: [],
    cascades: [],
    trend: 'stable',
    priorProbability: 0.45,
    createdAt: 1,
    updatedAt: 2,
    simulationAdjustment: 0,
    simPathConfidence: 0,
    demotedBySimulation: false,
    ...overrides,
  };
}

function restoreEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
}

describe('getForecasts backend status', () => {
  let getForecasts: typeof import('../server/worldmonitor/forecast/v1/get-forecasts').getForecasts;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const mod = await import('../server/worldmonitor/forecast/v1/get-forecasts.ts');
    getForecasts = mod.getForecasts;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    restoreEnv();
  });

  it('returns degraded=true when the Redis/backend read fails', async () => {
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    globalThis.fetch = (async () => {
      throw new Error('redis unavailable');
    }) as typeof fetch;

    const res = await getForecasts(makeCtx(), { domain: '', region: '' });

    assert.deepEqual(res, {
      forecasts: [],
      generatedAt: 0,
      degraded: true,
      stale: false,
      error: 'forecast_backend_unavailable',
    });
    assert.deepEqual(errors, [['[forecast] getRawJson failed:', 'redis unavailable']]);
  });

  it('keeps a healthy cache miss distinct from a backend failure', async () => {
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      assert.ok(url.endsWith(`/get/${encodeURIComponent(REDIS_KEY)}`));
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecasts(makeCtx(), { domain: '', region: '' });

    assert.deepEqual(res, {
      forecasts: [],
      generatedAt: 0,
      degraded: false,
      stale: false,
      error: '',
    });
  });

  it('unwraps seeded forecast envelopes and filters the happy path', async () => {
    const gulfMarket = makeForecast({
      id: 'gulf-market',
      domain: 'market',
      region: 'Gulf states',
      title: 'Gulf shipping premium widens',
    });
    const europeConflict = makeForecast({
      id: 'europe-conflict',
      domain: 'conflict',
      region: 'Europe',
      title: 'Eastern Europe alert level rises',
    });
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      assert.ok(url.endsWith(`/get/${encodeURIComponent(REDIS_KEY)}`));
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: {
            fetchedAt: 123,
            recordCount: 2,
            sourceVersion: 'test',
            schemaVersion: 1,
            state: 'OK',
          },
          data: {
            predictions: [gulfMarket, europeConflict],
            generatedAt: 456,
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecasts(makeCtx(), { domain: 'market', region: 'gulf' });

    assert.deepEqual(res, {
      forecasts: [gulfMarket],
      generatedAt: 456,
      degraded: false,
      stale: false,
      error: '',
    });
  });
});
