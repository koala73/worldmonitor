import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import forecastRoute from '../api/forecast/v1/[rpc].ts';
import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import {
  MARKET_ALERT_MIN_SAMPLE,
  marketAlertMedianPublished,
  SCORECARD_DECLARED_FIELDS,
  SCORECARD_LIVE_ONLY_FIELDS,
  SCORECARD_NESTED_CHILD_FIELDS,
  SCORECARD_NESTED_OBJECT_FIELDS,
  SCORECARD_NESTED_ROW_FIELDS,
  HORIZON_GRADE_FIELDS as PAGE_HORIZON_GRADE_FIELDS,
  HORIZON_GRADE_ROW_FIELDS as PAGE_HORIZON_GRADE_ROW_FIELDS,
  selectDeclaredScorecardFields,
} from '../scripts/build-accuracy-page.mjs';
import {
  FAMILY_OUTCOME_FIELDS,
  HORIZON_GRADE_FIELDS,
  HORIZON_GRADE_MIN_FAMILIES,
  HORIZON_GRADE_MIN_OUTCOME_FAMILIES,
  HORIZON_GRADE_ROW_FIELDS,
  MARKET_ALERT_FIELDS,
  MARKET_ALERT_MEDIAN_MIN_HITS,
  MARKET_ALERT_ROW_FIELDS,
  PUBLISHED_DOMAIN_EXTENDED_FIELDS,
  PUBLISHED_DOMAIN_FIELDS,
  RECEIPT_FIELDS,
  SCORECARD_BLOCK_FIELDS,
  SKILL_EXTENDED_FIELDS,
  SKILL_FIELDS,
  selectMarketAlertScorecard,
  selectScorecardFields,
} from '../server/worldmonitor/forecast/v1/scorecard-fields.ts';
import { PUBLIC_FAMILY_OUTCOME_FIELDS, PUBLIC_RECEIPT_FIELDS, SKILL_MIN_FAMILIES, SKILL_MIN_OUTCOME_FAMILIES } from '../scripts/_forecast-scorecard.mjs';
import { FORECAST_ACCURACY_AUDIT_OVERRIDE, STANDING_ACCURACY_AUDIT, accuracyAuditOverride, forecastAccuracyAudit, headlineFamilyGate, isAccuracyAudit } from '../shared/forecast-accuracy-audit.js';
import { computeScorecard } from '../scripts/_forecast-scorecard.mjs';
import { accuracyDatasetDownload, accuracyStateAudit, classifyAccuracyState, renderAccuracyLlmsSection } from '../scripts/build-accuracy-page.mjs';
import { forecastReliability, forecastScorecardDescription, projectForecastScorecard } from '../api/mcp/registry/cache-tools.ts';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalEnv = { ...process.env };

const REDIS_KEY = 'forecast:scorecard:v1';
const AUDIT = { since: '2026-10-07', issue: 8990, reason: 'Scoring errors found.' };
// Every fixture below is unmeasurable, so the standing audit holds (#8990).
const HELD = FORECAST_ACCURACY_AUDIT_OVERRIDE ?? STANDING_ACCURACY_AUDIT;
const LIVE_UNDER_AUDIT = { underAudit: { since: HELD.since, reason: HELD.reason, issue: HELD.issue } };
const MARKET_ALERTS_KEY = 'correlation:market-alerts:scorecard:v1';

const FORECAST_DATA = {
  schemaVersion: 1,
  generatedAt: 456,
  rollingWindowDays: 180,
  methodology: 'test methodology',
  totals: { entries: 1, resolved: 1, pending: 0, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
};

// What seed-market-alert-ledger stores: the public block plus seeder totals,
// archive status and per-row outcome counts that stay off the contract.
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
const MARKET_ALERTS_SERVED = {
  generatedAt: 789,
  windowHours: 6,
  rollingWindowDays: 30,
  methodology: 'market-alert methodology',
  byType: [
    { type: 'market', scored: 40, hitRate: 0.75, baseN: 2, baseHitRate: 0.5, pairedHitRate: 0.5, medianLeadTimeMs: 3600000 },
    { type: 'prediction-market', scored: 0, baseN: 0 },
  ],
};

function envelope(data: unknown) {
  return { _seed: { fetchedAt: Date.now() }, data };
}

function serveRedis(stored: Record<string, unknown>, failing: string[] = []) {
  globalThis.fetch = (async (input) => {
    const key = decodeURIComponent(String(input).split('/get/')[1] ?? '');
    if (failing.includes(key)) throw new Error(`redis unavailable for ${key}`);
    const value = Object.hasOwn(stored, key) ? stored[key] : null;
    return Response.json({ result: value == null ? null : JSON.stringify(value) });
  }) as typeof fetch;
}

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

  it('does not serve the internal judgedLane block on the typed response (#7068)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      result: JSON.stringify({
        _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'test', schemaVersion: 1, state: 'OK' },
        data: {
          schemaVersion: 1,
          generatedAt: 456,
          rollingWindowDays: 180,
          methodology: 'test methodology',
          totals: { entries: 1, resolved: 1, pending: 0, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
          // Operator observability written by the resolutions seeder. It is not
          // in the proto, so it must not ride out on this typed response.
          judgedLane: { pendingJudge: 3, attemptClasses: { archive_incomplete: 9 }, scoredWithinSlaRate: 0.5 },
          // The go-forward VOID-share cohort (#4930) reaches the public only
          // through the methodology sentence.
          goForward: { since: '2026-10-08', resolved: 4, void: 1, voidShare: 0.25, voidByReason: { all_judges_void: 1 } },
          // The seed-meta record count (#8990), every origin included.
          ledgerEntries: 7,
        },
      }),
    }), { status: 200 })) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.totals?.entries, 1, 'declared fields still pass through');
    assert.equal(JSON.stringify(res).includes('judgedLane'), false);
    assert.equal(JSON.stringify(res).includes('archive_incomplete'), false);
    assert.equal(JSON.stringify(res).includes('goForward'), false);
    assert.equal(JSON.stringify(res).includes('all_judges_void'), false);
    assert.equal(JSON.stringify(res).includes('ledgerEntries'), false);
  });

  it('the public RPC serializes only declared top-level cache fields', async () => {
    process.env.WM_SESSION_SECRET = 'synthetic-scorecard-session-secret-long-enough';
    const token = (await issueSessionToken()).token;
    const data = {
      schemaVersion: 1, generatedAt: 456, rollingWindowDays: 180, methodology: 'fixture',
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
      familyOutcomes: [{ forecastId: 'fc-conflict-1', outcome: 'YES' }, { forecastId: 'fc-conflict-1', outcome: 'VOID', voidReason: 'no_archive_evidence' }],
      degraded: false, stale: false, error: '',
    };
    const { fetchImpl } = createRedisFetch({});
    const stored: Record<string, unknown> = {
      [REDIS_KEY]: envelope({
        ...data,
        uncertainty: { ...data.uncertainty, skillBrier: null, draws: [0.1], overallBrier: { ...data.uncertainty.overallBrier, scope: 'overall' } },
        funnel: { ...data.funnel, entryIds: ['a'], resolvedOfMatured: { ...data.funnel.resolvedOfMatured, sampleIds: ['b'] } },
        receipts: data.receipts.map((row) => ({ ...row, key: 'ledger-key', rationale: 'judge text' })),
        familyOutcomes: data.familyOutcomes.map((row) => ({ ...row, key: 'ledger-key', evidence: { reason: 'raw' } })),
        judgedLane: { pendingJudge: 3 },
        betEngine: { count: 1, vsBaseRate: { brierDelta: 0.02 }, deviationSkill: { count: 1 } },
        futureInternalMetric: { syntheticMarker: 'not-part-of-response' },
      }),
      [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED),
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const key = decodeURIComponent(url.split('/get/')[1] ?? '');
      if (Object.hasOwn(stored, key)) return Response.json({ result: JSON.stringify(stored[key]) });
      assert.equal(new URL(url).origin, 'https://fake-upstash.example', 'all I/O must stay in the mock');
      return fetchImpl(input, init);
    };
    const response = await forecastRoute(new Request(makeCtx().request.url, {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
    }));
    assert.equal(response.status, 200);
    const serialized = await response.json();
    assert.deepEqual(
      Object.keys(serialized).sort(),
      [...SCORECARD_DECLARED_FIELDS, ...SCORECARD_LIVE_ONLY_FIELDS].sort(),
    );
    assert.deepEqual(
      serialized,
      { ...data, marketAlerts: MARKET_ALERTS_SERVED, ...LIVE_UNDER_AUDIT },
      'every declared field must survive the real gateway and serializer, and a null interval is omitted',
    );
  });

  it('flags the response under audit with the contract members only (#8993)', async () => {
    const { scorecardUnderAudit } = await import('../server/worldmonitor/forecast/v1/get-forecast-scorecard.ts');
    assert.deepEqual(scorecardUnderAudit(AUDIT), { underAudit: { since: '2026-10-07', reason: 'Scoring errors found.', issue: 8990 } });
    assert.deepEqual(scorecardUnderAudit(STANDING_ACCURACY_AUDIT).underAudit, { since: '2026-10-07', reason: STANDING_ACCURACY_AUDIT.reason, issue: 8990 }, 'liftsWhenMeasurable stays off the contract');
    assert.deepEqual(scorecardUnderAudit(null), {}, 'a lifted audit leaves the field absent');
  });

  it('holds the audit on unmeasurable healthy, empty and degraded responses (#8993)', async () => {
    console.error = () => {};
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ['healthy', { [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED) }, []],
      ['empty', {}, []],
      ['degraded', {}, [REDIS_KEY, MARKET_ALERTS_KEY]],
    ];
    for (const [label, stored, failing] of cases) {
      serveRedis(stored, failing);
      const res = await getForecastScorecard(makeCtx(), {});
      assert.equal(Object.hasOwn(res, 'underAudit'), true, label);
      assert.deepEqual(res.underAudit, LIVE_UNDER_AUDIT.underAudit, label);
    }
  });

  it('never passes a seeder underAudit through (#8993)', async () => {
    serveRedis({ [REDIS_KEY]: envelope({ ...FORECAST_DATA, underAudit: { since: 'seeder', reason: 'x', issue: 1 } }) });
    const res = await getForecastScorecard(makeCtx(), {});
    assert.deepEqual(res.underAudit, LIVE_UNDER_AUDIT.underAudit);
  });

  it('filters the market-alert block with the member lists the /accuracy/ page keeps', () => {
    const numbered = (fields: readonly string[]) => Object.fromEntries(fields.map((field, index) => [field, index + 1]));
    const selected = selectDeclaredScorecardFields({
      marketAlerts: {
        ...numbered([...MARKET_ALERT_FIELDS, 'schemaVersion', 'totals', 'archive']),
        byType: [numbered([...MARKET_ALERT_ROW_FIELDS, 'pending', 'resolved', 'hit', 'miss', 'void'])],
      },
    });
    assert.deepEqual(Object.keys(selected.marketAlerts).sort(), [...MARKET_ALERT_FIELDS].sort());
    assert.deepEqual(Object.keys(selected.marketAlerts.byType[0]).sort(), [...MARKET_ALERT_ROW_FIELDS].sort());
  });

  it('filters receipt rows with the member list the producer publishes', () => {
    assert.deepEqual([...RECEIPT_FIELDS], [...PUBLIC_RECEIPT_FIELDS]);
    assert.deepEqual([...FAMILY_OUTCOME_FIELDS], [...PUBLIC_FAMILY_OUTCOME_FIELDS]);
  });

  it('serves the contract skill members on REST and the seeder extras only to MCP (#8990)', () => {
    const numbered = (fields: readonly string[]) => Object.fromEntries(fields.map((field, index) => [field, index + 1]));
    const data = {
      skill: numbered([...SKILL_FIELDS, ...SKILL_EXTENDED_FIELDS, 'internal']),
      publishedByDomain: [numbered([...PUBLISHED_DOMAIN_FIELDS, ...PUBLISHED_DOMAIN_EXTENDED_FIELDS, 'internal'])],
    };
    const rest = selectScorecardFields(data);
    assert.deepEqual(Object.keys(rest.skill ?? {}).sort(), [...SKILL_FIELDS].sort());
    assert.deepEqual(Object.keys(rest.publishedByDomain?.[0] ?? {}).sort(), [...PUBLISHED_DOMAIN_FIELDS].sort());
    const mcp = selectScorecardFields(data, { extended: true });
    assert.deepEqual(Object.keys(mcp.skill ?? {}).sort(), [...SKILL_FIELDS, ...SKILL_EXTENDED_FIELDS].sort());
    assert.deepEqual(Object.keys(mcp.publishedByDomain?.[0] ?? {}).sort(), [...PUBLISHED_DOMAIN_FIELDS, ...PUBLISHED_DOMAIN_EXTENDED_FIELDS].sort());
    assert.deepEqual([...SKILL_FIELDS], [...SCORECARD_NESTED_OBJECT_FIELDS.skill], 'the /accuracy/ capture keeps the same skill members');
    assert.deepEqual([...PUBLISHED_DOMAIN_FIELDS], [...SCORECARD_NESTED_ROW_FIELDS.publishedByDomain], 'and the same domain members');
  });

  // The count of headline rows with pre-#7071 anchors stays off every public
  // field (#9010); the methodology sentence states it instead (#8990).
  it('keeps skill.preLineageAnchorCount off REST, MCP and the /accuracy/ capture', () => {
    for (const list of [SKILL_FIELDS, SKILL_EXTENDED_FIELDS, SCORECARD_NESTED_OBJECT_FIELDS.skill]) {
      assert.ok(!list.includes('preLineageAnchorCount'));
    }
    const data = { skill: { count: 3, preLineageAnchorCount: 1 } };
    for (const extended of [false, true]) {
      const { skill } = selectScorecardFields(data, { extended });
      assert.equal(skill?.count, 3);
      assert.ok(!Object.hasOwn(skill ?? {}, 'preLineageAnchorCount'));
    }
    assert.ok(!Object.hasOwn((selectDeclaredScorecardFields(data) as { skill?: object }).skill ?? {}, 'preLineageAnchorCount'));
  });

  // Horizon grades (#9057) have no room in the public OpenAPI document, so
  // only MCP serves them; /accuracy/ reads them through MCP with the same lists.
  it('serves horizon grades to MCP only, counts only below the family minimums', () => {
    assert.deepEqual([...HORIZON_GRADE_FIELDS], [...PAGE_HORIZON_GRADE_FIELDS]);
    assert.deepEqual([...HORIZON_GRADE_ROW_FIELDS], [...PAGE_HORIZON_GRADE_ROW_FIELDS]);
    const graded = { curvesVersion: 1, horizon: 'd7', scored: 40, yes: 8, no: 32, families: 30, yesFamilies: 6, noFamilies: 24, measurable: true, brier: { mean: 0.1, ci95: [0.05, 0.2] }, realizedRate: { count: 40, successes: 8, rate: 0.2, ci95: [0.1, 0.35] }, registered: 50 };
    const short = { ...graded, horizon: 'h24', measurable: false };
    const data = { generatedAt: 1, horizonGrades: { semantics: 'point_in_time', note: 'n', minimums: {}, unversionedScored: 0, rows: [graded, short], internal: 1 } };
    assert.equal('horizonGrades' in selectScorecardFields(data), false, 'not on REST');
    const mcp = selectScorecardFields(data, { extended: true }) as { horizonGrades?: { rows: Record<string, unknown>[] } };
    assert.deepEqual(Object.keys(mcp.horizonGrades ?? {}).sort(), [...HORIZON_GRADE_FIELDS].sort());
    assert.deepEqual(Object.keys(mcp.horizonGrades?.rows[0] ?? {}).sort(), [...HORIZON_GRADE_ROW_FIELDS].sort());
    assert.ok(!('brier' in (mcp.horizonGrades?.rows[1] ?? {})) && !('realizedRate' in (mcp.horizonGrades?.rows[1] ?? {})));
    assert.equal('horizonGrades' in (selectDeclaredScorecardFields(data) ?? {}), false, 'nor in the REST-shaped capture');
  });

  it('re-checks the horizon minimums from the counts, not the stored flag (#9057)', () => {
    assert.equal(HORIZON_GRADE_MIN_FAMILIES, SKILL_MIN_FAMILIES);
    assert.equal(HORIZON_GRADE_MIN_OUTCOME_FAMILIES, SKILL_MIN_OUTCOME_FAMILIES);
    const graded = { curvesVersion: 1, horizon: 'd7', scored: 40, yes: 8, no: 32, families: 30, yesFamilies: 5, noFamilies: 5, measurable: true, brier: { mean: 0.1, ci95: [0.05, 0.2] }, realizedRate: { count: 40 } };
    const served = (row: Record<string, unknown>) => (selectScorecardFields({ horizonGrades: { rows: [row] } }, { extended: true }) as { horizonGrades: { rows: Record<string, unknown>[] } }).horizonGrades.rows[0];
    assert.equal(served(graded).measurable, true);
    assert.ok('brier' in served(graded), 'exactly at the minimums keeps its grade');
    for (const short of [{ families: 29 }, { yesFamilies: 4 }, { noFamilies: 4 }, { yesFamilies: 31 }, { families: '30' }]) {
      const row = served({ ...graded, ...short });
      assert.equal(row.measurable, false, JSON.stringify(short));
      assert.ok(!('brier' in row) && !('realizedRate' in row), JSON.stringify(short));
    }
  });

  // The corpus block is internal until the public contract has room (#7072).
  it('keeps the internal corpus block off REST, MCP and the /accuracy/ capture', () => {
    const data = { totals: { entries: 1 }, corpus: { publishedCount: 4, resolvedWithinSlaCount: 1, voidByReason: { feed_unavailable: 1 } } };
    assert.equal('corpus' in selectScorecardFields(data), false);
    assert.equal('corpus' in selectScorecardFields(data, { extended: true }), false);
    assert.equal('corpus' in (selectDeclaredScorecardFields(data) ?? {}), false);
  });

  it('keeps the internal uncertainty intervals off REST, MCP and the /accuracy/ capture (#7072)', () => {
    const internal = ['overallLogScore', 'skillLogScore', 'byDomain', 'byGenerationOrigin', 'vsMarket'];
    const uncertainty = { method: 'm', overallBrier: null, skillBrier: null, ...Object.fromEntries(internal.map((name) => [name, { count: 1 }])) };
    const outputs = [
      selectScorecardFields({ uncertainty }).uncertainty,
      selectScorecardFields({ uncertainty }, { extended: true }).uncertainty,
      (selectDeclaredScorecardFields({ uncertainty }) as { uncertainty?: object }).uncertainty,
    ];
    for (const output of outputs) {
      assert.equal((output as { method?: string })?.method, 'm');
      for (const name of internal) assert.ok(!Object.hasOwn(output ?? {}, name), name);
    }
  });

  it('filters the interval and funnel blocks with the same member lists the /accuracy/ page uses', () => {
    for (const [block, { fields, children }] of Object.entries(SCORECARD_BLOCK_FIELDS)) {
      assert.deepEqual([...fields], [...SCORECARD_NESTED_OBJECT_FIELDS[block]], `${block} members`);
      assert.deepEqual(
        Object.fromEntries(Object.entries(children).map(([key, list]) => [key, [...list]])),
        Object.fromEntries(Object.entries(SCORECARD_NESTED_CHILD_FIELDS[block]).map(([key, list]) => [key, [...list]])),
        `${block} children`,
      );
    }
  });

  it('serves the market-alert scorecard from its own key, whitelisted member by member (#8867)', async () => {
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.deepEqual(res.marketAlerts, MARKET_ALERTS_SERVED);
    assert.equal(res.totals?.entries, 1);
    assert.equal(res.degraded, false);
  });

  it('serves the median lead time as a whole number of milliseconds, as int64 declares', async () => {
    const stored = { ...MARKET_ALERTS_STORED, byType: [{ ...MARKET_ALERTS_STORED.byType[0], medianLeadTimeMs: 1000.5 }] };
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(stored) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.marketAlerts?.byType[0]?.medianLeadTimeMs, 1001);
  });

  it('serves the median lead time only once a type has 30 hits, the floor /accuracy/ applies (#8985)', async () => {
    const market = MARKET_ALERTS_STORED.byType[0];
    const stored = {
      ...MARKET_ALERTS_STORED,
      byType: [
        { ...market, type: 'at-floor', hit: 30 },
        { ...market, type: 'below-floor', hit: 29, miss: 11 },
        { ...market, type: 'no-hit-count', hit: undefined },
      ],
    };
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(stored) });

    const res = await getForecastScorecard(makeCtx(), {});

    const median = Object.fromEntries((res.marketAlerts?.byType ?? []).map((row) => [row.type, row.medianLeadTimeMs]));
    assert.deepEqual(median, { 'at-floor': 3600000, 'below-floor': undefined, 'no-hit-count': undefined });
    assert.equal(MARKET_ALERT_MEDIAN_MIN_HITS, MARKET_ALERT_MIN_SAMPLE, 'the API and the page share one floor');
  });

  it('withholds the median exactly where /accuracy/ reads Not yet measurable, control gate included (#8985)', () => {
    const rows = [];
    for (const type of ['silent_divergence', 'prediction_leads_news']) {
      for (const hit of [29, 30, 40]) {
        for (const baseN of [0, 12, 29, 30]) {
          for (const paired of [null, 0.5]) {
            rows.push({
              type, pending: 0, resolved: hit + 10, hit, miss: 10, void: 0, n: hit + 10, hitRate: hit / (hit + 10),
              baseN, pairedHitRate: baseN > 0 ? paired : null, baseHitRate: baseN > 0 ? 0.25 : null, medianLeadTimeMs: 3600000,
            });
          }
        }
      }
    }
    const served = selectMarketAlertScorecard({ ...MARKET_ALERTS_STORED, byType: rows })?.byType ?? [];
    assert.equal(served.length, rows.length);
    let shown = 0;
    served.forEach((row, index) => {
      const pageShows = marketAlertMedianPublished({ ...row, medianLeadTimeMs: rows[index].medianLeadTimeMs });
      shown += Number(pageShows);
      assert.equal(Object.hasOwn(row, 'medianLeadTimeMs'), pageShows, JSON.stringify(rows[index]));
    });
    assert.ok(shown > 0 && shown < rows.length, 'the grid must cover both outcomes');
    const gated = served.find((row, index) => row.type === 'prediction_leads_news' && rows[index].hit === 40 && rows[index].baseN === 12);
    assert.equal(gated && Object.hasOwn(gated, 'medianLeadTimeMs'), false, 'prediction_leads_news waits for 30 scored controls');
  });

  it('starts both Redis reads before either answers', async () => {
    const events: string[] = [];
    const stored: Record<string, unknown> = { [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED) };
    globalThis.fetch = (async (input) => {
      const key = decodeURIComponent(String(input).split('/get/')[1] ?? '');
      events.push(`start ${key}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${key}`);
      return Response.json({ result: JSON.stringify(stored[key]) });
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.deepEqual(events.slice(0, 2).sort(), [`start ${MARKET_ALERTS_KEY}`, `start ${REDIS_KEY}`]);
    assert.deepEqual(res.marketAlerts, MARKET_ALERTS_SERVED);
  });

  it('keeps a response cacheable only when it carries the market-alert block', async () => {
    const noStore = async (stored: Record<string, unknown>, failing: string[] = []) => {
      console.error = () => {};
      serveRedis(stored, failing);
      const ctx = makeCtx();
      await getForecastScorecard(ctx, {});
      return drainResponseHeaders(ctx.request)?.['X-No-Cache'] === '1';
    };
    const forecast = { [REDIS_KEY]: envelope(FORECAST_DATA) };
    assert.equal(await noStore({ ...forecast, [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED) }), false, 'present');
    assert.equal(await noStore(forecast), true, 'missing');
    assert.equal(await noStore({ ...forecast, [MARKET_ALERTS_KEY]: envelope({ ...MARKET_ALERTS_STORED, generatedAt: null }) }), true, 'malformed');
    assert.equal(await noStore(forecast, [MARKET_ALERTS_KEY]), true, 'failed read');
  });

  it('the gateway serves no-store, with no CDN header, when the market-alert block is missing (#8985)', async () => {
    process.env.WM_SESSION_SECRET = 'synthetic-scorecard-session-secret-long-enough';
    const token = (await issueSessionToken()).token;
    const { fetchImpl } = createRedisFetch({});
    const throughGateway = async (stored: Record<string, unknown>) => {
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        const key = decodeURIComponent(url.split('/get/')[1] ?? '');
        if (Object.hasOwn(stored, key)) return Response.json({ result: JSON.stringify(stored[key]) });
        assert.equal(new URL(url).origin, 'https://fake-upstash.example', 'all I/O must stay in the mock');
        return fetchImpl(input, init);
      };
      const response = await forecastRoute(new Request(makeCtx().request.url, {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
      }));
      assert.equal(response.status, 200);
      return response;
    };
    const forecast = { [REDIS_KEY]: envelope(FORECAST_DATA) };

    const missing = await throughGateway(forecast);
    assert.equal(missing.headers.get('Cache-Control'), 'no-store');
    assert.equal(missing.headers.get('CDN-Cache-Control'), null);
    assert.equal(missing.headers.get('Vercel-CDN-Cache-Control'), null);
    assert.equal(missing.headers.get('X-No-Cache'), null, 'the internal marker never reaches the client');
    assert.equal(Object.hasOwn(await missing.json(), 'marketAlerts'), false);

    const present = await throughGateway({ ...forecast, [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED) });
    assert.match(present.headers.get('Cache-Control') ?? '', /max-age=\d+/, 'control: the same route caches once the block is back');
  });

  it('omits marketAlerts when its key is missing', async () => {
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(Object.hasOwn(res, 'marketAlerts'), false);
    assert.equal(res.degraded, false);
  });

  it('omits marketAlerts when the stored value carries no finite generatedAt', async () => {
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope({ ...MARKET_ALERTS_STORED, generatedAt: null }) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(Object.hasOwn(res, 'marketAlerts'), false);
  });

  it('omits marketAlerts and keeps the forecast scorecard undegraded when its read fails', async () => {
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA) }, [MARKET_ALERTS_KEY]);

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(Object.hasOwn(res, 'marketAlerts'), false);
    assert.equal(res.degraded, false);
    assert.equal(res.error, '');
    assert.equal(res.totals?.entries, 1);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), /market-alerts/);
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
    assert.deepEqual(errors, [
      ['[forecast] getForecastScorecard market-alerts read failed:', 'redis unavailable'],
      ['[forecast] getForecastScorecard getRawJson failed:', 'redis unavailable'],
    ]);
  });
});

// #8990: the audit lifts by itself once the seeder calls the headline
// measurable. Every surface derives it from the same scorecard, so for one
// seeded value REST, MCP, /accuracy/ (page, llms-full and download, built from
// the frozen REST capture) all agree, on both sides of the family minimums.
describe('the accuracy audit lifts with the scorecard on every surface (#8990)', () => {
  const NOW = Date.parse('2026-10-08T00:00:00Z');
  const DAY = 86_400_000;
  // families forecast ids, one resolved window each; the first `yes` came true.
  function ledger(families: number, yes: number) {
    return Object.fromEntries(Array.from({ length: families }, (_, i) => [`fam-${i}`, {
      id: `fam-${i}`, status: 'resolved', outcome: i < yes ? 'YES' : 'NO', probability: 0.3, domain: 'market',
      generationOrigin: 'detector', firstSeenAt: NOW - 5 * DAY, resolvedAt: NOW - DAY,
    }]));
  }
  const seed = (families: number, yes: number) => computeScorecard(ledger(families, yes), NOW) as Record<string, unknown> & { skill: { measurable: boolean } };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  async function surfaces(data: Record<string, unknown>) {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    serveRedis({ [REDIS_KEY]: envelope(data) });
    const { getForecastScorecard } = await import('../server/worldmonitor/forecast/v1/get-forecast-scorecard.ts');
    const rest = await getForecastScorecard(makeCtx() as never, {});
    const capture = selectDeclaredScorecardFields(rest);
    const section = { attemptedAt: '2026-10-08', attemptedAtMs: NOW, capturedAt: '2026-10-08', generatedAt: NOW, scorecard: capture, failureCode: '' };
    const state = classifyAccuracyState(section);
    const download = JSON.parse(accuracyDatasetDownload({ state, snapshotPath: 'fixture.json' }));
    const llms = renderAccuracyLlmsSection(section);
    return {
      rest: rest.underAudit ?? null,
      mcpScorecard: projectForecastScorecard({ scorecard: data, scorecardMeta: { fetchedAt: Date.now() } }).underAudit,
      mcpReliability: (forecastReliability({ scorecard: data, scorecardMeta: { fetchedAt: Date.now() } }, ['market']) as { underAudit?: unknown }).underAudit ?? null,
      download: download.underAudit,
      llmsUnderAudit: /^Under audit since /m.test(llms),
      coverage: state.coverage,
    };
  }

  const NOTICE = { since: STANDING_ACCURACY_AUDIT.since, issue: STANDING_ACCURACY_AUDIT.issue, reason: STANDING_ACCURACY_AUDIT.reason };

  it('lifts at exactly 30 families with 5 YES and 5 NO, on every surface', async () => {
    if (FORECAST_ACCURACY_AUDIT_OVERRIDE) return;
    const data = seed(30, 5);
    assert.equal(data.skill.measurable, true, 'the fixture sits exactly on the minimums');
    const got = await surfaces(data);
    assert.deepEqual(got, { rest: null, mcpScorecard: null, mcpReliability: null, download: null, llmsUnderAudit: false, coverage: 'measurable' });
  });

  for (const [label, families, yes] of [['29 families', 29, 5], ['4 YES families', 30, 4], ['4 NO families', 30, 26]] as const) {
    it(`holds one step below the minimums (${label}), on every surface`, async () => {
      const data = seed(families, yes);
      assert.equal(data.skill.measurable, false);
      const got = await surfaces(data);
      const held = FORECAST_ACCURACY_AUDIT_OVERRIDE ?? NOTICE;
      for (const key of ['rest', 'mcpScorecard', 'mcpReliability', 'download'] as const) {
        assert.deepEqual({ ...(got[key] as object) }, { since: held.since, issue: held.issue, reason: held.reason }, key);
      }
      assert.equal(got.llmsUnderAudit, true);
      assert.equal(got.coverage, 'small-sample');
    });
  }

  it('reads skill.measurable where the stored value carries it, and the interval flag on the capture', () => {
    const lifted = seed(30, 5);
    assert.equal(forecastAccuracyAudit(lifted, { override: null }), null);
    // The seeder's own verdict decides: flip it and the audit holds, interval notwithstanding.
    assert.equal(forecastAccuracyAudit({ ...lifted, skill: { ...lifted.skill, measurable: false } }, { override: null }), STANDING_ACCURACY_AUDIT);
    // The REST capture has no skill.measurable; its interval flag agrees with it.
    const capture = selectDeclaredScorecardFields(lifted);
    assert.equal(Object.hasOwn(capture.skill, 'measurable'), false);
    assert.equal(forecastAccuracyAudit(capture, { override: null }), null);
    for (const [families, yes] of [[30, 5], [29, 5], [30, 4], [30, 26], [40, 20], [1, 1]]) {
      const data = seed(families, yes) as { skill: { measurable: boolean }; uncertainty: { skillBrier: { insufficientSample: boolean } } };
      assert.equal(data.skill.measurable, !data.uncertainty.skillBrier.insufficientSample, `${families}/${yes}`);
    }
  });

  it('holds the audit for a missing, degraded or errored scorecard', () => {
    const lifted = seed(30, 5);
    for (const card of [null, undefined, {}, [], { ...lifted, degraded: true }, { ...lifted, error: 'forecast_scorecard_backend_unavailable' }, { ...lifted, skill: { ...lifted.skill, count: 0 } }]) {
      assert.equal(forecastAccuracyAudit(card, { override: null }), STANDING_ACCURACY_AUDIT);
    }
  });

  // Fail-safe (#8990): an old reading cannot lift the audit on any surface.
  it('holds the audit on a stale REST response even when the stale seed is measurable', async () => {
    if (FORECAST_ACCURACY_AUDIT_OVERRIDE) return;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const { getForecastScorecard } = await import('../server/worldmonitor/forecast/v1/get-forecast-scorecard.ts');
    const ageMs = (hours: number) => Date.now() - hours * 3_600_000;
    serveRedis({ [REDIS_KEY]: { _seed: { fetchedAt: ageMs(37) }, data: seed(30, 5) } });
    const stale = await getForecastScorecard(makeCtx() as never, {});
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.underAudit, NOTICE);
    serveRedis({ [REDIS_KEY]: { _seed: { fetchedAt: ageMs(35) }, data: seed(30, 5) } });
    const fresh = await getForecastScorecard(makeCtx() as never, {});
    assert.equal(fresh.stale, false);
    assert.equal(fresh.underAudit, undefined);
  });

  it('holds the audit on both MCP tools when the seed clock is stale or unknown', () => {
    if (FORECAST_ACCURACY_AUDIT_OVERRIDE) return;
    const data = seed(30, 5);
    const at = (hours: number | null) => (hours === null ? {} : { scorecardMeta: { fetchedAt: Date.now() - hours * 3_600_000 } });
    for (const [label, hours, held] of [['fresh', 1, false], ['stale', 37, true], ['unknown clock', null, true]] as const) {
      const card = projectForecastScorecard({ scorecard: data, ...at(hours) }).underAudit;
      const reliability = forecastReliability({ scorecard: data, ...at(hours) }, ['market']) as { underAudit?: unknown; status: string };
      assert.deepEqual(card, held ? NOTICE : null, `scorecard tool, ${label}`);
      assert.deepEqual(reliability.underAudit ?? null, held ? NOTICE : null, `reliability, ${label}`);
      assert.equal(reliability.status, held ? 'unavailable' : 'ready', label);
    }
  });

  it('holds the audit on /accuracy/, scorecard.json and llms-full for a stale, failed or retained capture', async () => {
    if (FORECAST_ACCURACY_AUDIT_OVERRIDE) return;
    const capture = selectDeclaredScorecardFields(seed(30, 5));
    const base = { attemptedAt: '2026-10-08', attemptedAtMs: NOW, capturedAt: '2026-10-08', generatedAt: NOW, scorecard: capture, failureCode: '' };
    const read = (section: Record<string, unknown>) => {
      const state = classifyAccuracyState(section);
      return {
        download: JSON.parse(accuracyDatasetDownload({ state, snapshotPath: 'fixture.json' })).underAudit,
        llms: /^Under audit since /m.test(renderAccuracyLlmsSection(section)),
        state: accuracyStateAudit(state),
      };
    };
    assert.deepEqual(read(base), { download: null, llms: false, state: null }, 'a fresh measurable capture lifts');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['older than the API stale budget', { ...base, attemptedAtMs: NOW + 37 * 3_600_000 }],
      ['flagged stale by the API', { ...base, scorecard: { ...capture, stale: true } }],
      ['retained after a failed capture', { ...base, failureCode: 'http-error', capturedAt: '2026-10-01' }],
      ['flagged by the live API at capture time', { ...base, scorecard: { ...capture, underAudit: { since: '2027-01-02', reason: 'Live incident.', issue: 9999 } } }],
      ['carrying a malformed live flag', { ...base, scorecard: { ...capture, underAudit: {} } }],
    ];
    for (const [label, section] of cases) {
      const got = read(section);
      assert.ok(got.download, label);
      assert.equal(got.llms, true, label);
      assert.ok(got.state, label);
    }
    const live = read(cases[3][1]);
    assert.deepEqual(live.download, { since: '2027-01-02', reason: 'Live incident.', issue: 9999 }, 'the captured live notice is the one shown');
    assert.deepEqual(read(cases[4][1]).download, NOTICE, 'a malformed live flag still holds, with the standing notice');
  });

  it('reads the interval fallback as unknown when it covers other rows than the headline', () => {
    const capture = selectDeclaredScorecardFields(seed(30, 5)) as { skill: { count: number; brier: number }; uncertainty: { skillBrier: { count: number; mean: number } } };
    assert.equal(headlineFamilyGate(capture), 'met');
    const withInterval = (patch: Record<string, unknown>) => ({ ...capture, uncertainty: { ...capture.uncertainty, skillBrier: { ...capture.uncertainty.skillBrier, ...patch } } });
    for (const [label, card] of [
      ['count differs', withInterval({ count: capture.skill.count + 1 })],
      ['mean differs', withInterval({ mean: capture.skill.brier + 0.001 })],
      ['mean differs past rounding', withInterval({ mean: capture.skill.brier + 2e-6 })],
    ] as const) {
      assert.equal(headlineFamilyGate(card), 'unknown', label);
      assert.equal(forecastAccuracyAudit(card, { override: null }), STANDING_ACCURACY_AUDIT, label);
    }
    assert.equal(headlineFamilyGate(withInterval({ mean: capture.skill.brier + 5e-7 })), 'met', 'six-decimal rounding still matches');
  });

  it('never prints a malformed override: it holds the standing notice instead', () => {
    for (const bad of [{}, { since: 'yesterday', issue: 1, reason: 'x' }, { since: '2027-01-02', issue: 0, reason: 'x' }, { since: '2027-01-02', issue: 1, reason: ' ' }, true]) {
      assert.equal(accuracyAuditOverride(bad as never), STANDING_ACCURACY_AUDIT, JSON.stringify(bad));
      assert.equal(forecastAccuracyAudit(seed(30, 5), { override: bad as never }), STANDING_ACCURACY_AUDIT, JSON.stringify(bad));
    }
    assert.ok(!forecastScorecardDescription({} as never).includes('undefined'));
    assert.equal(accuracyAuditOverride(null), null);
    if (FORECAST_ACCURACY_AUDIT_OVERRIDE) assert.ok(isAccuracyAudit(FORECAST_ACCURACY_AUDIT_OVERRIDE), 'the configured override is well-formed');
  });

  it('lets a manual override force the audit on while measurable, and never off', () => {
    const FORCED = Object.freeze({ since: '2027-01-02', issue: 9999, reason: 'Fixture incident.' });
    assert.equal(forecastAccuracyAudit(seed(30, 5), { override: FORCED }), FORCED);
    assert.equal(forecastAccuracyAudit(seed(29, 5), { override: FORCED }), FORCED);
    for (const off of [null, undefined, false, 0, '']) {
      assert.equal(forecastAccuracyAudit(seed(29, 5), { override: off as never }), STANDING_ACCURACY_AUDIT, `override ${String(off)} cannot lift an unmeasurable record`);
    }
  });
});
