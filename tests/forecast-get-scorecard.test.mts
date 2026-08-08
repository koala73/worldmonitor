import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalEnv = { ...process.env };

const REDIS_KEY = 'forecast:scorecard:v1';

function makeCtx() {
  const req = new Request('https://worldmonitor.app/api/forecast/v1/get-forecast-scorecard');
  return { request: req, pathParams: {}, headers: {} };
}

function restoreEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
}

describe('getForecastScorecard backend status', () => {
  let getForecastScorecard: typeof import('../server/worldmonitor/forecast/v1/get-forecast-scorecard').getForecastScorecard;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const mod = await import('../server/worldmonitor/forecast/v1/get-forecast-scorecard.ts');
    getForecastScorecard = mod.getForecastScorecard;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    restoreEnv();
  });

  it('unwraps seeded scorecard envelopes and passes camelCase fields through by name', async () => {
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      assert.ok(url.endsWith(`/get/${encodeURIComponent(REDIS_KEY)}`));
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: { fetchedAt: Date.now(), recordCount: 2, sourceVersion: 'test', schemaVersion: 1, state: 'OK' },
          data: {
            schemaVersion: 1,
            generatedAt: 456,
            rollingWindowDays: 180,
            methodology: 'test methodology',
            totals: { entries: 2, resolved: 1, pending: 1, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
            overall: { count: 1, brier: 0.04, logScore: 0.22 },
            byDomain: [{ domain: 'market', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
            byGenerationOrigin: [{ generationOrigin: 'detector', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
            calibration: [{ bucket: '80-90', minProbability: 0.8, maxProbability: 0.9, count: 1, predictedMean: 0.8, realizedRate: 1, brier: 0.04 }],
            vsMarketSkill: { count: 1, forecastBrier: 0.04, marketBrier: 0.09, brierDelta: 0.05 },
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.generatedAt, 456);
    assert.equal(res.totals?.entries, 2);
    assert.equal(res.overall?.brier, 0.04);
    assert.equal(res.byDomain[0].domain, 'market');
    assert.equal(res.vsMarketSkill?.brierDelta, 0.05);
    assert.equal(JSON.stringify(res).includes('_seed'), false);
    assert.equal(res.degraded, false);
    assert.equal(res.stale, false);
    assert.equal(res.error, '');
  });

  it('marks cached scorecards stale when the seed envelope is older than the health budget', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: {
            fetchedAt: Date.now() - 2161 * 60 * 1000,
            recordCount: 1,
            sourceVersion: 'test',
            schemaVersion: 1,
            state: 'OK',
          },
          data: {
            schemaVersion: 1,
            generatedAt: 456,
            rollingWindowDays: 180,
            methodology: 'test methodology',
            totals: { entries: 1, resolved: 1, pending: 0, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.degraded, false);
    assert.equal(res.stale, true);
  });

  it('returns a well-formed degraded empty response on backend failure', async () => {
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    globalThis.fetch = (async () => {
      throw new Error('redis unavailable');
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.degraded, true);
    assert.equal(res.error, 'forecast_scorecard_backend_unavailable');
    assert.equal(res.generatedAt, 0);
    assert.equal(res.totals?.entries, 0);
    assert.deepEqual(errors, [['[forecast] getForecastScorecard getRawJson failed:', 'redis unavailable']]);
  });
});
