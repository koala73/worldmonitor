import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  makePrediction,
  buildHistorySnapshot,
  buildForecastCase,
} from '../scripts/seed-forecasts.mjs';

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
