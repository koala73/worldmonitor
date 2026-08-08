import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  makePrediction,
  buildHistorySnapshot,
  buildForecastCase,
  buildHistoryForecastEntry,
  buildPublishedForecastPayload,
} from '../scripts/seed-forecasts.mjs';

import {
  CONFLICT_COUNT_SOURCE_FEED,
  attachResolutionSpecs,
} from '../scripts/_forecast-resolution.mjs';

import {
  selectBenchmarkCandidates,
  summarizeObservedChange,
} from '../scripts/extract-forecast-benchmark-candidates.mjs';

import {
  toHistoricalBenchmarkEntry,
  mergeHistoricalBenchmarks,
  createJsonPatch,
  buildPreviewPayload,
} from '../scripts/promote-forecast-benchmark-candidate.mjs';

describe('forecast history snapshot', () => {
  it('buildHistorySnapshot stores a compact rolling snapshot', () => {
    const rich = makePrediction('conflict', 'Iran', 'Escalation risk: Iran', 0.7, 0.6, '7d', [
      { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 },
    ]);
    rich.newsContext = ['Iran military drills intensify after border incident'];
    buildForecastCase(rich);

    const thin = makePrediction('market', 'Europe', 'Energy stress: Europe', 0.5, 0.4, '30d', [
      { type: 'prediction_market', value: 'Broad market stress chatter', weight: 0.2 },
    ]);
    buildForecastCase(thin);

    const snapshot = buildHistorySnapshot({ generatedAt: 1234, predictions: [rich, thin] }, { maxForecasts: 1 });
    assert.equal(snapshot.generatedAt, 1234);
    assert.equal(snapshot.predictions.length, 1);
    assert.equal(snapshot.predictions[0].title, rich.title);
    assert.deepEqual(snapshot.predictions[0].signals[0], { type: 'cii', value: 'Iran CII 87 (critical)', weight: 0.4 });
  });
});

describe('forecast history candidate extraction', () => {
  it('summarizes observed change across consecutive snapshots', () => {
    const prior = {
      id: 'fc-conflict-1',
      domain: 'conflict',
      region: 'Iran',
      title: 'Escalation risk: Iran',
      probability: 0.5,
      confidence: 0.55,
      timeHorizon: '7d',
      trend: 'stable',
      signals: [{ type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 }],
      newsContext: ['Iran military drills intensify after border incident'],
      calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.45 },
      cascades: [],
    };
    const current = {
      ...prior,
      probability: 0.68,
      trend: 'rising',
      signals: [
        ...prior.signals,
        { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
      ],
      newsContext: [...prior.newsContext, 'Regional officials warn of retaliation risk'],
      calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.66 },
    };

    const observed = summarizeObservedChange(current, prior);
    assert.equal(observed.deltaProbability, 0.18);
    assert.deepEqual(observed.newSignals, ['3 UCDP conflict events']);
    assert.deepEqual(observed.newHeadlines, ['Regional officials warn of retaliation risk']);
    assert.equal(observed.marketMove, 0.21);
  });

  it('selects benchmark candidates from rolling history', () => {
    const newest = {
      generatedAt: Date.parse('2024-04-14T12:00:00Z'),
      predictions: [{
        id: 'fc-conflict-1',
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.74,
        confidence: 0.64,
        timeHorizon: '7d',
        trend: 'rising',
        signals: [
          { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
          { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
        ],
        newsContext: [
          'Iran military drills intensify after border incident',
          'Regional officials warn of retaliation risk',
        ],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.71 },
        cascades: [],
      }],
    };
    const prior = {
      generatedAt: Date.parse('2024-04-13T12:00:00Z'),
      predictions: [{
        id: 'fc-conflict-1',
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.46,
        confidence: 0.55,
        timeHorizon: '7d',
        trend: 'stable',
        signals: [
          { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
        ],
        newsContext: ['Iran military drills intensify after border incident'],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.45 },
        cascades: [],
      }],
    };

    const candidates = selectBenchmarkCandidates([newest, prior], { maxCandidates: 5 });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].name, /escalation_risk_iran_2024_04_14/);
    assert.equal(candidates[0].observedChange.deltaProbability, 0.28);
    assert.ok(candidates[0].interestingness > 0.2);
  });

  it('ignores headline churn when there is no meaningful state change', () => {
    const newest = {
      generatedAt: Date.parse('2024-04-14T12:00:00Z'),
      predictions: [{
        id: 'fc-conflict-1',
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.46,
        confidence: 0.55,
        timeHorizon: '7d',
        trend: 'stable',
        signals: [
          { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
          { type: 'news_corroboration', value: '6 headline(s) mention Iran or linked entities', weight: 0.15 },
        ],
        newsContext: [
          'Regional officials warn of retaliation risk',
          'Fresh commentary on Iranian posture appears',
        ],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.46 },
        cascades: [],
      }],
    };
    const prior = {
      generatedAt: Date.parse('2024-04-13T12:00:00Z'),
      predictions: [{
        id: 'fc-conflict-1',
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.455,
        confidence: 0.55,
        timeHorizon: '7d',
        trend: 'stable',
        signals: [
          { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
          { type: 'news_corroboration', value: '60 headline(s) mention Iran or linked entities', weight: 0.15 },
        ],
        newsContext: [
          'Earlier commentary on Iranian posture appears',
        ],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.455 },
        cascades: [],
      }],
    };

    const candidates = selectBenchmarkCandidates([newest, prior], { maxCandidates: 5 });
    assert.equal(candidates.length, 0);
  });
});

describe('forecast benchmark promotion', () => {
  it('builds a historical benchmark entry with derived thresholds', () => {
    const newest = {
      generatedAt: Date.parse('2024-04-14T12:00:00Z'),
      predictions: [{
        id: 'fc-conflict-1',
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.74,
        confidence: 0.64,
        timeHorizon: '7d',
        trend: 'rising',
        signals: [
          { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
          { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
        ],
        newsContext: [
          'Iran military drills intensify after border incident',
          'Regional officials warn of retaliation risk',
        ],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.71 },
        cascades: [],
      }],
    };
    const prior = {
      generatedAt: Date.parse('2024-04-13T12:00:00Z'),
      predictions: [{
        id: 'fc-conflict-1',
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.46,
        confidence: 0.55,
        timeHorizon: '7d',
        trend: 'stable',
        signals: [
          { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
        ],
        newsContext: ['Iran military drills intensify after border incident'],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.45 },
        cascades: [],
      }],
    };

    const [candidate] = selectBenchmarkCandidates([newest, prior], { maxCandidates: 5 });
    const entry = toHistoricalBenchmarkEntry(candidate);

    assert.equal(entry.name, candidate.name);
    assert.equal(entry.thresholds.trend, 'rising');
    assert.match(entry.thresholds.changeSummaryIncludes[0], /rose from 46% to 74%/);
    assert.ok(entry.thresholds.overallMin <= entry.thresholds.overallMax);
    assert.ok(entry.thresholds.priorityMin <= entry.thresholds.priorityMax);
    assert.ok(entry.thresholds.changeItemsInclude.some(item => item.includes('New signal: 3 UCDP conflict events')));
  });

  it('merges a promoted historical entry by append or replace', () => {
    const existing = [
      { name: 'red_sea_shipping_disruption_2024_01_15', eventDate: '2024-01-15' },
    ];
    const nextEntry = {
      name: 'iran_exchange_2024_04_14',
      eventDate: '2024-04-14',
      description: 'desc',
      forecast: {},
      thresholds: {},
    };

    const appended = mergeHistoricalBenchmarks(existing, nextEntry);
    assert.equal(appended.length, 2);
    assert.equal(appended[1].name, 'iran_exchange_2024_04_14');

    assert.throws(() => mergeHistoricalBenchmarks(appended, nextEntry), /already exists/);

    const replaced = mergeHistoricalBenchmarks(appended, { ...nextEntry, description: 'updated' }, { replace: true });
    assert.equal(replaced.length, 2);
    assert.equal(replaced[1].description, 'updated');
  });

  it('emits JSON patch previews and unified diffs without writing files', () => {
    const existing = [
      {
        name: 'red_sea_shipping_disruption_2024_01_15',
        eventDate: '2024-01-15',
        description: 'old',
      },
    ];
    const candidate = {
      name: 'iran_exchange_2024_04_14',
      eventDate: '2024-04-14',
      description: 'Iran escalation risk jumps',
      priorForecast: {
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.46,
        confidence: 0.55,
        timeHorizon: '7d',
        signals: [{ type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 }],
      },
      forecast: {
        domain: 'conflict',
        region: 'Iran',
        title: 'Escalation risk: Iran',
        probability: 0.74,
        confidence: 0.64,
        timeHorizon: '7d',
        trend: 'rising',
        signals: [
          { type: 'cii', value: 'Iran CII 79 (high)', weight: 0.4 },
          { type: 'ucdp', value: '3 UCDP conflict events', weight: 0.3 },
        ],
        newsContext: ['Regional officials warn of retaliation risk'],
        calibration: { marketTitle: 'Will Iran conflict escalate before July?', marketPrice: 0.71 },
      },
    };

    const nextEntry = toHistoricalBenchmarkEntry(candidate);
    const patch = createJsonPatch(existing, nextEntry);
    assert.deepEqual(patch[0].op, 'add');
    assert.deepEqual(patch[0].path, '/1');

    const jsonPreview = buildPreviewPayload(
      { format: 'json-patch', output: '/tmp/forecast-historical-benchmark.json', replace: false },
      candidate,
      nextEntry,
      existing,
    );
    assert.equal(jsonPreview.format, 'json-patch');
    assert.equal(jsonPreview.patch[0].op, 'add');

    const diffPreview = buildPreviewPayload(
      { format: 'diff', output: '/tmp/forecast-historical-benchmark.json', replace: false },
      candidate,
      nextEntry,
      existing,
    );
    assert.equal(diffPreview.format, 'diff');
    assert.match(diffPreview.diff, /Escalation risk: Iran/);
    assert.match(diffPreview.diff, /Iran escalation risk jumps/);
  });
});

// ── U3: resolution spec + projections persistence (#4976 Bet 1) ──────────
//
// These exercise the seeder wiring: the enrichment seam (attachResolutionSpecs),
// the makePrediction default, and the camelCase resolution + projections
// blocks in both the canonical payload and the 45-day history entry.

// A conflict forecast reaching the hard path needs a count-bearing signal;
// a commodity market forecast needs an inputs feed with the
// mapped future ticker priced. Kept minimal + console-quiet.
const HARD_CONFLICT_GENERATED_AT = 1_700_000_000_000;

function makeHardConflictPred() {
  return makePrediction('conflict', 'Mali', 'Escalation risk: Mali', 0.62, 0.55, '7d', [
    { type: 'ucdp', value: '14 UCDP conflict events', weight: 0.5 },
  ]);
}

describe('forecast resolution spec round-trip (U3)', () => {
  it('a hard spec survives buildHistoryForecastEntry -> JSON -> parse with camelCase fields intact', () => {
    const pred = makeHardConflictPred();
    pred.projections = { h24: 0.6, d7: 0.64, d30: 0.7 };
    // conflict is judged by default (#5136); force the hard path to exercise hard-spec history round-trip.
    attachResolutionSpecs([pred], {}, HARD_CONFLICT_GENERATED_AT, { conflictCountFeedAvailable: true });
    assert.equal(pred.resolution.kind, 'hard');

    const entry = JSON.parse(JSON.stringify(buildHistoryForecastEntry(pred)));
    assert.equal(entry.resolution.kind, 'hard');
    assert.equal(entry.resolution.metricKey, pred.resolution.metricKey);
    assert.equal(entry.resolution.operator, '>=');
    assert.ok(Number.isFinite(entry.resolution.threshold));
    assert.equal(entry.resolution.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
    assert.equal(entry.resolution.deadline, HARD_CONFLICT_GENERATED_AT + 7 * 24 * 60 * 60 * 1000);
    // camelCase only — no snake_case leaked through the boundary (D6).
    assert.ok(!('metric_key' in entry.resolution));
    assert.ok(!('source_feed' in entry.resolution));
    // proto3-JSON omission: an inapplicable optional field is ABSENT, not null.
    assert.ok(!('question' in entry.resolution));
  });

  it('projections now appear in the history entry and equal the source (#4933 gap)', () => {
    const pred = makeHardConflictPred();
    pred.projections = { h24: 0.61, d7: 0.66, d30: 0.72 };
    const entry = buildHistoryForecastEntry(pred);
    assert.deepEqual(entry.projections, { h24: 0.61, d7: 0.66, d30: 0.72 });
  });

  it('preserves generationOrigin in history entries for scorecard grouping', () => {
    const pred = makeHardConflictPred();
    pred.generationOrigin = 'state_derived';
    const entry = buildHistoryForecastEntry(pred);
    assert.equal(entry.generationOrigin, 'state_derived');

    const legacy = buildHistoryForecastEntry(makeHardConflictPred());
    assert.equal(legacy.generationOrigin, 'legacy_detector');
  });

  it('makePrediction defaults resolution:null and an unspec\'d forecast serializes with NO resolution key', () => {
    const pred = makeHardConflictPred();
    assert.equal(pred.resolution, null);

    // proto3-JSON omission: unset optional message -> absent key on the wire
    // (deliberate divergence from the sibling calibration:null idiom — the
    // generated `resolution?: ResolutionSpec` type is exactly honest this way).
    const historyEntry = JSON.parse(JSON.stringify(buildHistoryForecastEntry(pred)));
    assert.ok(!('resolution' in historyEntry));

    const payload = JSON.parse(JSON.stringify(buildPublishedForecastPayload(pred)));
    assert.ok(!('resolution' in payload));
    // projections default: absent projections -> null in both builders
    // (pre-existing sibling convention, unchanged).
    assert.strictEqual(historyEntry.projections, null);
    assert.strictEqual(payload.projections, null);
  });

  it('canonical payload emits a camelCase resolution object for a spec\'d forecast, omits it otherwise', () => {
    const spec = makeHardConflictPred();
    // conflict is judged by default (#5136); force the hard path for the camelCase resolution round-trip.
    attachResolutionSpecs([spec], {}, HARD_CONFLICT_GENERATED_AT, { conflictCountFeedAvailable: true });
    const payload = buildPublishedForecastPayload(spec);
    assert.equal(payload.resolution.kind, 'hard');
    assert.equal(payload.resolution.metricKey, spec.resolution.metricKey);
    assert.ok(!('metric_key' in payload.resolution));

    const bare = makeHardConflictPred();
    const serialized = JSON.parse(JSON.stringify(buildPublishedForecastPayload(bare)));
    assert.ok(!('resolution' in serialized));
  });

  it('omits (never zeroes) a judged spec\'s numeric fields', () => {
    const pred = makePrediction('political', 'France', 'Government stability: France', 0.4, 0.5, '30d', [
      { type: 'political_signal', value: 'coalition tension', weight: 0.3 },
    ]);
    attachResolutionSpecs([pred], {}, HARD_CONFLICT_GENERATED_AT);
    assert.equal(pred.resolution.kind, 'judged');

    // A judged spec has no threshold — the key must be ABSENT after
    // serialization (never 0, which would read as a hard ">= 0" bar; never
    // null, which the generated `threshold?: number` type does not admit).
    const payload = JSON.parse(JSON.stringify(buildPublishedForecastPayload(pred)));
    assert.ok(!('threshold' in payload.resolution));
    assert.ok(!('baselineValue' in payload.resolution));
    assert.ok(payload.resolution.question && payload.resolution.question.length > 0);
    assert.ok(Number.isFinite(payload.resolution.deadline));
  });
});

describe('forecast resolution seam coverage (U3, R2/D1)', () => {
  it('a state_derived-origin forecast (market_transmission signal) gets a non-null judged spec — origin wins', () => {
    // Production shape: buildStateDerivedForecast attaches a market_transmission
    // signal (weight 0.24) to every state-derived forecast. Origin-precedence
    // must classify it judged despite the hard-mapped market signal.
    const pred = makePrediction('market', 'Global', 'State-derived market stress', 0.5, 0.5, '7d', [
      { type: 'market_transmission', value: 'FX->equities transmission', weight: 0.24 },
    ]);
    pred.generationOrigin = 'state_derived';
    attachResolutionSpecs([pred], {}, HARD_CONFLICT_GENERATED_AT);
    assert.equal(pred.resolution.kind, 'judged');
    assert.ok(pred.resolution.deadline);
  });

  it('a batch with NO state-derived forecasts still has every forecast spec\'d (seam runs after the block closes)', () => {
    const batch = [
      makeHardConflictPred(),
      makePrediction('political', 'France', 'Government stability: France', 0.4, 0.5, '30d', [
        { type: 'political_signal', value: 'coalition tension', weight: 0.3 },
      ]),
    ];
    attachResolutionSpecs(batch, {}, HARD_CONFLICT_GENERATED_AT);
    assert.equal(batch.every((p) => p.resolution && typeof p.resolution.kind === 'string'), true);
  });

  it('R2 coverage over a small mixed batch WITH inputs — 100% spec\'d, hard path reached', () => {
    const conflictPred = makeHardConflictPred();

    const commodityPred = makePrediction('market', 'Middle East', 'Oil price impact: Middle East', 0.55, 0.5, '7d', [
      { type: 'commodity', value: 'Oil sensitivity: 0.8', weight: 0.3 },
    ]);

    const politicalPred = makePrediction('political', 'France', 'Government stability: France', 0.4, 0.5, '30d', [
      { type: 'political_signal', value: 'coalition tension', weight: 0.3 },
    ]);

    const stateDerivedPred = makePrediction('market', 'Global', 'State-derived market stress', 0.5, 0.5, '7d', [
      { type: 'market_transmission', value: 'FX->equities transmission', weight: 0.24 },
    ]);
    stateDerivedPred.generationOrigin = 'state_derived';

    // The builder needs feed data for the commodity hard path: the module reads
    // inputs.commodityQuotes and matches by future ticker (Oil -> CL=F).
    const inputs = {
      commodityQuotes: { quotes: [{ symbol: 'CL=F', name: 'WTI Crude', price: 78.5 }] },
    };

    const batch = [conflictPred, commodityPred, politicalPred, stateDerivedPred];
    // conflict is judged by default (#5136); force its hard path so this mixed batch still exercises hard+judged.
    attachResolutionSpecs(batch, inputs, HARD_CONFLICT_GENERATED_AT, { conflictCountFeedAvailable: true });

    // 100% coverage (R2): every forecast carries a non-null spec.
    assert.equal(batch.every((p) => p.resolution != null), true);
    // Both kinds present: conflict + commodity hard, political + state-derived judged.
    assert.equal(conflictPred.resolution.kind, 'hard');
    assert.equal(commodityPred.resolution.kind, 'hard');
    assert.equal(commodityPred.resolution.sourceFeed, 'market:commodities-bootstrap:v1');
    assert.equal(commodityPred.resolution.operator, 'crosses');
    assert.ok(Number.isFinite(commodityPred.resolution.baselineValue));
    assert.equal(politicalPred.resolution.kind, 'judged');
    assert.equal(stateDerivedPred.resolution.kind, 'judged');

    const hardCount = batch.filter((p) => p.resolution.kind === 'hard').length;
    assert.equal(hardCount, 2);
  });
});
