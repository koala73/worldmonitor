import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { projectForecastScorecard } from '../api/mcp/registry/cache-tools.ts';
import { FORECAST_ACCURACY_AUDIT_OVERRIDE, STANDING_ACCURACY_AUDIT, forecastAccuracyAudit } from '../shared/forecast-accuracy-audit.js';

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
  receipts: [{ question: 'Will Brent reach 104.89 USD/bbl?', forecastAt: 1, probability: 0.35, outcome: 'NO', resolvedAt: 2, sourceFeed: 'commodity-prices', observedValue: 100.75 }],
  familyOutcomes: [{ forecastId: 'fc-conflict-1', outcome: 'YES' }, { forecastId: 'fc-conflict-1', outcome: 'VOID', voidReason: 'judge_disagreement' }],
  // MCP-only (#9057): the public OpenAPI document has no room for it.
  horizonGrades: {
    semantics: 'point_in_time',
    note: 'A projection is not a probability.',
    minimums: { families: 30, yesFamilies: 5, noFamilies: 5 },
    unversionedScored: 0,
    rows: [{ curvesVersion: 1, horizon: 'd7', scored: 1, yes: 1, no: 0, families: 1, yesFamilies: 1, noFamilies: 0, measurable: false }],
  },
};

const MARKET_ALERTS_STORED = {
  schemaVersion: 1,
  generatedAt: 789,
  windowHours: 6,
  rollingWindowDays: 30,
  methodology: 'market-alert methodology',
  totals: { pending: 1, resolved: 40, hit: 30, miss: 10, void: 0 },
  archive: { readFailed: false, truncated: false, unproven: false, coveredFromMs: 1, readAt: 2 },
  byType: [
    { type: 'market', pending: 1, resolved: 40, hit: 30, miss: 10, void: 0, n: 40, hitRate: 0.75, pairedHitRate: 0.5, baseN: 2, baseHitRate: 0.5, medianLeadTimeMs: 3600000 },
    { type: 'prediction-market', pending: 0, resolved: 0, hit: 0, miss: 0, void: 0, n: 0, hitRate: null, pairedHitRate: null, baseN: 0, baseHitRate: null, medianLeadTimeMs: null },
  ],
};
const MARKET_ALERTS = {
  generatedAt: 789,
  windowHours: 6,
  rollingWindowDays: 30,
  methodology: 'market-alert methodology',
  byType: [
    { type: 'market', scored: 40, hitRate: 0.75, baseN: 2, baseHitRate: 0.5, pairedHitRate: 0.5, medianLeadTimeMs: 3600000 },
    { type: 'prediction-market', scored: 0, baseN: 0 },
  ],
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

  it('names every row list it serves in the tool description', () => {
    assert.match(tool.description, /\breceipts\b/);
    assert.match(tool.description, /\bfamilyOutcomes\b/);
  });

  it('declares every field it serves in outputSchema', () => {
    const declared = Object.keys(tool.outputSchema.properties.data.properties.scorecard.properties).sort();
    assert.deepEqual(declared, Object.keys(DECLARED).sort());
  });

  it('serves the market-alert scorecard from its own key, whitelisted member by member (#8867)', async () => {
    const result = await runTool({
      'forecast:scorecard:v1': { _seed: { fetchedAt: Date.now() }, data: DECLARED },
      'correlation:market-alerts:scorecard:v1': { _seed: { fetchedAt: Date.now() }, data: MARKET_ALERTS_STORED },
      'seed-meta:forecast:scorecard': { fetchedAt: Date.now() },
    });

    assert.deepEqual(result.data.scorecard, DECLARED);
    assert.deepEqual(result.data.marketAlerts, MARKET_ALERTS);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('archive'), false);
    assert.equal(serialized.includes('coveredFromMs'), false);
  });

  it('serves a horizon row below the family minimums as counts only (#9057)', async () => {
    const stored = { ...DECLARED, horizonGrades: { ...DECLARED.horizonGrades, rows: [{ ...DECLARED.horizonGrades.rows[0], brier: { mean: 0.1, ci95: [0, 0.2] }, realizedRate: { count: 1 }, registered: 9 }] } };
    const result = await runTool({
      'forecast:scorecard:v1': { _seed: { fetchedAt: Date.now() }, data: stored },
      'seed-meta:forecast:scorecard': { fetchedAt: Date.now() },
    });
    assert.deepEqual(result.data.scorecard.horizonGrades, DECLARED.horizonGrades);
  });

  it('withholds a median lead time built on fewer than 30 hits (#8985)', () => {
    const fewHits = { ...MARKET_ALERTS_STORED, byType: [{ ...MARKET_ALERTS_STORED.byType[0], hit: 29 }] };
    const [row] = tool._project({ scorecard: DECLARED, marketAlerts: fewHits }).marketAlerts.byType;
    assert.equal(Object.hasOwn(row, 'medianLeadTimeMs'), false);
    assert.equal(row.scored, 40);
  });

  it('serves marketAlerts as null when its key is absent', async () => {
    const result = await runTool({
      'forecast:scorecard:v1': DECLARED,
      'seed-meta:forecast:scorecard': { fetchedAt: Date.now() },
    });
    assert.equal(result.data.marketAlerts, null);
    assert.deepEqual(result.data.scorecard, DECLARED);
  });

  it('projects only the declared blocks and the audit flag rather than spreading what the cache read returned', () => {
    const projected = tool._project({ scorecard: DECLARED, marketAlerts: MARKET_ALERTS_STORED, archive: { coveredFromMs: 1 } });
    assert.deepEqual(Object.keys(projected).sort(), ['marketAlerts', 'scorecard', 'underAudit']);
  });

  it('declares the market-alert container and row members in outputSchema', () => {
    const alerts = tool.outputSchema.properties.data.properties.marketAlerts;
    assert.deepEqual(Object.keys(alerts.properties).sort(), Object.keys(MARKET_ALERTS).sort());
    assert.deepEqual(
      Object.keys(alerts.properties.byType.items.properties).sort(),
      Object.keys(MARKET_ALERTS.byType[0]).sort(),
    );
  });
});

describe('get_forecast_scorecard under the accuracy audit (#8990)', () => {
  const AUDIT = Object.freeze({ since: '2026-10-07', issue: 8990, reason: 'Fixture reason.' });
  const data = { scorecard: { schemaVersion: 2, skill: { count: 243, brier: 0.110775 } }, marketAlerts: null };

  it('flags the result and keeps the raw scorecard', () => {
    const audited = projectForecastScorecard(data, AUDIT);
    assert.deepEqual(audited.underAudit, { since: '2026-10-07', issue: 8990, reason: 'Fixture reason.' });
    assert.equal(audited.scorecard.skill.brier, 0.110775);
    const lifted = projectForecastScorecard(data, null);
    assert.equal(lifted.underAudit, null);
    assert.deepEqual({ ...audited, underAudit: null }, lifted, 'the flag is the only difference');
  });

  it('derives the flag from the scorecard it serves and declares it in its output schema', () => {
    assert.deepEqual(tool._project(structuredClone(data)), projectForecastScorecard(structuredClone(data), forecastAccuracyAudit(data.scorecard)));
    assert.deepEqual(tool.outputSchema.properties.data.properties.underAudit.type, ['object', 'null']);
  });

  it('lifts once the seeder calls the headline measurable, and holds while it does not', () => {
    const held = FORECAST_ACCURACY_AUDIT_OVERRIDE ?? STANDING_ACCURACY_AUDIT;
    const withSkill = (measurable) => ({ ...data, scorecard: { ...data.scorecard, skill: { ...data.scorecard.skill, measurable } } });
    assert.deepEqual(tool._project(withSkill(false)).underAudit, { since: held.since, issue: held.issue, reason: held.reason });
    assert.deepEqual(tool._project(structuredClone(data)).underAudit, { since: held.since, issue: held.issue, reason: held.reason }, 'no verdict, no lift');
    if (FORECAST_ACCURACY_AUDIT_OVERRIDE) return;
    assert.equal(tool._project(withSkill(true)).underAudit, null);
  });
});
