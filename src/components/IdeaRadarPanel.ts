import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import { t } from '@/services/i18n';
import { isJapaneseLocale } from '@/utils/locale';
import type { MarketData, NewsItem } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
import { fetchMarketImplications } from '@/services/market-implications';
import {
  fetchIdeaRadarEvaluationLog,
  fetchIdeaRadarReviewHistory,
  fetchPersonalPortfolioExport,
  fetchPersonalPortfolioTargets,
  persistIdeaRadarEvaluationLog,
  persistIdeaRadarReviewHistory,
  type IdeaRadarEvaluationLogEntry,
  type PersonalPortfolioExport,
} from '@/services/personal-portfolio';
import {
  adaptCalibrationAdjustment,
  buildIdeaRadarBeginnerSummary,
  buildIdeaRadarDailyChecklist,
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
} from '@/services/idea-radar-outcomes';
import { buildIdeaRadarViewModel, type IdeaCandidate, type IdeaRadarViewModel } from '@/services/idea-discovery';
import { getMarketWatchlistEntries } from '@/services/market-watchlist';
import { fetchStoredStockBacktests } from '@/services/stock-backtest';
import { fetchStockAnalysesForTargets } from '@/services/stock-analysis';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';

interface IdeaRadarPanelOptions {
  getMarkets: () => MarketData[];
  getPredictions: () => PredictionMarket[];
  getNews: () => NewsItem[];
}

interface EvaluationLogSummary {
  totalEntries: number;
  recentEntries: number;
  recentCandidateCount: number;
  averageScore: number | null;
  resolvedCount: number;
  positiveCount: number;
  negativeCount: number;
  horizonAverages: string[];
  stanceMix: string[];
  driftLeaders: string[];
  maturedOutcomes: string[];
  calibrationFlags: string[];
  topResolvedIdeas: string[];
  weakResolvedIdeas: string[];
  horizonThresholds: string[];
  stanceOutcomes: string[];
  coefficientSuggestions: string[];
  horizonAdjustments: Array<NonNullable<ReturnType<typeof buildCalibrationAdjustment>>>;
  stanceAdjustments: Array<NonNullable<ReturnType<typeof buildCalibrationAdjustment>>>;
  horizonOverlayDetails: string[];
  stanceOverlayDetails: string[];
  horizonComparisons: string[];
  stanceComparisons: string[];
  horizonOverlayHistory: string[];
  stanceOverlayHistory: string[];
  comparisonWindows: string[];
}

export class IdeaRadarPanel extends Panel {
  private static readonly HORIZON_CANDIDATE_LIMIT = 3;
  private static readonly MOBILE_PLAYBOOK_LIMIT = 1;
  private static readonly MOBILE_BEGINNER_SUMMARY_LIMIT = 1;
  private static readonly PLAYBOOK_STORAGE_KEY = 'idea-radar-playbook-expanded';
  private readonly getMarkets: () => MarketData[];
  private readonly getPredictions: () => PredictionMarket[];
  private readonly getNews: () => NewsItem[];
  private loading = true;
  private viewModel: IdeaRadarViewModel | null = null;
  private evaluationSummary: EvaluationLogSummary | null = null;
  private playbookExpanded = this.loadPlaybookExpanded();
  private readonly marketClient = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  private readonly economicClient = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

  constructor(options: IdeaRadarPanelOptions) {
    super({
      id: 'idea-radar',
      title: t('panels.ideaRadar') || 'Idea Radar',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip: 'Surfaces non-held stock and crypto ideas from market momentum, prediction markets, and market implications.',
    });
    this.getMarkets = options.getMarkets;
    this.getPredictions = options.getPredictions;
    this.getNews = options.getNews;
    this.showLoading();
    void this.refresh();
  }

  private buildUnavailableViewModel(message: string): IdeaRadarViewModel {
    const localizedMessage = this.isJapanese() && message === 'Idea radar is temporarily unavailable. Core finance panels continue loading.'
      ? 'アイデアレーダーは一時的に利用できません。主要な金融パネルの読み込みは継続しています。'
      : message;
    return {
      generatedAt: new Date().toISOString(),
      candidates: [],
      candidatesByHorizon: {
        '10m': [],
        '1h': [],
        '1d': [],
        '1w': [],
      },
      notes: [localizedMessage],
    };
  }

  private async withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs = 8000): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private buildEvaluationLogEntries(viewModel: IdeaRadarViewModel): IdeaRadarEvaluationLogEntry[] {
    const loggedAt = new Date().toISOString();
    return viewModel.candidates.map((candidate) => ({
      loggedAt,
      generatedAt: viewModel.generatedAt,
      symbol: candidate.symbol,
      name: candidate.name,
      assetType: candidate.assetType,
      horizon: candidate.horizon,
      stance: candidate.stance,
      score: candidate.score,
      themeStrength: candidate.themeStrength ? { score: candidate.themeStrength.score, label: candidate.themeStrength.label } : null,
      shortTermConfirmation: candidate.shortTermConfirmation ? { score: candidate.shortTermConfirmation.score, label: candidate.shortTermConfirmation.label } : null,
      orderFlowRegime: candidate.orderFlowRegime ? { score: candidate.orderFlowRegime.score, label: candidate.orderFlowRegime.label } : null,
      backtestConsistency: candidate.backtestConsistency ? {
        winRate: candidate.backtestConsistency.winRate,
        actionableSignals: candidate.backtestConsistency.actionableSignals,
      } : null,
      scoreMix: candidate.scoreMix,
      stanceReason: candidate.stanceReason,
      shiftSummary: [
        candidate.shortTermConfirmation?.basisChange ? `Short ${candidate.shortTermConfirmation.basisChange}` : null,
        candidate.themeStrength.basisChange ? `Theme ${candidate.themeStrength.basisChange}` : null,
      ].filter(Boolean).join(' / '),
      priceAtLog: this.getMarkets().find((market) => market.symbol.toUpperCase() === candidate.symbol.toUpperCase())?.price ?? null,
      latestPrice: null,
      latestReturnPct: null,
      outcomeStatus: 'pending',
      evaluatedAt: null,
    }));
  }

  private getHorizonDurationMs(horizon: IdeaRadarEvaluationLogEntry['horizon']): number {
    switch (horizon) {
      case '10m':
        return 10 * 60_000;
      case '1h':
        return 60 * 60_000;
      case '1d':
        return 24 * 60 * 60_000;
      case '1w':
      default:
        return 7 * 24 * 60 * 60_000;
    }
  }

  private hydrateEvaluationOutcome(
    entries: IdeaRadarEvaluationLogEntry[],
    markets: MarketData[],
  ): IdeaRadarEvaluationLogEntry[] {
    const now = Date.now();
    const marketMap = new Map(markets.map((market) => [market.symbol.toUpperCase(), market]));
    return entries.map((entry) => {
      const market = marketMap.get(entry.symbol.toUpperCase());
      const priceAtLog = entry.priceAtLog ?? null;
      const latestPrice = market?.price ?? entry.latestPrice ?? null;
      const loggedAtMs = Date.parse(entry.generatedAt || entry.loggedAt || '');
      const due = Number.isFinite(loggedAtMs) ? (now - loggedAtMs) >= this.getHorizonDurationMs(entry.horizon) : false;
      const latestReturnPct = priceAtLog && latestPrice
        ? Math.round((((latestPrice - priceAtLog) / priceAtLog) * 100) * 10) / 10
        : null;
      return {
        ...entry,
        latestPrice,
        latestReturnPct,
        outcomeStatus: classifyOutcomeStatus(latestReturnPct, due, entry.horizon),
        evaluatedAt: latestPrice != null ? new Date().toISOString() : entry.evaluatedAt ?? null,
      };
    });
  }

  private mergeEvaluationLogEntries(
    existingEntries: IdeaRadarEvaluationLogEntry[],
    nextEntries: IdeaRadarEvaluationLogEntry[],
  ): IdeaRadarEvaluationLogEntry[] {
    const deduped = new Map<string, IdeaRadarEvaluationLogEntry>();
    [...existingEntries, ...nextEntries].forEach((entry) => {
      const key = [
        entry.symbol,
        entry.horizon,
        entry.generatedAt || entry.loggedAt,
      ].join('|');
      deduped.set(key, entry);
    });
    return [...deduped.values()]
      .sort((left, right) => {
        const leftStamp = `${left.generatedAt || ''}|${left.loggedAt || ''}|${left.symbol}`;
        const rightStamp = `${right.generatedAt || ''}|${right.loggedAt || ''}|${right.symbol}`;
        return leftStamp.localeCompare(rightStamp);
      })
      .slice(-500);
  }

  private shiftStance(
    stance: IdeaCandidate['stance'],
    direction: number,
  ): IdeaCandidate['stance'] {
    const order: IdeaCandidate['stance'][] = ['avoid', 'starter-size only', 'watch', 'research'];
    const index = order.indexOf(stance);
    if (index === -1 || direction === 0) return stance;
    const nextIndex = Math.min(order.length - 1, Math.max(0, index + direction));
    return order[nextIndex] ?? stance;
  }

  private applyCalibrationProfile(
    viewModel: IdeaRadarViewModel,
    summary: EvaluationLogSummary | null,
  ): IdeaRadarViewModel {
    if (!summary) return viewModel;
    const horizonAdjustmentMap = new Map(
      summary.horizonAdjustments.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.key, item]),
    );
    const stanceAdjustmentMap = new Map(
      summary.stanceAdjustments.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.key, item]),
    );
    const candidates = viewModel.candidates.map((candidate) => {
      const horizonAdjustment = horizonAdjustmentMap.get(candidate.horizon);
      const stanceAdjustment = stanceAdjustmentMap.get(candidate.stance);
      const totalDelta = (horizonAdjustment?.scoreDelta ?? 0) + (stanceAdjustment?.scoreDelta ?? 0);
      const adjustedScore = Math.max(0, Math.min(100, candidate.score + totalDelta));
      const thresholdShift = (horizonAdjustment?.thresholdShift ?? 0) + (stanceAdjustment?.thresholdShift ?? 0);
      const extraConservatism =
        thresholdShift > 0 && ['10m', '1h'].includes(candidate.horizon)
          && candidate.shortTermConfirmation?.label === 'Thin'
          ? 1
          : 0;
      const extraConviction =
        thresholdShift < 0 && candidate.horizon === '1w'
          && candidate.themeStrength.label === 'Confirmed'
          ? 1
          : 0;
      const stanceDirection = thresholdShift > 0
        ? -Math.min(2, thresholdShift + extraConservatism)
        : thresholdShift < 0
          ? Math.min(2, Math.abs(thresholdShift) + extraConviction)
          : 0;
      const adjustedStance = totalDelta !== 0 || stanceDirection !== 0
        ? this.shiftStance(candidate.stance, stanceDirection)
        : candidate.stance;
      const calibrationMessages = [
        horizonAdjustment ? `${horizonAdjustment.message} [${horizonAdjustment.confidence}, n=${horizonAdjustment.sampleCount}]` : null,
        stanceAdjustment ? `${stanceAdjustment.message} [${stanceAdjustment.confidence}, n=${stanceAdjustment.sampleCount}]` : null,
      ].filter(Boolean);
      return {
        ...candidate,
        score: adjustedScore,
        stance: adjustedStance,
        stanceReason: calibrationMessages.length
          ? `${candidate.stanceReason ?? ''}${candidate.stanceReason ? ' / ' : ''}calibration ${calibrationMessages.join(' + ')}`
          : candidate.stanceReason,
        drivers: calibrationMessages.length
          ? [`Calibration overlay: ${calibrationMessages.join(' + ')}`, ...candidate.drivers]
          : candidate.drivers,
      };
    }).sort((left, right) => {
      const rank = (candidate: IdeaCandidate): number => {
        if (['1d', '1w'].includes(candidate.horizon) && ['research', 'watch'].includes(candidate.stance)) return 3;
        if (['10m', '1h'].includes(candidate.horizon) && candidate.stance !== 'avoid') return 2;
        if (candidate.stance === 'starter-size only') return 1;
        return 0;
      };
      const rankGap = rank(right) - rank(left);
      return rankGap !== 0 ? rankGap : right.score - left.score;
    });
    const candidatesByHorizon: IdeaRadarViewModel['candidatesByHorizon'] = {
      '10m': candidates.filter((candidate) => candidate.horizon === '10m'),
      '1h': candidates.filter((candidate) => candidate.horizon === '1h'),
      '1d': candidates.filter((candidate) => candidate.horizon === '1d'),
      '1w': candidates.filter((candidate) => candidate.horizon === '1w'),
    };
    return { ...viewModel, candidates, candidatesByHorizon };
  }

  private buildEvaluationLogSummary(entries: IdeaRadarEvaluationLogEntry[]): EvaluationLogSummary | null {
    if (entries.length === 0) return null;
    const now = Date.now();
    const recentEntries = entries.filter((entry) => {
      const stamp = Date.parse(entry.generatedAt || entry.loggedAt || '');
      return Number.isFinite(stamp) && now - stamp <= 7 * 86_400_000;
    });
    const activeEntries = recentEntries.length > 0 ? recentEntries : entries.slice(-120);
    const latestPerCandidate = new Map<string, IdeaRadarEvaluationLogEntry>();
    const previousPerCandidate = new Map<string, IdeaRadarEvaluationLogEntry>();
    activeEntries.forEach((entry) => {
      const key = `${entry.symbol}:${entry.horizon}`;
      const current = latestPerCandidate.get(key);
      if (!current) {
        latestPerCandidate.set(key, entry);
        return;
      }
      const currentStamp = Date.parse(current.generatedAt || current.loggedAt || '') || 0;
      const nextStamp = Date.parse(entry.generatedAt || entry.loggedAt || '') || 0;
      if (nextStamp >= currentStamp) {
        previousPerCandidate.set(key, current);
        latestPerCandidate.set(key, entry);
      } else if (!previousPerCandidate.has(key)) {
        previousPerCandidate.set(key, entry);
      }
    });
    const latestEntries = [...latestPerCandidate.values()];
    const totalScore = latestEntries.reduce((sum, entry) => sum + (entry.score || 0), 0);
    const horizonOrder: Array<'10m' | '1h' | '1d' | '1w'> = ['10m', '1h', '1d', '1w'];
    const horizonAverages = horizonOrder
      .map((horizon) => {
        const subset = latestEntries.filter((entry) => entry.horizon === horizon);
        if (subset.length === 0) return null;
        const avg = Math.round(subset.reduce((sum, entry) => sum + (entry.score || 0), 0) / subset.length);
        return `${horizon} ${avg}`;
      })
      .filter((value): value is string => Boolean(value));
    const stanceOrder: Array<IdeaRadarEvaluationLogEntry['stance']> = ['research', 'watch', 'starter-size only', 'avoid'];
    const stanceMix = stanceOrder
      .map((stance) => {
        const count = latestEntries.filter((entry) => entry.stance === stance).length;
        return count > 0 ? `${stance} ${count}` : null;
      })
      .filter((value): value is string => Boolean(value));
    const driftLeaders = [...latestPerCandidate.entries()]
      .map(([key, latest]) => {
        const previous = previousPerCandidate.get(key);
        const themeDelta = latest.themeStrength && previous?.themeStrength
          ? latest.themeStrength.score - previous.themeStrength.score
          : 0;
        const shortDelta = latest.shortTermConfirmation && previous?.shortTermConfirmation
          ? latest.shortTermConfirmation.score - previous.shortTermConfirmation.score
          : 0;
        const flowDelta = latest.orderFlowRegime && previous?.orderFlowRegime
          ? latest.orderFlowRegime.score - previous.orderFlowRegime.score
          : 0;
        const totalDelta = themeDelta + shortDelta + flowDelta;
        return {
          symbol: latest.symbol,
          horizon: latest.horizon,
          totalDelta,
          summary: [
            themeDelta ? `theme ${themeDelta >= 0 ? '+' : ''}${themeDelta}` : null,
            shortDelta ? `short ${shortDelta >= 0 ? '+' : ''}${shortDelta}` : null,
            flowDelta ? `flow ${flowDelta >= 0 ? '+' : ''}${flowDelta}` : null,
          ].filter(Boolean).join(' · '),
        };
      })
      .filter((item) => item.totalDelta !== 0 && item.summary)
      .sort((left, right) => Math.abs(right.totalDelta) - Math.abs(left.totalDelta))
      .slice(0, 3)
      .map((item) => `${item.symbol} ${item.horizon} ${item.summary}`);
    const matured = entries.filter((entry) => ['positive', 'negative', 'flat'].includes(entry.outcomeStatus ?? ''));
    const stanceRecentWindowMs = 30 * 86_400_000;
    const stancePriorWindowMs = 90 * 86_400_000;
    const recentMatured = matured.filter((entry) => {
      const stamp = Date.parse(entry.evaluatedAt || entry.generatedAt || entry.loggedAt || '');
      return Number.isFinite(stamp) && now - stamp <= stanceRecentWindowMs;
    });
    const priorMatured = matured.filter((entry) => {
      const stamp = Date.parse(entry.evaluatedAt || entry.generatedAt || entry.loggedAt || '');
      return Number.isFinite(stamp) && now - stamp > stanceRecentWindowMs && now - stamp <= stancePriorWindowMs;
    });
    const positiveCount = matured.filter((entry) => entry.outcomeStatus === 'positive').length;
    const negativeCount = matured.filter((entry) => entry.outcomeStatus === 'negative').length;
    const horizonThresholds = horizonOrder.map((horizon) => {
      const thresholds = getOutcomeThresholdsForHorizon(horizon);
      return `${horizon} +${thresholds.positivePct}% / ${thresholds.negativePct}%`;
    });
    const horizonStats = horizonOrder.map((horizon) => {
      const subset = matured.filter((entry) => entry.horizon === horizon);
      const positives = subset.filter((entry) => entry.outcomeStatus === 'positive').length;
      const negatives = subset.filter((entry) => entry.outcomeStatus === 'negative').length;
      const avgReturn = subset.length > 0
        ? Math.round((subset.reduce((sum, entry) => sum + (entry.latestReturnPct ?? 0), 0) / subset.length) * 10) / 10
        : 0;
      return { horizon, total: subset.length, positives, negatives, avgReturn };
    });
    const maturedOutcomes = horizonOrder
      .map((horizon) => {
        const stats = horizonStats.find((item) => item.horizon === horizon);
        if (!stats || stats.total === 0) return null;
        return `${horizon} hit ${stats.positives}/${stats.total} avg ${stats.avgReturn}%${stats.negatives > 0 ? ` neg ${stats.negatives}` : ''}`;
      })
      .filter((value): value is string => Boolean(value));
    const comparisonWindows = horizonOrder.map((horizon) => {
      const window = getOutcomeComparisonWindowForHorizon(horizon);
      return `${horizon} recent ${window.recentDays}d / prior ${window.priorDays}d`;
    });
    const currentHorizonSnapshots = horizonOrder
      .map((horizon) => {
        const window = getOutcomeComparisonWindowForHorizon(horizon);
        const recentMs = window.recentDays * 86_400_000;
        const subset = matured.filter((entry) => {
          if (entry.horizon !== horizon) return false;
          const stamp = Date.parse(entry.evaluatedAt || entry.generatedAt || entry.loggedAt || '');
          return Number.isFinite(stamp) && now - stamp <= recentMs;
        });
        const fallback = subset.length >= 2 ? subset : matured.filter((entry) => entry.horizon === horizon);
        return summarizeResolvedOutcomes(fallback, horizon);
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
    const previousHorizonSnapshotMap = new Map(
      horizonOrder
        .map((horizon) => {
          const window = getOutcomeComparisonWindowForHorizon(horizon);
          const recentMs = window.recentDays * 86_400_000;
          const priorMs = window.priorDays * 86_400_000;
          const subset = matured.filter((entry) => {
            if (entry.horizon !== horizon) return false;
            const stamp = Date.parse(entry.evaluatedAt || entry.generatedAt || entry.loggedAt || '');
            return Number.isFinite(stamp) && now - stamp > recentMs && now - stamp <= priorMs;
          });
          return summarizeResolvedOutcomes(subset, horizon);
        })
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
        .map((snapshot) => [snapshot.key, snapshot]),
    );
    const previousHorizonAdjustmentMap = new Map(
      [...previousHorizonSnapshotMap.values()]
        .map((snapshot) => buildCalibrationAdjustment(snapshot, 'horizon'))
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
        .map((adjustment) => [adjustment.key, adjustment]),
    );
    const horizonComparisons = currentHorizonSnapshots
      .map((snapshot) => describeSnapshotComparison(snapshot, previousHorizonSnapshotMap.get(snapshot.key) ?? null));
    const horizonAdjustments = currentHorizonSnapshots
      .map((snapshot) => {
        const current = buildCalibrationAdjustment(snapshot, 'horizon');
        if (!current) return null;
        return adaptCalibrationAdjustment(current, previousHorizonAdjustmentMap.get(snapshot.key) ?? null);
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
    const calibrationFlags = currentHorizonSnapshots
      .map((snapshot) => buildCalibrationRecommendation(snapshot, 'horizon'))
      .filter((value): value is string => Boolean(value))
      .slice(0, 4);
    const stanceOutcomes = stanceOrder
      .map((stance) => summarizeResolvedOutcomes(matured.filter((entry) => entry.stance === stance), stance))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .map((snapshot) => `${snapshot.key} ${snapshot.positives}/${snapshot.total} avg ${snapshot.avgReturn}%${snapshot.negatives > 0 ? ` neg ${snapshot.negatives}` : ''}`);
    const calibrationSource = recentMatured.length >= 2 ? recentMatured : matured;
    const currentStanceSnapshots = stanceOrder
      .map((stance) => summarizeResolvedOutcomes(calibrationSource.filter((entry) => entry.stance === stance), stance))
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
    const previousStanceSnapshotMap = new Map(
      stanceOrder
        .map((stance) => summarizeResolvedOutcomes(priorMatured.filter((entry) => entry.stance === stance), stance))
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
        .map((snapshot) => [snapshot.key, snapshot]),
    );
    const previousStanceAdjustmentMap = new Map(
      [...previousStanceSnapshotMap.values()]
        .map((snapshot) => buildCalibrationAdjustment(snapshot, 'stance'))
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
        .map((adjustment) => [adjustment.key, adjustment]),
    );
    const stanceComparisons = currentStanceSnapshots
      .map((snapshot) => describeSnapshotComparison(snapshot, previousStanceSnapshotMap.get(snapshot.key) ?? null));
    const stanceAdjustments = currentStanceSnapshots
      .map((snapshot) => {
        const current = buildCalibrationAdjustment(snapshot, 'stance');
        if (!current) return null;
        return adaptCalibrationAdjustment(current, previousStanceAdjustmentMap.get(snapshot.key) ?? null);
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
    const horizonOverlayDetails = horizonAdjustments
      .map((item) => `${item.key} ${item.scoreDelta >= 0 ? '+' : ''}${item.scoreDelta} / stance ${item.thresholdShift >= 0 ? '+' : ''}${item.thresholdShift} · ${item.confidence} · n=${item.sampleCount}`);
    const stanceOverlayDetails = stanceAdjustments
      .map((item) => `${item.key} ${item.scoreDelta >= 0 ? '+' : ''}${item.scoreDelta} / stance ${item.thresholdShift >= 0 ? '+' : ''}${item.thresholdShift} · ${item.confidence} · n=${item.sampleCount}`);
    const horizonOverlayHistory = horizonAdjustments
      .map((item) => describeCalibrationTrend(item, previousHorizonAdjustmentMap.get(item.key) ?? null));
    const stanceOverlayHistory = stanceAdjustments
      .map((item) => describeCalibrationTrend(item, previousStanceAdjustmentMap.get(item.key) ?? null));
    const coefficientSuggestions = [
      ...currentHorizonSnapshots.map((snapshot) => buildCalibrationRecommendation(snapshot, 'horizon')),
      ...stanceOrder.map((stance) => {
        const snapshot = summarizeResolvedOutcomes(matured.filter((entry) => entry.stance === stance), stance);
        return snapshot ? buildCalibrationRecommendation(snapshot, 'stance') : null;
      }),
    ].filter((value): value is string => Boolean(value)).slice(0, 6);
    const topResolvedIdeas = matured
      .filter((entry) => typeof entry.latestReturnPct === 'number')
      .sort((left, right) => (right.latestReturnPct ?? 0) - (left.latestReturnPct ?? 0))
      .slice(0, 3)
      .map((entry) => `${entry.symbol} ${entry.horizon} ${entry.latestReturnPct}%`);
    const weakResolvedIdeas = matured
      .filter((entry) => typeof entry.latestReturnPct === 'number')
      .sort((left, right) => (left.latestReturnPct ?? 0) - (right.latestReturnPct ?? 0))
      .slice(0, 3)
      .map((entry) => `${entry.symbol} ${entry.horizon} ${entry.latestReturnPct}%`);
    return {
      totalEntries: entries.length,
      recentEntries: activeEntries.length,
      recentCandidateCount: latestEntries.length,
      averageScore: latestEntries.length > 0 ? Math.round(totalScore / latestEntries.length) : null,
      resolvedCount: matured.length,
      positiveCount,
      negativeCount,
      horizonAverages,
      stanceMix,
      driftLeaders,
      maturedOutcomes,
      calibrationFlags,
      topResolvedIdeas,
      weakResolvedIdeas,
      horizonThresholds,
      stanceOutcomes,
      coefficientSuggestions,
      horizonAdjustments,
      stanceAdjustments,
      horizonOverlayDetails,
      stanceOverlayDetails,
      horizonComparisons,
      stanceComparisons,
      horizonOverlayHistory,
      stanceOverlayHistory,
      comparisonWindows,
    };
  }

  public async refresh(): Promise<boolean> {
    try {
      const today = new Date();
      const future = new Date(today.getTime() + 14 * 86_400_000);
      const fromDate = today.toISOString().slice(0, 10);
      const toDate = future.toISOString().slice(0, 10);

      const [implications, portfolio, portfolioTargets, reviewHistoryPayload, evaluationLogPayload, fearGreed, backtests, etfFlows, stablecoinMarkets, cryptoSectors, hyperliquidFlow, sectorSummary, marketBreadth, earningsCalendar, economicCalendar] = await Promise.all([
        this.withTimeout(fetchMarketImplications().catch(() => null), null),
        this.withTimeout(fetchPersonalPortfolioExport('risk', { signal: this.signal }).catch(() => null as PersonalPortfolioExport | null), null),
        this.withTimeout(fetchPersonalPortfolioTargets({ signal: this.signal }).catch(() => null), null),
        this.withTimeout(fetchIdeaRadarReviewHistory({ signal: this.signal }).catch(() => null), null),
        this.withTimeout(fetchIdeaRadarEvaluationLog({ signal: this.signal }).catch(() => null), null),
        this.withTimeout(this.marketClient.getFearGreedIndex({}).catch(() => null), null),
        this.withTimeout(fetchStoredStockBacktests(12).catch(() => []), []),
        this.withTimeout(this.marketClient.listEtfFlows({}).catch(() => null), null),
        this.withTimeout(this.marketClient.listStablecoinMarkets({ coins: [] }).catch(() => null), null),
        this.withTimeout(this.marketClient.listCryptoSectors({}).catch(() => null), null),
        this.withTimeout(this.marketClient.getHyperliquidFlow({}).catch(() => null), null),
        this.withTimeout(this.marketClient.getSectorSummary({ period: '' }).catch(() => null), null),
        this.withTimeout(this.marketClient.getMarketBreadthHistory({}).catch(() => null), null),
        this.withTimeout(this.marketClient.listEarningsCalendar({ fromDate, toDate }).catch(() => null), null),
        this.withTimeout(this.economicClient.getEconomicCalendar({ fromDate, toDate }).catch(() => null), null),
      ]);
      const stockAnalysisTargets = this.getMarkets()
        .filter((market) => typeof market.change === 'number')
        .sort((left, right) => Math.abs((right.change ?? 0)) - Math.abs((left.change ?? 0)))
        .slice(0, 5)
        .map((market) => ({ symbol: market.symbol, name: market.name, display: market.name }));
      const stockAnalyses = await this.withTimeout(fetchStockAnalysesForTargets(stockAnalysisTargets).catch(() => []), []);
      const stockAnalysisMap = Object.fromEntries(
        stockAnalyses.filter((item) => item?.available).map((item) => [item.symbol.toUpperCase(), item]),
      );

      const nextViewModel = buildIdeaRadarViewModel({
        markets: this.getMarkets(),
        predictions: this.getPredictions(),
        portfolio,
        portfolioTargets,
        reviewHistory: reviewHistoryPayload?.history ?? null,
        watchlistSymbols: getMarketWatchlistEntries().map((entry) => entry.symbol),
        implications,
        regimeContext: fearGreed && !fearGreed.unavailable ? {
          compositeScore: fearGreed.compositeScore,
          compositeLabel: fearGreed.compositeLabel,
          cnnFearGreed: fearGreed.cnnFearGreed ?? undefined,
        } : null,
        backtests,
        etfFlows,
        stablecoinMarkets,
        cryptoSectors,
        hyperliquidFlow,
        stockAnalyses: stockAnalysisMap,
        sectorSummary,
        marketBreadth,
        earningsCalendar,
        economicCalendar,
        news: this.getNews(),
      });
      if (nextViewModel.nextReviewHistory) {
        void persistIdeaRadarReviewHistory(nextViewModel.nextReviewHistory, { signal: this.signal }).catch(() => null);
      }
      const currentEntries = this.hydrateEvaluationOutcome(evaluationLogPayload?.entries ?? [], this.getMarkets());
      const nextEntries = this.mergeEvaluationLogEntries(currentEntries, this.buildEvaluationLogEntries(nextViewModel));
      void persistIdeaRadarEvaluationLog(nextEntries, { signal: this.signal }).catch(() => null);
      this.loading = false;
      const evaluationSummary = this.buildEvaluationLogSummary(nextEntries);
      this.evaluationSummary = evaluationSummary;
      if (evaluationSummary) {
        nextViewModel.notes = [
          ...nextViewModel.notes,
          `評価ログ: ${evaluationSummary.totalEntries}件, 有効候補 ${evaluationSummary.recentCandidateCount}件, 平均スコア ${evaluationSummary.averageScore ?? 'n/a'}.`,
          evaluationSummary.horizonAverages.length
            ? `直近の時間軸平均: ${evaluationSummary.horizonAverages.join(' · ')}`
            : '直近の時間軸平均: n/a',
          evaluationSummary.stanceMix.length
            ? `直近のスタンス内訳: ${evaluationSummary.stanceMix.join(' · ')}`
            : '直近のスタンス内訳: n/a',
          evaluationSummary.driftLeaders.length
            ? `直近の変化上位: ${evaluationSummary.driftLeaders.join(' / ')}`
            : '直近の変化上位: まだ大きな変化はありません',
          `判定しきい値: ${evaluationSummary.horizonThresholds.join(' · ')}`,
        ];
      }
      const calibratedViewModel = this.applyCalibrationProfile(nextViewModel, evaluationSummary);
      this.viewModel = calibratedViewModel;
      this.setCount(calibratedViewModel.candidates.length);
      this.render();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.loading = false;
      this.evaluationSummary = null;
      this.viewModel = this.buildUnavailableViewModel('Idea radar is temporarily unavailable. Core finance panels continue loading.');
      this.setCount(0);
      console.error('[IdeaRadarPanel] refresh failed:', error);
      this.render();
      return true;
    }
  }

  protected render(): void {
    if (this.loading) {
      this.showLoading();
      return;
    }

    if (!this.viewModel || this.viewModel.candidates.length === 0) {
      replaceChildren(this.content, this.renderEmptyState(this.viewModel, this.evaluationSummary));
      return;
    }

    replaceChildren(
      this.content,
      this.renderSessionFocusSection(this.viewModel, this.evaluationSummary),
      this.renderPlaybookSection(this.viewModel, this.evaluationSummary),
      this.renderPriorityMapSection(this.viewModel, this.evaluationSummary),
      this.renderRegimeSummarySection(this.viewModel, this.evaluationSummary),
      this.renderBeginnerSummarySection(this.viewModel, this.evaluationSummary),
      ...this.renderHorizonSections(this.viewModel),
      ...(this.evaluationSummary ? [this.renderEvaluationSummarySection(this.evaluationSummary)] : []),
      ...(this.evaluationSummary ? [this.renderCalibrationCompareSection(this.evaluationSummary)] : []),
      h('div', { className: 'portfolio-impact-section' },
        h('div', { className: 'portfolio-impact-section-title' }, this.isJapanese() ? '注記' : 'Notes'),
        ...this.viewModel.notes.map((note) =>
          h('div', { className: 'portfolio-impact-item-body' }, this.translateIdeaText(note)),
        ),
        h('div', { className: 'portfolio-impact-footnote' }, `${this.isJapanese() ? '更新' : 'Updated'} ${this.formatTimestamp(this.viewModel.generatedAt)}`),
      ),
    );
  }

  private renderEmptyState(
    viewModel: IdeaRadarViewModel | null,
    evaluationSummary: EvaluationLogSummary | null,
  ): HTMLElement {
    const ja = this.isJapanese();
    const notes = viewModel?.notes ?? [];
    const primaryNote = notes[0] ?? (ja ? '現時点では候補アイデアはまだありません。' : 'No candidate ideas yet.');
    const isUnavailable = /temporarily unavailable|一時的に利用できません/.test(primaryNote);
    const secondaryNotes = isUnavailable ? notes.slice(1) : notes;

    return h('div', { className: 'idea-radar-empty-state' },
      h('div', { className: 'portfolio-impact-section' },
        h('div', { className: 'portfolio-impact-section-title' }, ja ? '候補状況' : 'Candidate Status'),
        h('div', { className: 'portfolio-impact-item-body' },
          isUnavailable
            ? primaryNote
            : (ja
              ? '現時点では主軸候補はまだ形成されていません。監視銘柄と補助オーバーレイを更新しながら次の候補形成を待ちます。'
              : 'No clear core idea has formed yet. Keep monitoring watchlist names and overlay inputs while the next setup develops.'),
        ),
        !isUnavailable && primaryNote
          ? h('div', { className: 'portfolio-impact-item-body' }, this.translateIdeaText(primaryNote))
          : null,
      ),
      ...(viewModel
        ? [
            this.renderSessionFocusSection(viewModel, evaluationSummary),
            this.renderPlaybookSection(viewModel, evaluationSummary),
            this.renderPriorityMapSection(viewModel, evaluationSummary),
            this.renderRegimeSummarySection(viewModel, evaluationSummary),
            this.renderBeginnerSummarySection(viewModel, evaluationSummary),
          ]
        : []),
      h('div', { className: 'portfolio-impact-section' },
        h('div', { className: 'portfolio-impact-section-title' }, ja ? '注記' : 'Notes'),
        ...(secondaryNotes.length
          ? secondaryNotes.map((note) => h('div', { className: 'portfolio-impact-item-body' }, this.translateIdeaText(note)))
          : [h('div', { className: 'portfolio-impact-item-body' }, ja ? '追記事項はありません。' : 'No additional notes.')]),
      ),
    );
  }

  private renderSessionFocusSection(
    viewModel: IdeaRadarViewModel,
    evaluationSummary: EvaluationLogSummary | null,
  ): HTMLElement {
    const ja = this.isJapanese();
    const buckets = buildIdeaRadarPriorityBucketsWithCalibration(viewModel.candidates, {
      horizonScoreDelta: Object.fromEntries((evaluationSummary?.horizonAdjustments ?? []).map((item) => [item.key, item.scoreDelta])) as Partial<Record<IdeaCandidate['horizon'], number>>,
      stanceScoreDelta: Object.fromEntries((evaluationSummary?.stanceAdjustments ?? []).map((item) => [item.key, item.scoreDelta])) as Partial<Record<IdeaCandidate['stance'], number>>,
      horizonAdjustments: Object.fromEntries((evaluationSummary?.horizonAdjustments ?? []).map((item) => [item.key, item])) as Partial<Record<IdeaCandidate['horizon'], NonNullable<EvaluationLogSummary['horizonAdjustments'][number]>>>,
      stanceAdjustments: Object.fromEntries((evaluationSummary?.stanceAdjustments ?? []).map((item) => [item.key, item])) as Partial<Record<IdeaCandidate['stance'], NonNullable<EvaluationLogSummary['stanceAdjustments'][number]>>>,
    });
    const main = (buckets.main as IdeaCandidate[]).slice(0, 2);
    const tactical = (buckets.tactical as IdeaCandidate[]).slice(0, 1);
    const headline = buildIdeaRadarRegimeHeadline(viewModel.candidates, evaluationSummary);
    const calibration = evaluationSummary?.coefficientSuggestions[0] ?? (ja ? '直ちに再調整は不要です。' : 'No immediate recalibration.');

    return h('div', { className: 'portfolio-impact-section finance-guide-brief' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '注目ポイント' : 'Session Focus'),
      h(
        'div',
        { className: 'portfolio-impact-item-body finance-guide-brief-line' },
        main.length
          ? `${ja ? '主軸' : 'Main'} ${main.map((item) => `${item.symbol} ${item.horizon} ${item.stance}`).join(' / ')}`
          : ja ? '主軸 中期で明確な中心候補はまだありません。' : 'Main No clear swing focus yet.',
      ),
      h(
        'div',
        { className: 'portfolio-impact-item-body finance-guide-brief-line' },
        tactical.length
          ? `${ja ? '短期' : 'Tactical'} ${tactical.map((item) => `${item.symbol} ${item.horizon} ${item.stance}`).join(' / ')}`
          : ja ? '短期 まだ短期中心の候補はありません。' : 'Tactical No short-horizon focus yet.',
      ),
      h('div', { className: 'portfolio-impact-item-body finance-guide-brief-line' }, `${ja ? '市場環境' : 'Regime'} ${this.translateIdeaText(headline)}`),
      h('div', { className: 'portfolio-impact-item-body finance-guide-brief-line' }, `${ja ? '補正' : 'Calibration'} ${this.translateIdeaText(calibration)}`),
    );
  }

  private renderPlaybookSection(
    viewModel: IdeaRadarViewModel,
    evaluationSummary: EvaluationLogSummary | null,
  ): HTMLElement {
    const ja = this.isJapanese();
    const compact = this.isCompactViewport();
    const expanded = compact ? this.playbookExpanded : true;
    const checklist = buildIdeaRadarDailyChecklist(viewModel.candidates, evaluationSummary);
    const checklistLimit = expanded
      ? checklist.length
      : IdeaRadarPanel.MOBILE_PLAYBOOK_LIMIT;
    return h('div', { className: 'portfolio-impact-section idea-radar-playbook' },
      h('div', { className: 'portfolio-impact-section-title-row' },
        h('div', { className: 'portfolio-impact-section-title' }, ja ? '見方' : 'How To Use'),
        compact
          ? h('button', {
            className: 'idea-radar-playbook-toggle',
            type: 'button',
            'aria-expanded': expanded ? 'true' : 'false',
            onclick: () => this.setPlaybookExpanded(!this.playbookExpanded),
          }, expanded ? (ja ? '閉じる' : 'Collapse') : (ja ? '開く' : 'Expand'))
          : null,
      ),
      h('div', { className: 'portfolio-impact-item-body' }, ja ? '日次の確認順: 1d -> 1w -> 1h -> 10m' : 'Daily order: 1d -> 1w -> 1h -> 10m'),
      ...(expanded
        ? [h('div', { className: 'portfolio-impact-item-body' }, ja ? '確認順: スタンス -> テーマ強度 -> 短期確認 -> 状態 / 差分 / 変化 -> 結果レビュー -> 補正比較' : 'Read order: Stance -> Theme strength -> Short-term confirmation -> State / Delta / Shift -> Outcome Review -> Calibration Compare')]
        : []),
      ...checklist.slice(0, checklistLimit).map((item) => h('div', { className: 'portfolio-impact-item-body' }, this.translateIdeaText(item))),
    );
  }

  private renderPriorityMapSection(
    viewModel: IdeaRadarViewModel,
    evaluationSummary: EvaluationLogSummary | null,
  ): HTMLElement {
    const ja = this.isJapanese();
    const buckets = buildIdeaRadarPriorityBucketsWithCalibration(viewModel.candidates, {
      horizonScoreDelta: Object.fromEntries((evaluationSummary?.horizonAdjustments ?? []).map((item) => [item.key, item.scoreDelta])) as Partial<Record<IdeaCandidate['horizon'], number>>,
      stanceScoreDelta: Object.fromEntries((evaluationSummary?.stanceAdjustments ?? []).map((item) => [item.key, item.scoreDelta])) as Partial<Record<IdeaCandidate['stance'], number>>,
      horizonAdjustments: Object.fromEntries((evaluationSummary?.horizonAdjustments ?? []).map((item) => [item.key, item])) as Partial<Record<IdeaCandidate['horizon'], NonNullable<EvaluationLogSummary['horizonAdjustments'][number]>>>,
      stanceAdjustments: Object.fromEntries((evaluationSummary?.stanceAdjustments ?? []).map((item) => [item.key, item])) as Partial<Record<IdeaCandidate['stance'], NonNullable<EvaluationLogSummary['stanceAdjustments'][number]>>>,
    });
    const renderBucket = (label: string, tone: 'main' | 'tactical' | 'avoid', items: IdeaCandidate[], fallback: string) =>
      items.length
        ? h('div', { className: `portfolio-impact-item-body idea-radar-priority-line idea-radar-priority-line-${tone}` }, `${label} ${items.map((item) => `${item.symbol} ${item.horizon} ${this.translateIdeaText(item.stance)} (${item.score})`).join(' / ')}`)
        : h('div', { className: `portfolio-impact-item-body idea-radar-priority-line idea-radar-priority-line-${tone}` }, `${label} ${fallback}`);
    return h('div', { className: 'portfolio-impact-section' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '優先度マップ' : 'Priority Map'),
      renderBucket(ja ? '主軸' : 'Main', 'main', buckets.main as IdeaCandidate[], ja ? '1d / 1w の主力候補はまだ薄い。' : 'No clear 1d / 1w main candidates yet.'),
      renderBucket(ja ? '短期' : 'Tactical', 'tactical', buckets.tactical as IdeaCandidate[], ja ? '10m / 1h の補助候補はまだ薄い。' : 'No 10m / 1h tactical candidates yet.'),
      renderBucket(ja ? '回避' : 'Avoid', 'avoid', buckets.avoid as IdeaCandidate[], ja ? '回避 / 試し玉のみ の候補はまだ少ない。' : 'No avoid / starter-size-only candidates yet.'),
      evaluationSummary?.coefficientSuggestions.length
        ? h('div', { className: 'portfolio-impact-item-body' }, `${ja ? '優先メモ' : 'Priority note'} ${evaluationSummary.coefficientSuggestions[0]}`)
        : null,
    );
  }

  private renderRegimeSummarySection(
    viewModel: IdeaRadarViewModel,
    evaluationSummary: EvaluationLogSummary | null,
  ): HTMLElement {
    const ja = this.isJapanese();
    const headline = buildIdeaRadarRegimeHeadline(viewModel.candidates, evaluationSummary);
    const lines = buildIdeaRadarRegimeSummary(viewModel.candidates, evaluationSummary);
    return h('div', { className: 'portfolio-impact-section' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '市場環境サマリー' : 'Regime Summary'),
      h('div', { className: 'portfolio-impact-item-body idea-radar-regime-headline' }, this.translateIdeaText(headline)),
      ...lines.slice(0, 2).map((line) => h('div', { className: 'portfolio-impact-item-body' }, this.translateIdeaText(line))),
    );
  }

  private renderBeginnerSummarySection(
    viewModel: IdeaRadarViewModel,
    evaluationSummary: EvaluationLogSummary | null,
  ): HTMLElement {
    const ja = this.isJapanese();
    const lines = buildIdeaRadarBeginnerSummary(viewModel.candidates, evaluationSummary);
    const limit = this.isCompactViewport()
      ? IdeaRadarPanel.MOBILE_BEGINNER_SUMMARY_LIMIT
      : lines.length;
    return h('div', { className: 'portfolio-impact-section idea-radar-beginner-summary' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '初心者向けまとめ' : 'Beginner Summary'),
      ...lines.slice(0, limit).map((line) => h('div', { className: 'portfolio-impact-item-body' }, this.translateIdeaText(line))),
    );
  }

  private renderHorizonSections(viewModel: IdeaRadarViewModel): HTMLElement[] {
    const ja = this.isJapanese();
    const labels: Record<'10m' | '1h' | '1d' | '1w', string> = {
      '10m': ja ? '10分' : '10 Minutes',
      '1h': ja ? '1時間' : '1 Hour',
      '1d': ja ? '1日' : '1 Day',
      '1w': ja ? '1週間' : '1 Week',
    };
    const horizons: Array<'10m' | '1h' | '1d' | '1w'> = ['1d', '1w', '1h', '10m'];

    return horizons
      .filter((horizon) => viewModel.candidatesByHorizon[horizon].length > 0)
      .map((horizon) => {
        const candidates = viewModel.candidatesByHorizon[horizon]
          .slice()
          .sort((left, right) => {
            const stanceRank = (candidate: IdeaCandidate): number => {
              if (candidate.stance === 'research') return 3;
              if (candidate.stance === 'watch') return 2;
              if (candidate.stance === 'starter-size only') return 1;
              return 0;
            };
            const rankGap = stanceRank(right) - stanceRank(left);
            return rankGap !== 0 ? rankGap : right.score - left.score;
          });
        return h('div', { className: 'portfolio-impact-section' },
          h('div', { className: 'portfolio-impact-section-title' }, labels[horizon]),
          ...candidates.slice(0, IdeaRadarPanel.HORIZON_CANDIDATE_LIMIT).map((candidate) => this.renderCandidate(candidate)),
          ...(candidates.length > IdeaRadarPanel.HORIZON_CANDIDATE_LIMIT
            ? [h('div', { className: 'portfolio-impact-footnote' }, ja ? `${candidates.length}件中 ${IdeaRadarPanel.HORIZON_CANDIDATE_LIMIT}件を表示` : `Showing ${IdeaRadarPanel.HORIZON_CANDIDATE_LIMIT} of ${candidates.length} candidates`)]
            : []),
        );
      });
  }

  private renderEvaluationSummarySection(summary: EvaluationLogSummary): HTMLElement {
    const ja = this.isJapanese();
    return h('div', { className: 'portfolio-impact-section' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '結果レビュー' : 'Outcome Review'),
      h(
        'div',
        { className: 'portfolio-impact-item-body' },
        ja
          ? `記録 ${summary.totalEntries}件 · 有効 ${summary.recentCandidateCount}件 · 解決済み ${summary.resolvedCount}件 · 平均スコア ${summary.averageScore ?? 'n/a'}`
          : `Coverage ${summary.totalEntries} logs · ${summary.recentCandidateCount} active · ${summary.resolvedCount} resolved · avg score ${summary.averageScore ?? 'n/a'}`,
      ),
      h(
        'div',
        { className: 'portfolio-impact-item-body' },
        ja
          ? `的中内訳 上振れ ${summary.positiveCount}件${summary.negativeCount > 0 ? ` · 下振れ ${summary.negativeCount}件` : ''}${summary.resolvedCount > 0 ? ` · 的中率 ${(Math.round((summary.positiveCount / summary.resolvedCount) * 1000) / 10)}%` : ''}`
          : `Hit mix ${summary.positiveCount} positive${summary.negativeCount > 0 ? ` · ${summary.negativeCount} negative` : ''}${summary.resolvedCount > 0 ? ` · ${(Math.round((summary.positiveCount / summary.resolvedCount) * 1000) / 10)}% hit` : ''}`,
      ),
      summary.maturedOutcomes.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `時間軸別 ${this.translateIdeaText(summary.maturedOutcomes.join(' / '))}` : `By horizon ${summary.maturedOutcomes.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '時間軸別 まだ十分な結果がありません' : 'By horizon no matured outcomes yet'),
      h('div', { className: 'portfolio-impact-item-body' }, ja ? `判定しきい値 ${summary.horizonThresholds.join(' · ')}` : `Thresholds ${summary.horizonThresholds.join(' · ')}`),
      summary.calibrationFlags.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `補正状況 ${this.translateIdeaText(summary.calibrationFlags.join(' / '))}` : `Calibration ${summary.calibrationFlags.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '補正状況 安定' : 'Calibration stable'),
      summary.stanceOutcomes.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `スタンス結果 ${this.translateIdeaText(summary.stanceOutcomes.join(' / '))}` : `Stance outcomes ${summary.stanceOutcomes.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? 'スタンス結果 まだ十分な結果がありません' : 'Stance outcomes no matured outcomes yet'),
      summary.coefficientSuggestions.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `再調整提案 ${this.translateIdeaText(summary.coefficientSuggestions.join(' / '))}` : `Recalibration ${summary.coefficientSuggestions.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '再調整提案 まだ変更はありません' : 'Recalibration no changes suggested yet'),
      summary.topResolvedIdeas.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `好結果の上位 ${this.translateIdeaText(summary.topResolvedIdeas.join(' / '))}` : `Top resolved ${summary.topResolvedIdeas.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '好結果の上位 まだ十分な結果がありません' : 'Top resolved no matured outcomes yet'),
      summary.weakResolvedIdeas.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `弱い結果の上位 ${this.translateIdeaText(summary.weakResolvedIdeas.join(' / '))}` : `Weak resolved ${summary.weakResolvedIdeas.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '弱い結果の上位 まだ十分な結果がありません' : 'Weak resolved no matured outcomes yet'),
      summary.driftLeaders.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `変化が大きい項目 ${this.translateIdeaText(summary.driftLeaders.join(' / '))}` : `Drift leaders ${summary.driftLeaders.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '変化が大きい項目 まだ目立つ変化はありません' : 'Drift leaders no meaningful change yet'),
    );
  }

  private renderCalibrationCompareSection(summary: EvaluationLogSummary): HTMLElement {
    const ja = this.isJapanese();
    return h('div', { className: 'portfolio-impact-section' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '補正比較' : 'Calibration Compare'),
      h('div', { className: 'portfolio-impact-item-body' }, ja ? `比較期間 ${this.translateIdeaText(summary.comparisonWindows.join(' · '))} / スタンス 直近30日 / 過去90日` : `Windows ${summary.comparisonWindows.join(' · ')} / stance recent 30d / prior 90d`),
      summary.horizonComparisons.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `時間軸比較 ${this.translateIdeaText(summary.horizonComparisons.join(' / '))}` : `Horizon compare ${summary.horizonComparisons.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '時間軸比較 まだ比較対象が不足しています' : 'Horizon compare not enough prior outcomes yet'),
      summary.stanceComparisons.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `スタンス比較 ${this.translateIdeaText(summary.stanceComparisons.join(' / '))}` : `Stance compare ${summary.stanceComparisons.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? 'スタンス比較 まだ比較対象が不足しています' : 'Stance compare not enough prior outcomes yet'),
      summary.horizonOverlayDetails.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `時間軸オーバーレイ ${this.translateIdeaText(summary.horizonOverlayDetails.join(' / '))}` : `Horizon overlay ${summary.horizonOverlayDetails.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? '時間軸オーバーレイ 現在補正なし' : 'Horizon overlay no active adjustment'),
      summary.stanceOverlayDetails.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `スタンスオーバーレイ ${this.translateIdeaText(summary.stanceOverlayDetails.join(' / '))}` : `Stance overlay ${summary.stanceOverlayDetails.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? 'スタンスオーバーレイ 現在補正なし' : 'Stance overlay no active adjustment'),
      summary.horizonOverlayHistory.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `オーバーレイ履歴 ${this.translateIdeaText(summary.horizonOverlayHistory.join(' / '))}` : `Overlay history ${summary.horizonOverlayHistory.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? 'オーバーレイ履歴 まだ過去補正はありません' : 'Overlay history no prior horizon adjustment yet'),
      summary.stanceOverlayHistory.length
        ? h('div', { className: 'portfolio-impact-item-body' }, ja ? `スタンス履歴 ${this.translateIdeaText(summary.stanceOverlayHistory.join(' / '))}` : `Stance history ${summary.stanceOverlayHistory.join(' / ')}`)
        : h('div', { className: 'portfolio-impact-item-body' }, ja ? 'スタンス履歴 まだ過去補正はありません' : 'Stance history no prior stance adjustment yet'),
    );
  }

  private renderCandidate(candidate: IdeaCandidate): HTMLElement {
    const ja = this.isJapanese();
    const priorityGroup = getIdeaRadarPriorityGroup(candidate);
    const priorityTone = priorityGroup.toLowerCase();
    const themeShift = candidate.themeStrength.basisChange
      ? `${ja ? 'テーマ変化' : 'Theme shift'} ↑ ${candidate.themeStrength.basisChange}`
      : null;
    const shortTermShift = candidate.shortTermConfirmation?.basisChange
      ? `${ja ? '短期変化' : 'Short-term shift'} ↑ ${candidate.shortTermConfirmation.basisChange}`
      : null;
    const shiftSummary = [
      candidate.shortTermConfirmation?.basisChange ? `${ja ? '短期' : 'Short'} ${candidate.shortTermConfirmation.basisChange}` : null,
      candidate.themeStrength.basisChange ? `${ja ? 'テーマ' : 'Theme'} ${candidate.themeStrength.basisChange}` : null,
    ].filter(Boolean);
    const signalState = [
      `${ja ? 'テーマ' : 'Theme'} ${candidate.themeStrength.label}`,
      candidate.shortTermConfirmation ? `${ja ? '短期' : 'Short'} ${candidate.shortTermConfirmation.label}` : null,
      candidate.orderFlowRegime ? `${ja ? 'フロー' : 'Flow'} ${candidate.orderFlowRegime.label}` : null,
    ].filter(Boolean);
    const signalDeltas = [
      candidate.themeStrength.deltaFromHistory != null ? `${ja ? 'テーマ' : 'Theme'} ${candidate.themeStrength.deltaFromHistory >= 0 ? '+' : ''}${candidate.themeStrength.deltaFromHistory}` : null,
      candidate.shortTermConfirmation?.deltaFromHistory != null ? `${ja ? '短期' : 'Short'} ${candidate.shortTermConfirmation.deltaFromHistory >= 0 ? '+' : ''}${candidate.shortTermConfirmation.deltaFromHistory}` : null,
      candidate.orderFlowRegime?.deltaFromHistory != null ? `${ja ? 'フロー' : 'Flow'} ${candidate.orderFlowRegime.deltaFromHistory >= 0 ? '+' : ''}${candidate.orderFlowRegime.deltaFromHistory}` : null,
      candidate.backtestConsistency?.deltaFromHistory != null ? `${ja ? 'バックテスト' : 'Backtest'} ${candidate.backtestConsistency.deltaFromHistory >= 0 ? '+' : ''}${candidate.backtestConsistency.deltaFromHistory}` : null,
    ].filter(Boolean);
    return h('div', { className: `portfolio-impact-item idea-radar-candidate idea-radar-candidate-${priorityTone}` },
      h('div', { className: 'portfolio-impact-item-header' },
        h('span', { className: 'portfolio-impact-item-title' }, `${candidate.symbol} · ${candidate.name}`),
        h('span', { className: `portfolio-impact-chip idea-radar-chip idea-radar-chip-${priorityTone}` }, this.translateIdeaText(priorityGroup)),
        h('span', { className: `portfolio-impact-chip idea-radar-asset-chip idea-radar-asset-chip-${priorityTone}` }, this.translateIdeaText(candidate.assetType)),
      ),
      h('div', { className: 'portfolio-impact-item-body' }, `${this.translateIdeaText(candidate.stance.toUpperCase())} · ${ja ? 'スコア' : 'score'} ${candidate.score}`),
      candidate.stanceReason
        ? h('div', { className: 'portfolio-impact-item-body' }, `${ja ? 'スタンス根拠' : 'Stance basis'} ${this.translateIdeaText(candidate.stanceReason)}`)
        : null,
      h('div', { className: 'portfolio-impact-item-body' }, `${ja ? '適合度' : 'Portfolio fit'} ${candidate.portfolioFitScore} · ${this.translateIdeaText(candidate.portfolioFitRationale)}`),
      h('div', { className: 'portfolio-impact-item-body' }, `${ja ? '状態' : 'State'} ${this.translateIdeaText(signalState.join(' · '))}`),
      signalDeltas.length
        ? h('div', { className: 'portfolio-impact-item-body' }, `${ja ? '差分' : 'Delta'} ${this.translateIdeaText(signalDeltas.join(' · '))}`)
        : null,
      themeShift
        ? h('div', { className: 'portfolio-impact-item-body' }, themeShift)
        : null,
      shortTermShift
        ? h('div', { className: 'portfolio-impact-item-body' }, shortTermShift)
        : null,
      candidate.orderFlowRegime
        ? h(
            'div',
            { className: 'portfolio-impact-item-body' },
            `${ja ? 'フロー環境' : 'Order-flow regime'} ${this.translateIdeaText(candidate.orderFlowRegime.label)} ${candidate.orderFlowRegime.score}${
              candidate.orderFlowRegime.deltaFromHistory != null
                ? ` (${candidate.orderFlowRegime.deltaFromHistory >= 0 ? '+' : ''}${candidate.orderFlowRegime.deltaFromHistory}${ja ? ' 前回比' : ' vs last'})`
                : ''
            }`,
          )
        : null,
      candidate.backtestConsistency?.winRate != null
        ? h(
            'div',
            { className: 'portfolio-impact-item-body' },
            `${ja ? 'バックテスト整合' : 'Backtest consistency'} ${candidate.backtestConsistency.winRate}% / ${candidate.backtestConsistency.actionableSignals}${ja ? 'シグナル' : ' signals'}${
              candidate.backtestConsistency.deltaFromHistory != null
                ? ` (${candidate.backtestConsistency.deltaFromHistory >= 0 ? '+' : ''}${candidate.backtestConsistency.deltaFromHistory}${ja ? ' 前回比' : ' vs last'})`
                : ''
            }`,
          )
        : null,
      candidate.scoreMix.length
        ? h('div', { className: 'portfolio-impact-item-body' }, `${ja ? '構成比' : 'Score mix'} ${candidate.scoreMix.map((item) => `${this.translateIdeaText(item.label)} ${item.pct}%`).join(' · ')}`)
        : null,
      candidate.shortTermConfirmation?.basisChange || candidate.themeStrength.basisChange
        ? h(
            'div',
            { className: 'portfolio-impact-item-body' },
            `${ja ? '変化' : 'Shift'} ↗ ${shiftSummary.join(' / ')}`,
          )
        : null,
      shiftSummary.length > 1
        ? h(
            'div',
            { className: 'portfolio-impact-item-body' },
            `${ja ? '変化強度' : 'Shift intensity'} ${ja ? (shiftSummary.length === 2 ? '二重確認' : '単独確認') : (shiftSummary.length === 2 ? 'dual confirmation' : 'single confirmation')}`,
          )
        : null,
      h(
        'div',
        { className: 'portfolio-impact-item-body' },
        `${ja ? '無効化条件' : 'Risk Invalidator'} ${candidate.invalidator}`,
      ),
      candidate.shortTermConfirmation
        ? h(
            'div',
            { className: 'portfolio-impact-item-body' },
            `${ja ? '短期根拠' : 'Short-term basis'} ${candidate.scoreMix.filter((item) => ['Momentum', 'Peer', 'Breadth', 'Flow'].includes(item.label)).map((item) => `${this.translateIdeaText(item.label)} ${item.pct}%`).join(' · ') || (ja ? '該当なし' : 'n/a')}`,
          )
        : null,
      h(
        'div',
        { className: 'portfolio-impact-item-body' },
        `${ja ? 'テーマ根拠' : 'Theme basis'} ${candidate.scoreMix.filter((item) => ['Inflation', 'Labor', 'Consumer', 'Policy', 'Macro', 'Flow', 'Earnings', 'Breadth', 'Peer'].includes(item.label)).map((item) => `${this.translateIdeaText(item.label)} ${item.pct}%`).join(' · ')}`,
      ),
      h('div', { className: 'portfolio-impact-item-body' }, candidate.whyNow),
      ...candidate.drivers.map((driver) =>
        h('div', { className: 'portfolio-impact-item-body' }, `${ja ? '要因' : 'Driver'}: ${this.translateIdeaText(driver)}`),
      ),
      ...candidate.relatedNews.map((item) =>
        h('a', {
          className: 'portfolio-impact-item-body',
          href: item.link,
          target: '_blank',
          rel: 'noopener',
        }, `${ja ? '記事' : 'News'}: ${item.title} (${item.source})`),
      ),
    );
  }

  private isJapanese(): boolean {
    return isJapaneseLocale();
  }

  private translateIdeaText(text: string): string {
    if (!this.isJapanese()) return text;
    return text
      .replace(/\bmixed\b/g, '混合')
      .replace(/\bstable\b/g, '安定')
      .replace(/\bweak\b/gi, '弱い')
      .replace(/\bconfirmed\b/gi, '確認済み')
      .replace(/\bbuilding\b/gi, '形成中')
      .replace(/\bconstructive\b/gi, '前向き')
      .replace(/\bthin\b/gi, '薄い')
      .replace(/\bFragile\b/g, '脆弱')
      .replace(/\bStrong\b/g, '強い')
      .replace(/\bConstructive\b/g, '建設的')
      .replace(/\bMomentum\b/g, 'モメンタム')
      .replace(/\bmomentum\b/g, 'モメンタム')
      .replace(/\bPortfolio\b/g, 'ポートフォリオ')
      .replace(/\bportfolio\b/g, 'ポートフォリオ')
      .replace(/\bPeer\b/g, '同業比較')
      .replace(/\bBreadth\b/g, '広がり')
      .replace(/\bFlow\b/g, 'フロー')
      .replace(/\bTheme\b/g, 'テーマ')
      .replace(/\bShort\b/g, '短期')
      .replace(/\bCal\b/g, '補正')
      .replace(/\bstance\b/g, 'スタンス')
      .replace(/\bState\b/g, '状態')
      .replace(/\bmix\b/g, '構成')
      .replace(/\bcalibration\b/g, '補正')
      .replace(/\boutcomes\b/g, '結果')
      .replace(/\bTight\b/g, '確実')
      .replace(/\bDeveloping\b/g, '発展中')
      .replace(/\bTighten\b/g, '引き締め')
      .replace(/\bPromote\b/g, '引き上げ')
      .replace(/\bInflation\b/g, 'インフレ')
      .replace(/\bLabor\b/g, '雇用')
      .replace(/\bConsumer\b/g, '消費')
      .replace(/\bPolicy\b/g, '政策')
      .replace(/\bMacro\b/g, 'マクロ')
      .replace(/\bEarnings\b/g, '業績')
      .replace(/\bresearch\b/g, '調査')
      .replace(/\bwatch\b/g, '監視')
      .replace(/\bavoid\b/g, '回避')
      .replace(/\bequity\b/g, '株式')
      .replace(/\bcrypto\b/g, '暗号資産')
      .replace(/\bAVOID\b/g, '回避')
      .replace(/\bWATCH\b/g, '監視')
      .replace(/\bRESEARCH\b/g, '調査')
      .replace(/STARTER-SIZE ONLY/g, '試し玉のみ')
      .replace(/\bMAIN\b/g, '主軸')
      .replace(/\bTACTICAL\b/g, '戦術')
      .replace(/\bUNAVAILABLE\b/g, '利用不可')
      .replace(/starter-size only/g, '試し玉のみ')
      .replace(/Target allocation/g, '目標配分')
      .replace(/Outcome thresholds/g, '判定しきい値')
      .replace(/Evaluation log/g, '評価ログ')
      .replace(/Recent horizon averages/g, '直近の時間軸平均')
      .replace(/Recent stance mix/g, '直近のスタンス内訳')
      .replace(/Recent drift leaders/g, '直近の変化上位')
      .replace(/avg score/g, '平均スコア')
      .replace(/ active personal rules/g, ' 件の個人ルールが有効')
      .replace(/Price move/g, '値動き')
      .replace(/Personal rule pressure/g, '個人ルール警戒')
      .replace(/FOMC context/g, 'FOMC文脈')
      .replace(/news confirmation/g, 'ニュース確認')
      .replace(/Calibration overlay:/g, '補正オーバーレイ:')
      .replace(/Default target allocation/g, '既定の目標配分')
      .replace(/デフォルト目標アロケーション/g, '既定の目標配分')
      .replace(/Default target allocation\./g, '既定の目標配分を使用しています。')
      .replace(/including statement or press-conference coverage\./g, '声明・会見の報道を含みます。')
      .replace(/are also active in 直近 coverage\./g, 'も直近報道で活発です。')
      .replace(/1-day/g, '1日')
      .replace(/1-hour/g, '1時間')
      .replace(/1-week/g, '1週間')
      .replace(/10-minute/g, '10分')
      .replace(/1日のモメンタムシグナル/g, '1日のモメンタム確認')
      .replace(/\bhit\b/g, '的中')
      .replace(/\bnow\b/g, '現在')
      .replace(/\brecent\b/g, '直近')
      .replace(/\bprior\b/g, '過去')
      .replace(/\bhigh\b/g, '高')
      .replace(/\bmedium\b/g, '中')
      .replace(/\blow\b/g, '低')
      .replace(/New symbol not currently held\./g, '現在は未保有の新規銘柄です。')
      .replace(/Current budget pressures are manageable\./g, '現在の予算圧力は許容範囲です。')
      .replace(/US equities is/g, '米国株は')
      .replace(/米国株 is/g, '米国株は')
      .replace(/Crypto sleeve is/g, '暗号資産枠は')
      .replace(/modestly under target by ([0-9.]+) points/g, '目標比 $1 ポイント不足')
      .replace(/state fragile theme/g, '状態 テーマ脆弱')
      .replace(/fragile theme/g, 'テーマ脆弱')
      .replace(/fragile order-flow/g, 'フロー脆弱')
      .replace(/score/g, 'スコア')
      .replace(/Outcome Review/g, '結果レビュー')
      .replace(/Calibration Compare/g, '補正比較')
      .replace(/No immediate recalibration\./g, '直ちに再調整は不要です。')
      .replace(/avg/g, '平均');
  }

  private isCompactViewport(): boolean {
    return globalThis.window?.matchMedia?.('(max-width: 768px)').matches ?? false;
  }

  private loadPlaybookExpanded(): boolean {
    const stored = globalThis.localStorage?.getItem(IdeaRadarPanel.PLAYBOOK_STORAGE_KEY);
    if (stored === 'true' || stored === 'false') {
      return stored === 'true';
    }
    return !this.isCompactViewport();
  }

  private setPlaybookExpanded(expanded: boolean): void {
    this.playbookExpanded = expanded;
    globalThis.localStorage?.setItem(IdeaRadarPanel.PLAYBOOK_STORAGE_KEY, String(expanded));
    this.render();
  }

  private formatTimestamp(value: string): string {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }
}
