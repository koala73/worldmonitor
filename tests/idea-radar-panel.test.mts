import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adaptCalibrationAdjustment,
  buildIdeaRadarBeginnerSummary,
  buildIdeaRadarDailyChecklist,
  buildIdeaRadarPriorityBuckets,
  buildIdeaRadarPriorityBucketsWithCalibration,
  buildIdeaRadarRegimeHeadline,
  buildIdeaRadarRegimeSummary,
  buildCalibrationAdjustment,
  buildCalibrationRecommendation,
  classifyOutcomeStatus,
  describeCalibrationTrend,
  describeSnapshotComparison,
  getIdeaRadarPriorityGroup,
  getOutcomeComparisonWindowForHorizon,
  getOutcomeThresholdsForHorizon,
  summarizeResolvedOutcomes,
} from '../src/services/idea-radar-outcomes.ts';
import { buildIdeaRadarViewModel, type IdeaCandidate } from '../src/services/idea-discovery.ts';
import { readFileSync } from 'node:fs';

const ideaRadarPanelSource = readFileSync(new URL('../src/components/IdeaRadarPanel.ts', import.meta.url), 'utf8');
(globalThis as { document?: { documentElement?: { lang?: string } } }).document = {
  documentElement: { lang: 'ja' },
};

describe('idea radar panel outcome thresholds', () => {
  it('uses tighter thresholds for short horizons and wider thresholds for swing horizons', () => {
    assert.deepEqual(getOutcomeThresholdsForHorizon('10m'), { positivePct: 0.25, negativePct: -0.25 });
    assert.deepEqual(getOutcomeThresholdsForHorizon('1h'), { positivePct: 0.6, negativePct: -0.6 });
    assert.deepEqual(getOutcomeThresholdsForHorizon('1d'), { positivePct: 1.5, negativePct: -1.5 });
    assert.deepEqual(getOutcomeThresholdsForHorizon('1w'), { positivePct: 3, negativePct: -3 });
    assert.deepEqual(getOutcomeComparisonWindowForHorizon('10m'), { recentDays: 7, priorDays: 21 });
    assert.deepEqual(getOutcomeComparisonWindowForHorizon('1d'), { recentDays: 21, priorDays: 60 });
    assert.deepEqual(getOutcomeComparisonWindowForHorizon('1w'), { recentDays: 45, priorDays: 120 });
  });

  it('classifies resolved outcomes by horizon-aware thresholds', () => {
    assert.equal(classifyOutcomeStatus(0.3, true, '10m'), 'positive');
    assert.equal(classifyOutcomeStatus(0.3, true, '1w'), 'flat');
    assert.equal(classifyOutcomeStatus(-0.7, true, '1h'), 'negative');
    assert.equal(classifyOutcomeStatus(-0.7, true, '1d'), 'flat');
    assert.equal(classifyOutcomeStatus(null, true, '1d'), 'stale');
    assert.equal(classifyOutcomeStatus(1.2, false, '1d'), 'pending');
  });

  it('builds recalibration recommendations from resolved snapshots', () => {
    const weak = summarizeResolvedOutcomes([
      { latestReturnPct: -1.2, outcomeStatus: 'negative' },
      { latestReturnPct: 0.1, outcomeStatus: 'flat' },
      { latestReturnPct: 0.4, outcomeStatus: 'positive' },
    ], '1d');
    const strong = summarizeResolvedOutcomes([
      { latestReturnPct: 2.1, outcomeStatus: 'positive' },
      { latestReturnPct: 1.4, outcomeStatus: 'positive' },
      { latestReturnPct: 0.9, outcomeStatus: 'positive' },
    ], 'research');

    assert.equal(buildCalibrationRecommendation(weak!, 'horizon'), '引き締め 1d (1/3, 平均 -0.2%)');
    assert.equal(buildCalibrationRecommendation(strong!, 'stance'), '引き上げ research (3/3, 平均 1.5%)');
    assert.deepEqual(buildCalibrationAdjustment(weak!, 'horizon'), {
      key: '1d',
      scoreDelta: -3,
      thresholdShift: 1,
      message: 'weak 1d outcomes (33.3% / -0.2%)',
      confidence: 'low',
      severity: 'medium',
      hitRate: 33.3,
      avgReturn: -0.2,
      sampleCount: 3,
    });
    assert.deepEqual(buildCalibrationAdjustment(strong!, 'stance'), {
      key: 'research',
      scoreDelta: 1,
      thresholdShift: -1,
      message: 'strong research stance outcomes (100% / 1.5%)',
      confidence: 'low',
      severity: 'medium',
      hitRate: 100,
      avgReturn: 1.5,
      sampleCount: 3,
    });
  });

  it('raises confidence and stronger shifts when the sample is deep and severe', () => {
    const severe = summarizeResolvedOutcomes([
      { latestReturnPct: -2.1, outcomeStatus: 'negative' },
      { latestReturnPct: -1.9, outcomeStatus: 'negative' },
      { latestReturnPct: -1.4, outcomeStatus: 'negative' },
      { latestReturnPct: -0.8, outcomeStatus: 'negative' },
      { latestReturnPct: -1.1, outcomeStatus: 'negative' },
      { latestReturnPct: -1.3, outcomeStatus: 'negative' },
      { latestReturnPct: -0.9, outcomeStatus: 'negative' },
      { latestReturnPct: 0.2, outcomeStatus: 'flat' },
    ], '10m');
    const adjustment = buildCalibrationAdjustment(severe!, 'horizon');

    assert.deepEqual(adjustment, {
      key: '10m',
      scoreDelta: -5,
      thresholdShift: 2,
      message: 'weak 10m outcomes (0% / -1.2%)',
      confidence: 'high',
      severity: 'strong',
      hitRate: 0,
      avgReturn: -1.2,
      sampleCount: 8,
    });
  });

  it('adapts current calibration against prior history and describes the drift', () => {
    const previous = {
      key: '10m',
      scoreDelta: -4,
      thresholdShift: 1,
      message: 'weak 10m outcomes (20% / -0.9%)',
      confidence: 'medium' as const,
      severity: 'medium' as const,
      hitRate: 20,
      avgReturn: -0.9,
      sampleCount: 5,
    };
    const current = {
      key: '10m',
      scoreDelta: -5,
      thresholdShift: 2,
      message: 'weak 10m outcomes (0% / -1.2%)',
      confidence: 'high' as const,
      severity: 'strong' as const,
      hitRate: 0,
      avgReturn: -1.2,
      sampleCount: 8,
    };

    const adapted = adaptCalibrationAdjustment(current, previous);
    assert.deepEqual(adapted, {
      ...current,
      scoreDelta: -7,
      thresholdShift: 2,
      message: 'weak 10m outcomes (0% / -1.2%) · persistent',
    });
    assert.equal(
      describeCalibrationTrend(adapted, previous),
      '10m now -7 / stance +2 vs prior -4 / +1 · drift -3/+1',
    );
  });

  it('softens a reversal more when the prior adjustment had high confidence', () => {
    const previous = {
      key: '1w',
      scoreDelta: -4,
      thresholdShift: 2,
      message: 'weak 1w outcomes (20% / -1.4%)',
      confidence: 'high' as const,
      severity: 'strong' as const,
      hitRate: 20,
      avgReturn: -1.4,
      sampleCount: 10,
    };
    const current = {
      key: '1w',
      scoreDelta: 3,
      thresholdShift: -1,
      message: 'strong 1w outcomes (80% / 1.2%)',
      confidence: 'medium' as const,
      severity: 'medium' as const,
      hitRate: 80,
      avgReturn: 1.2,
      sampleCount: 5,
    };

    assert.deepEqual(adaptCalibrationAdjustment(current, previous), {
      ...current,
      scoreDelta: 1,
      thresholdShift: 1,
      message: 'strong 1w outcomes (80% / 1.2%) · reversing',
    });
  });

  it('describes recent vs prior resolved snapshots', () => {
    const recent = summarizeResolvedOutcomes([
      { latestReturnPct: 1.1, outcomeStatus: 'positive' },
      { latestReturnPct: 0.4, outcomeStatus: 'flat' },
      { latestReturnPct: -0.2, outcomeStatus: 'flat' },
    ], '1h');
    const prior = summarizeResolvedOutcomes([
      { latestReturnPct: -0.6, outcomeStatus: 'negative' },
      { latestReturnPct: 0.3, outcomeStatus: 'flat' },
      { latestReturnPct: 0.8, outcomeStatus: 'positive' },
    ], '1h');

    assert.equal(
      describeSnapshotComparison(recent!, prior),
      '1h recent 1/3 avg 0.4% vs prior 1/3 avg 0.2%',
    );
  });

  it('builds a daily checklist from current candidates and calibration flags', () => {
    const candidates = [
      { symbol: 'AVGO', horizon: '1d', stance: 'research', score: 82 },
      { symbol: 'BTC', horizon: '1h', stance: 'watch', score: 71 },
    ] as unknown as IdeaCandidate[];
    const checklist = buildIdeaRadarDailyChecklist(
      candidates,
      {
        calibrationFlags: ['引き締め 1d (1/3, 平均 -0.2%)'],
        coefficientSuggestions: ['引き上げ research (3/3, 平均 1.5%)'],
      },
    );

    assert.equal(checklist[0], '1d -> 1w -> 1h -> 10m の順で見る。');
    assert.equal(checklist[1], '最初は AVGO 1d research を確認する。');
    assert.equal(checklist[2], '短期は BTC 1h を最後に補助確認する。');
  });

  it('builds a beginner summary that points to swing first and short-term last', () => {
    const candidates = [
      { symbol: 'AVGO', horizon: '1d', stance: 'research', score: 82 },
      { symbol: 'ETH', horizon: '1w', stance: 'watch', score: 77 },
      { symbol: 'BTC', horizon: '10m', stance: 'watch', score: 68 },
    ] as unknown as IdeaCandidate[];
    const summary = buildIdeaRadarBeginnerSummary(
      candidates,
      {
        calibrationFlags: ['引き締め 1d (1/3, 平均 -0.2%)'],
        stanceOutcomes: ['research 3/4 平均 1.1%'],
      } as any,
    );

    assert.equal(summary[0], 'この面は「今の候補」と「最近その選び方が当たっているか」を一緒に見るためのもの。');
    assert.equal(summary[1], 'まず AVGO 1d research を見る。 score 82。');
    assert.equal(summary[3], 'BTC 10m は短期補助。単独では信用しすぎない。');
  });

  it('groups candidates into main, tactical, and avoid buckets', () => {
    const candidates = [
      { symbol: 'AVGO', horizon: '1d', stance: 'research', score: 82 },
      { symbol: 'ETH', horizon: '1w', stance: 'watch', score: 77 },
      { symbol: 'BTC', horizon: '1h', stance: 'watch', score: 68 },
      { symbol: 'PLTR', horizon: '10m', stance: 'starter-size only', score: 55 },
      { symbol: 'TSLA', horizon: '1d', stance: 'avoid', score: 33 },
    ] as unknown as IdeaCandidate[];
    const buckets = buildIdeaRadarPriorityBuckets(candidates);

    assert.deepEqual(buckets.main.map((item) => item.symbol), ['AVGO', 'ETH']);
    assert.deepEqual(buckets.tactical.map((item) => item.symbol), ['BTC', 'PLTR']);
    assert.deepEqual(buckets.avoid.map((item) => item.symbol), ['TSLA', 'PLTR']);
  });

  it('reorders main buckets with calibration deltas', () => {
    const candidates = [
      { symbol: 'AVGO', horizon: '1d', stance: 'research', score: 82 },
      { symbol: 'ETH', horizon: '1w', stance: 'watch', score: 77, themeStrength: { label: 'Confirmed', score: 71 } },
    ] as unknown as IdeaCandidate[];
    const buckets = buildIdeaRadarPriorityBucketsWithCalibration(candidates, {
      horizonScoreDelta: { '1d': -4, '1w': 3 },
      stanceScoreDelta: { research: 0, watch: 0 },
      horizonAdjustments: {
        '1d': {
          key: '1d',
          scoreDelta: -4,
          thresholdShift: 1,
          message: 'weak 1d outcomes (33.3% / -0.2%)',
          confidence: 'high',
          severity: 'medium',
          hitRate: 33.3,
          avgReturn: -0.2,
          sampleCount: 8,
        },
        '1w': {
          key: '1w',
          scoreDelta: 3,
          thresholdShift: -1,
          message: 'strong 1w outcomes (75% / 1.1%)',
          confidence: 'high',
          severity: 'medium',
          hitRate: 75,
          avgReturn: 1.1,
          sampleCount: 9,
        },
      },
    });

    assert.deepEqual(buckets.main.map((item) => item.symbol), ['ETH', 'AVGO']);
  });

  it('builds a regime summary from dominant mix labels and outcome balance', () => {
    const candidates = [
      {
        symbol: 'AVGO',
        horizon: '1d',
        stance: 'research',
        score: 82,
        scoreMix: [{ label: 'Flow', pct: 41 }, { label: 'Breadth', pct: 27 }],
        themeStrength: { label: 'Confirmed', score: 74 },
        orderFlowRegime: { label: 'Strong', score: 72 },
      },
      {
        symbol: 'ETH',
        horizon: '1w',
        stance: 'watch',
        score: 77,
        scoreMix: [{ label: 'Flow', pct: 35 }, { label: 'Peer', pct: 28 }],
        themeStrength: { label: 'Confirmed', score: 71 },
        shortTermConfirmation: { label: 'Building', score: 62 },
      },
    ] as unknown as IdeaCandidate[];
    const summary = buildIdeaRadarRegimeSummary(candidates, {
      calibrationFlags: ['引き締め 1d (1/3, 平均 -0.2%)'],
      positiveCount: 4,
      negativeCount: 1,
    });

    assert.equal(summary[0], '市場環境 前向き · フロー + 同業比較。');
    assert.equal(summary[1], '主軸 AVGO 1d / ETH 1w。');
    assert.equal(summary[2], '短期は安定 · 補正 引き締め 1d。');
    assert.equal(
      buildIdeaRadarRegimeHeadline(candidates, {
        calibrationFlags: ['引き締め 1d (1/3, 平均 -0.2%)'],
        positiveCount: 4,
        negativeCount: 1,
      }),
      '前向き · フロー + 同業比較 | 安定 · 補正 引き締め 1d.',
    );
  });

  it('classifies priority groups for candidate cards', () => {
    assert.equal(getIdeaRadarPriorityGroup({ symbol: 'AVGO', horizon: '1d', stance: 'research', score: 82 }), 'MAIN');
    assert.equal(getIdeaRadarPriorityGroup({ symbol: 'BTC', horizon: '1h', stance: 'watch', score: 69 }), 'TACTICAL');
    assert.equal(getIdeaRadarPriorityGroup({ symbol: 'TSLA', horizon: '1d', stance: 'avoid', score: 31 }), 'AVOID');
  });

  it('wraps slow idea-radar dependencies with timeouts so the panel can partially render', () => {
    assert.match(ideaRadarPanelSource, /private async withTimeout<T>\(promise: Promise<T>, fallback: T, timeoutMs = 8000\): Promise<T>/);
    assert.match(ideaRadarPanelSource, /this\.withTimeout\(fetchPersonalPortfolioExport\('risk'/);
    assert.match(ideaRadarPanelSource, /this\.withTimeout\(this\.marketClient\.getHyperliquidFlow\(\{\}\)\.catch\(\(\) => null\), null\)/);
    assert.match(ideaRadarPanelSource, /this\.withTimeout\(fetchStockAnalysesForTargets\(stockAnalysisTargets\)\.catch\(\(\) => \[\]\), \[\]\)/);
  });

  it('compacts unavailable overlays into a single summary note', () => {
    const model = buildIdeaRadarViewModel({
      markets: [],
      predictions: [],
      portfolio: null,
      implications: null,
      watchlistSymbols: [],
    });

    assert.equal(model.notes.filter((note) => note.includes('オーバーレイは利用できません')).length, 0);
    assert.ok(model.notes.some((note) => note.startsWith('補助オーバーレイ未接続: ')));
    assert.ok(model.notes.includes('監視銘柄: 未設定。'));
    assert.ok(model.notes.includes('個人ルール: 現在警戒なし。'));
  });

  it('renders a structured empty state instead of a single fallback line', () => {
    assert.match(ideaRadarPanelSource, /private renderEmptyState\(/);
    assert.match(ideaRadarPanelSource, /候補状況/);
    assert.match(ideaRadarPanelSource, /現時点では主軸候補はまだ形成されていません/);
    assert.match(ideaRadarPanelSource, /renderSessionFocusSection\(viewModel, evaluationSummary\)/);
    assert.match(ideaRadarPanelSource, /renderPlaybookSection\(viewModel, evaluationSummary\)/);
    assert.match(ideaRadarPanelSource, /renderPriorityMapSection\(viewModel, evaluationSummary\)/);
  });
});
