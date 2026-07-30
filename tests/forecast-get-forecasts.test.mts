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

  it('passes a hard camelCase resolution spec through by name', async () => {
    const hardResolution = {
      kind: 'hard',
      metricKey: 'conflict:ucdp-events:v1|count(country=Mali)',
      operator: '>=',
      threshold: 12,
      baselineValue: 8,
      window: 'within-horizon',
      deadline: 1700000000000,
      sourceFeed: 'conflict:ucdp-events:v1',
      question: '',
    };
    const conflictForecast = makeForecast({
      id: 'mali-conflict',
      domain: 'conflict',
      region: 'Sahel',
      title: 'Mali conflict intensity rises',
      resolution: hardResolution,
    });
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      assert.ok(url.endsWith(`/get/${encodeURIComponent(REDIS_KEY)}`));
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: {
            fetchedAt: 123,
            recordCount: 1,
            sourceVersion: 'test',
            schemaVersion: 1,
            state: 'OK',
          },
          data: {
            predictions: [conflictForecast],
            generatedAt: 789,
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecasts(makeCtx(), { domain: '', region: '' });

    assert.equal(res.forecasts.length, 1);
    const resolution = res.forecasts[0].resolution as typeof hardResolution;
    assert.equal(resolution.kind, 'hard');
    assert.equal(resolution.metricKey, 'conflict:ucdp-events:v1|count(country=Mali)');
    assert.equal(resolution.sourceFeed, 'conflict:ucdp-events:v1');
    assert.equal(resolution.deadline, 1700000000000);
    assert.equal(resolution.operator, '>=');
    assert.equal(resolution.threshold, 12);
    assert.equal(resolution.baselineValue, 8);
    assert.equal(resolution.window, 'within-horizon');
    assert.ok(!('metric_key' in resolution), 'snake_case metric_key must not be present');
    assert.ok(!('source_feed' in resolution), 'snake_case source_feed must not be present');
    assert.deepEqual(res.forecasts, [conflictForecast]);
  });

  it('passes a judged camelCase resolution spec through by name', async () => {
    // Shape matches what buildResolutionOutputBlock actually writes for judged
    // specs: proto3-JSON omission — inapplicable optional fields are ABSENT
    // keys, never null and never ''/0 (a judged spec with threshold 0 would
    // read as a hard >= 0 bar). Matches the generated `threshold?: number`.
    const judgedResolution = {
      kind: 'judged',
      deadline: 1700000600000,
      question: 'Will political stability in the region deteriorate before the deadline?',
    };
    const politicalForecast = makeForecast({
      id: 'political-outlook',
      domain: 'political',
      region: 'Europe',
      title: 'Political stability outlook',
      resolution: judgedResolution,
    });
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      assert.ok(url.endsWith(`/get/${encodeURIComponent(REDIS_KEY)}`));
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: {
            fetchedAt: 123,
            recordCount: 1,
            sourceVersion: 'test',
            schemaVersion: 1,
            state: 'OK',
          },
          data: {
            predictions: [politicalForecast],
            generatedAt: 789,
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecasts(makeCtx(), { domain: '', region: '' });

    assert.equal(res.forecasts.length, 1);
    const resolution = res.forecasts[0].resolution;
    assert.ok(resolution, 'judged resolution must survive passthrough');
    assert.equal(resolution.kind, 'judged');
    assert.equal(resolution.question, 'Will political stability in the region deteriorate before the deadline?');
    assert.equal(resolution.deadline, 1700000600000);
    // Omission semantics: no threshold key at all on a judged spec.
    assert.ok(!('threshold' in resolution), 'judged spec must not carry a threshold key');
    assert.ok(!('baselineValue' in resolution), 'judged spec must not carry a baselineValue key');
    assert.ok(!('metric_key' in resolution), 'snake_case metric_key must not be present');
    assert.ok(!('source_feed' in resolution), 'snake_case source_feed must not be present');
    assert.deepEqual(res.forecasts, [politicalForecast]);
  });

  it('omits resolution for a forecast that never got a spec (absent key, per the generated optional type)', async () => {
    // The seeder omits the key entirely for an unspec'd forecast (proto3-JSON
    // omission for an unset optional message) — the generated
    // `resolution?: ResolutionSpec` is exactly honest for this shape, so no
    // null-as-undefined casts are needed anywhere.
    const noResolutionForecast = makeForecast({
      id: 'no-resolution-yet',
      domain: 'market',
      region: 'Global',
      title: 'Legacy forecast without a resolution spec',
    });
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      assert.ok(url.endsWith(`/get/${encodeURIComponent(REDIS_KEY)}`));
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: {
            fetchedAt: 123,
            recordCount: 1,
            sourceVersion: 'test',
            schemaVersion: 1,
            state: 'OK',
          },
          data: {
            predictions: [noResolutionForecast],
            generatedAt: 789,
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecasts(makeCtx(), { domain: '', region: '' });

    assert.equal(res.forecasts.length, 1);
    assert.ok(!('resolution' in res.forecasts[0]), 'unspec\'d forecast must have no resolution key');
    assert.equal(res.forecasts[0].resolution, undefined);
    assert.deepEqual(res.forecasts, [noResolutionForecast]);
  });
});
