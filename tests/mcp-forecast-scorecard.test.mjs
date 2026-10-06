import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find((entry) => entry.name === 'get_forecast_scorecard');

const DECLARED = {
  schemaVersion: 1,
  generatedAt: 456,
  rollingWindowDays: 180,
  methodology: 'fixture',
  totals: { entries: 2, resolved: 1, pending: 1, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 0.5 },
  overall: { count: 1, brier: 0.04, logScore: 0.22 },
  byDomain: [{ domain: 'market', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
  byGenerationOrigin: [{ generationOrigin: 'detector', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
  calibration: [{ bucket: '80-90', minProbability: 0.8, maxProbability: 0.9, count: 1, predictedMean: 0.8, realizedRate: 1, brier: 0.04 }],
  vsMarketSkill: { count: 1, forecastBrier: 0.04, marketBrier: 0.09, brierDelta: 0.05 },
  skill: { count: 1, brier: 0.04, logScore: 0.22, excludedScored: 1, excludedOrigins: ['bet_engine'] },
  publishedByDomain: [{ domain: 'market', count: 1, brier: 0.04, yesCount: 1 }],
  uncertainty: {
    method: 'entry-level percentile bootstrap, 1000 resamples, seed 7072',
    overallBrier: { count: 1, mean: 0.04, ci95: [0.04, 0.04], insufficientSample: true },
  },
  funnel: {
    matured: 2, immature: 0, maturityUnknown: 0, resolved: 1, scored: 1, pendingHardMatured: 1, pendingJudgeMatured: 0,
    resolvedOfMatured: { count: 2, successes: 1, rate: 0.5, ci95: [0.094531, 0.905469] },
    scoredOfMatured: { count: 2, successes: 1, rate: 0.5, ci95: [0.094531, 0.905469] },
  },
};

async function runTool(stored, params = {}) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    const value = Object.hasOwn(stored, key) ? stored[key] : null;
    return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }), { status: 200 });
  };
  try {
    return await executeTool(tool, params);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

describe('get_forecast_scorecard MCP projection (#8892)', () => {
  it('serves the declared scorecard fields and withholds internal producer blocks', async () => {
    const result = await runTool({
      'forecast:scorecard:v1': {
        _seed: { fetchedAt: Date.now() },
        data: {
          ...DECLARED,
          judgedLane: { pendingJudge: 3, attemptClasses: { archive_incomplete: 9 } },
          calibrationShadow: { activationGate: { verdict: 'hold' }, map: [{ bucket: '80-90' }] },
          futureInternalMetric: { syntheticMarker: 'not-part-of-response' },
        },
      },
      'seed-meta:forecast:scorecard': { fetchedAt: Date.now() },
    });

    assert.deepEqual(result.data.scorecard, DECLARED);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('judgedLane'), false);
    assert.equal(serialized.includes('calibrationShadow'), false);
    assert.equal(serialized.includes('syntheticMarker'), false);
  });

  it('omits null nested intervals and rates instead of serving null where the contract has a message', async () => {
    const result = await runTool({
      'forecast:scorecard:v1': {
        ...DECLARED,
        uncertainty: { ...DECLARED.uncertainty, skillBrier: null },
        funnel: { ...DECLARED.funnel, resolvedOfMatured: null, scoredOfMatured: null },
      },
      'seed-meta:forecast:scorecard': { fetchedAt: Date.now() },
    });
    assert.equal(Object.hasOwn(result.data.scorecard.uncertainty, 'skillBrier'), false);
    assert.equal(Object.hasOwn(result.data.scorecard.funnel, 'resolvedOfMatured'), false);
    assert.equal(Object.hasOwn(result.data.scorecard.funnel, 'scoredOfMatured'), false);
    assert.equal(result.data.scorecard.funnel.matured, 2);
  });

  it('filters internal keys inside the interval and funnel blocks, and leaves nulls in older blocks alone', async () => {
    const result = await runTool({
      'forecast:scorecard:v1': {
        ...DECLARED,
        skill: { ...DECLARED.skill, logScore: null },
        uncertainty: { ...DECLARED.uncertainty, draws: [0.1], overallBrier: { ...DECLARED.uncertainty.overallBrier, scope: 'overall' } },
        funnel: { ...DECLARED.funnel, entryIds: ['a'], scoredOfMatured: { ...DECLARED.funnel.scoredOfMatured, sampleIds: ['b'] } },
      },
      'seed-meta:forecast:scorecard': { fetchedAt: Date.now() },
    });
    assert.deepEqual(result.data.scorecard.uncertainty, DECLARED.uncertainty);
    assert.deepEqual(result.data.scorecard.funnel, DECLARED.funnel);
    assert.equal(result.data.scorecard.skill.logScore, null, 'existing blocks keep serving null');
  });

  it('withholds internal blocks from summary output too', async () => {
    const result = await runTool({
      'forecast:scorecard:v1': { ...DECLARED, judgedLane: { pendingJudge: 3 }, calibrationShadow: { verdict: 'hold' } },
      'seed-meta:forecast:scorecard': { fetchedAt: Date.now() },
    }, { summary: true });

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('judgedLane'), false);
    assert.equal(serialized.includes('calibrationShadow'), false);
  });

  it('declares every field it serves in outputSchema', () => {
    const declared = Object.keys(tool.outputSchema.properties.data.properties.scorecard.properties).sort();
    assert.deepEqual(declared, Object.keys(DECLARED).sort());
  });
});
