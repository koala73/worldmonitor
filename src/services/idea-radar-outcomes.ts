import type { IdeaRadarEvaluationLogEntry } from './personal-portfolio.ts';

export interface OutcomeThresholds {
  positivePct: number;
  negativePct: number;
}

export interface OutcomePerformanceSnapshot {
  key: string;
  total: number;
  positives: number;
  negatives: number;
  avgReturn: number;
}

export interface OutcomeComparisonWindow {
  recentDays: number;
  priorDays: number;
}

export interface CalibrationAdjustment {
  key: string;
  scoreDelta: number;
  thresholdShift: number;
  message: string;
  confidence: 'low' | 'medium' | 'high';
  severity: 'light' | 'medium' | 'strong';
  hitRate: number;
  avgReturn: number;
  sampleCount: number;
}

export interface IdeaRadarGuideCandidate {
  symbol: string;
  horizon: IdeaRadarEvaluationLogEntry['horizon'];
  stance: IdeaRadarEvaluationLogEntry['stance'];
  score: number;
  scoreMix?: Array<{ label: string; pct: number }>;
  themeStrength?: { label: string; score: number };
  shortTermConfirmation?: { label: string; score: number } | null;
  orderFlowRegime?: { label: string; score: number } | null;
}

export type IdeaRadarPriorityGroup = 'MAIN' | 'TACTICAL' | 'AVOID';

function isJapaneseLocale(): boolean {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang || '';
    if (lang) return lang.toLowerCase().startsWith('ja');
  }
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language || '';
    if (lang) return lang.toLowerCase().startsWith('ja');
  }
  return true;
}

function translateRegimeLabel(label: string): string {
  switch (label) {
    case 'defensive':
      return '守り';
    case 'constructive':
      return '前向き';
    case 'mixed':
    default:
      return '混合';
  }
}

function translateMixLabels(labels: string[]): string[] {
  return labels.map((label) => {
    switch (label) {
      case 'Flow':
        return 'フロー';
      case 'Breadth':
        return '市場の広がり';
      case 'Earnings':
        return '業績';
      case 'Peer':
        return '同業比較';
      case 'Inflation':
        return 'インフレ';
      case 'Policy':
        return '政策';
      case 'Macro':
        return 'マクロ';
      default:
        return label;
    }
  });
}

function pickTopGuideCandidate(
  candidates: IdeaRadarGuideCandidate[],
  horizons: Array<IdeaRadarGuideCandidate['horizon']>,
): IdeaRadarGuideCandidate | null {
  const found = candidates
    .filter((candidate) => horizons.includes(candidate.horizon))
    .sort((left, right) => right.score - left.score)[0];
  return found ?? null;
}

export function buildIdeaRadarPriorityBuckets(candidates: IdeaRadarGuideCandidate[]): {
  main: IdeaRadarGuideCandidate[];
  tactical: IdeaRadarGuideCandidate[];
  avoid: IdeaRadarGuideCandidate[];
} {
  return buildIdeaRadarPriorityBucketsWithCalibration(candidates, null);
}

export function buildIdeaRadarPriorityBucketsWithCalibration(
  candidates: IdeaRadarGuideCandidate[],
  calibration: {
    horizonScoreDelta?: Partial<Record<IdeaRadarEvaluationLogEntry['horizon'], number>>;
    stanceScoreDelta?: Partial<Record<IdeaRadarEvaluationLogEntry['stance'], number>>;
    horizonAdjustments?: Partial<Record<IdeaRadarEvaluationLogEntry['horizon'], CalibrationAdjustment>>;
    stanceAdjustments?: Partial<Record<IdeaRadarEvaluationLogEntry['stance'], CalibrationAdjustment>>;
  } | null,
): {
  main: IdeaRadarGuideCandidate[];
  tactical: IdeaRadarGuideCandidate[];
  avoid: IdeaRadarGuideCandidate[];
} {
  const adjustedScore = (candidate: IdeaRadarGuideCandidate) =>
    candidate.score
    + (calibration?.horizonScoreDelta?.[candidate.horizon] ?? 0)
    + (calibration?.stanceScoreDelta?.[candidate.stance] ?? 0);
  const convictionBonus = (candidate: IdeaRadarGuideCandidate): number => {
    const themeBonus =
      candidate.themeStrength?.label === 'Confirmed' ? 4 :
      candidate.themeStrength?.label === 'Building' ? 2 : 0;
    const shortBonus =
      candidate.shortTermConfirmation?.label === 'Tight' ? 3 :
      candidate.shortTermConfirmation?.label === 'Developing' ? 1 :
      candidate.shortTermConfirmation?.label === 'Thin' ? -2 : 0;
    const flowBonus =
      candidate.orderFlowRegime?.label === 'Strong' ? 2 :
      candidate.orderFlowRegime?.label === 'Constructive' ? 1 :
      candidate.orderFlowRegime?.label === 'Fragile' ? -2 : 0;
    return themeBonus + shortBonus + flowBonus;
  };
  const horizonSensitivity = (candidate: IdeaRadarGuideCandidate): number => {
    switch (candidate.horizon) {
      case '10m':
        return 0.8;
      case '1h':
        return 0.9;
      case '1d':
        return 1.05;
      case '1w':
      default:
        return 1.15;
    }
  };
  const stanceSensitivity = (candidate: IdeaRadarGuideCandidate): number => {
    switch (candidate.stance) {
      case 'research':
        return 1.1;
      case 'watch':
        return 1;
      case 'starter-size only':
        return 0.85;
      case 'avoid':
      default:
        return 0.75;
    }
  };
  const calibrationWeight = (adjustment: CalibrationAdjustment | undefined): number => {
    if (!adjustment) return 0;
    const confidenceWeight =
      adjustment.confidence === 'high' ? 1.25 :
      adjustment.confidence === 'medium' ? 0.8 : 0.45;
    const severityWeight =
      adjustment.severity === 'strong' ? 1.4 :
      adjustment.severity === 'medium' ? 1 : 0.65;
    const sampleWeight = clamp(adjustment.sampleCount / 8, 0.4, 1.4);
    return round1(adjustment.scoreDelta * confidenceWeight * severityWeight * sampleWeight);
  };
  const rankedScore = (candidate: IdeaRadarGuideCandidate): number => adjustedScore(candidate) + convictionBonus(candidate);
  const tunedRankedScore = (candidate: IdeaRadarGuideCandidate): number =>
    rankedScore(candidate)
    + round1(calibrationWeight(calibration?.horizonAdjustments?.[candidate.horizon]) * horizonSensitivity(candidate))
    + round1(calibrationWeight(calibration?.stanceAdjustments?.[candidate.stance]) * stanceSensitivity(candidate));
  const sorted = [...candidates].sort((left, right) => tunedRankedScore(right) - tunedRankedScore(left));
  const main = sorted
    .filter((candidate) => ['1d', '1w'].includes(candidate.horizon) && ['research', 'watch'].includes(candidate.stance))
    .sort((left, right) => tunedRankedScore(right) - tunedRankedScore(left))
    .slice(0, 4);
  const tactical = sorted
    .filter((candidate) => ['10m', '1h'].includes(candidate.horizon) && candidate.stance !== 'avoid')
    .sort((left, right) => tunedRankedScore(right) - tunedRankedScore(left))
    .slice(0, 4);
  const avoid = sorted
    .filter((candidate) => candidate.stance === 'avoid' || candidate.stance === 'starter-size only')
    .sort((left, right) => tunedRankedScore(left) - tunedRankedScore(right))
    .slice(0, 4);
  return { main, tactical, avoid };
}

export function getIdeaRadarPriorityGroup(candidate: IdeaRadarGuideCandidate): IdeaRadarPriorityGroup {
  if (['1d', '1w'].includes(candidate.horizon) && ['research', 'watch'].includes(candidate.stance)) {
    return 'MAIN';
  }
  if (['10m', '1h'].includes(candidate.horizon) && candidate.stance !== 'avoid') {
    return 'TACTICAL';
  }
  return 'AVOID';
}

function dominantMixLabels(candidates: IdeaRadarGuideCandidate[]): string[] {
  const totals = new Map<string, number>();
  for (const candidate of candidates) {
    for (const item of candidate.scoreMix ?? []) {
      totals.set(item.label, (totals.get(item.label) ?? 0) + item.pct);
    }
  }
  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([label]) => label);
}

export function buildIdeaRadarRegimeSummary(
  candidates: IdeaRadarGuideCandidate[],
  evaluationSummary: { calibrationFlags: string[]; positiveCount?: number; negativeCount?: number } | null,
): string[] {
  const ja = isJapaneseLocale();
  const buckets = buildIdeaRadarPriorityBuckets(candidates);
  const dominant = dominantMixLabels(buckets.main.length > 0 ? buckets.main : candidates);
  const positiveCount = evaluationSummary?.positiveCount ?? 0;
  const negativeCount = evaluationSummary?.negativeCount ?? 0;
  const mainConfirmed = buckets.main.filter((candidate) => candidate.themeStrength?.label === 'Confirmed').length;
  const shortThin = buckets.tactical.filter((candidate) => candidate.shortTermConfirmation?.label === 'Thin').length;
  const strongFlow = candidates.filter((candidate) => candidate.orderFlowRegime?.label === 'Strong').length;
  const defensive = dominant.some((label) => ['Inflation', 'Policy', 'Macro'].includes(label))
    || negativeCount > positiveCount
    || shortThin >= 2;
  const constructive = (
    dominant.some((label) => ['Flow', 'Breadth', 'Earnings', 'Peer'].includes(label))
    && positiveCount >= negativeCount
  ) || (mainConfirmed >= 2 && strongFlow >= 1);
  const regimeLabel = defensive ? 'defensive' : constructive ? 'constructive' : 'mixed';
  const firstCalibrationFlag = evaluationSummary?.calibrationFlags[0];
  const calibrationLine = firstCalibrationFlag
    ? firstCalibrationFlag.replace(/\s*\(.+?\)$/, '')
    : ja ? '安定' : 'stable';
  return [
    dominant.length
      ? ja
        ? `市場環境 ${translateRegimeLabel(regimeLabel)} · ${translateMixLabels(dominant).join(' + ')}。`
        : `Regime ${regimeLabel} · ${dominant.join(' + ')}.`
      : ja
        ? `市場環境 ${translateRegimeLabel(regimeLabel)}。`
        : `Regime ${regimeLabel}.`,
    buckets.main.length
      ? ja
        ? `主軸 ${buckets.main.map((candidate) => `${candidate.symbol} ${candidate.horizon}`).join(' / ')}。`
        : `Main ${buckets.main.map((candidate) => `${candidate.symbol} ${candidate.horizon}`).join(' / ')}.`
      : ja
        ? '主軸はまだ形成中。'
        : 'Main still forming.',
    shortThin > 0
      ? ja
        ? `短期は ${shortThin} 件が薄い · 補正 ${calibrationLine}。`
        : `Short thin on ${shortThin} · Cal ${calibrationLine}.`
      : ja
        ? `短期は安定 · 補正 ${calibrationLine}。`
        : `Short stable · Cal ${calibrationLine}.`,
  ];
}

export function buildIdeaRadarRegimeHeadline(
  candidates: IdeaRadarGuideCandidate[],
  evaluationSummary: { calibrationFlags: string[]; positiveCount?: number; negativeCount?: number } | null,
): string {
  const ja = isJapaneseLocale();
  const summary = buildIdeaRadarRegimeSummary(candidates, evaluationSummary);
  const first = summary[0]
    ?.replace(/^(Regime |市場環境 )/, '')
    .replace(/[。.]\s*$/, '') ?? (ja ? '混合' : 'mixed');
  const second = summary[2]
    ?.replace(/^(Short |短期は\s*)/, '')
    .replace(/[。.]\s*$/, '') ?? (ja ? '安定' : 'stable');
  return `${first} | ${second}.`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sign(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function getConfidence(total: number): CalibrationAdjustment['confidence'] {
  if (total >= 8) return 'high';
  if (total >= 4) return 'medium';
  return 'low';
}

function getWeakSeverity(hitRate: number, avgReturn: number): CalibrationAdjustment['severity'] {
  if (hitRate < 0.3 || avgReturn < -1.2) return 'strong';
  if (hitRate < 0.4 || avgReturn < -0.5) return 'medium';
  return 'light';
}

function getStrongSeverity(hitRate: number, avgReturn: number): CalibrationAdjustment['severity'] {
  if (hitRate > 0.85 && avgReturn > 2) return 'strong';
  if (hitRate > 0.7 && avgReturn > 0.8) return 'medium';
  return 'light';
}

export function getOutcomeComparisonWindowForHorizon(
  horizon: IdeaRadarEvaluationLogEntry['horizon'],
): OutcomeComparisonWindow {
  switch (horizon) {
    case '10m':
    case '1h':
      return { recentDays: 7, priorDays: 21 };
    case '1d':
      return { recentDays: 21, priorDays: 60 };
    case '1w':
    default:
      return { recentDays: 45, priorDays: 120 };
  }
}

export function getOutcomeThresholdsForHorizon(
  horizon: IdeaRadarEvaluationLogEntry['horizon'],
): OutcomeThresholds {
  switch (horizon) {
    case '10m':
      return { positivePct: 0.25, negativePct: -0.25 };
    case '1h':
      return { positivePct: 0.6, negativePct: -0.6 };
    case '1d':
      return { positivePct: 1.5, negativePct: -1.5 };
    case '1w':
    default:
      return { positivePct: 3, negativePct: -3 };
  }
}

export function classifyOutcomeStatus(
  returnPct: number | null,
  due: boolean,
  horizon: IdeaRadarEvaluationLogEntry['horizon'],
): IdeaRadarEvaluationLogEntry['outcomeStatus'] {
  if (!due) return 'pending';
  if (returnPct == null) return 'stale';
  const thresholds = getOutcomeThresholdsForHorizon(horizon);
  if (returnPct >= thresholds.positivePct) return 'positive';
  if (returnPct <= thresholds.negativePct) return 'negative';
  return 'flat';
}

export function summarizeResolvedOutcomes(
  entries: Array<Pick<IdeaRadarEvaluationLogEntry, 'latestReturnPct' | 'outcomeStatus'>>,
  key: string,
): OutcomePerformanceSnapshot | null {
  const resolved = entries.filter((entry) => ['positive', 'negative', 'flat'].includes(entry.outcomeStatus ?? ''));
  if (resolved.length === 0) return null;
  const positives = resolved.filter((entry) => entry.outcomeStatus === 'positive').length;
  const negatives = resolved.filter((entry) => entry.outcomeStatus === 'negative').length;
  const avgReturn = Math.round((resolved.reduce((sum, entry) => sum + (entry.latestReturnPct ?? 0), 0) / resolved.length) * 10) / 10;
  return {
    key,
    total: resolved.length,
    positives,
    negatives,
    avgReturn,
  };
}

export function buildCalibrationRecommendation(
  snapshot: OutcomePerformanceSnapshot,
  mode: 'horizon' | 'stance',
): string | null {
  if (snapshot.total < 2) return null;
  const hitRate = snapshot.positives / snapshot.total;
  if (hitRate < 0.4 || snapshot.avgReturn < -0.5) {
    return `${mode === 'horizon' ? '引き締め' : '引き下げ'} ${snapshot.key} (${snapshot.positives}/${snapshot.total}, 平均 ${snapshot.avgReturn}%)`;
  }
  if (hitRate > 0.7 && snapshot.avgReturn > 0.8) {
    return `${mode === 'horizon' ? '緩和' : '引き上げ'} ${snapshot.key} (${snapshot.positives}/${snapshot.total}, 平均 ${snapshot.avgReturn}%)`;
  }
  return null;
}

export function buildCalibrationAdjustment(
  snapshot: OutcomePerformanceSnapshot,
  mode: 'horizon' | 'stance',
): CalibrationAdjustment | null {
  if (snapshot.total < 2) return null;
  const hitRate = snapshot.positives / snapshot.total;
  const confidence = getConfidence(snapshot.total);
  if (mode === 'horizon') {
    if (hitRate < 0.4 || snapshot.avgReturn < -0.5) {
      const severity = getWeakSeverity(hitRate, snapshot.avgReturn);
      const shortHorizon = snapshot.key === '10m' || snapshot.key === '1h';
      return {
        key: snapshot.key,
        scoreDelta: shortHorizon
          ? (severity === 'strong' ? -5 : severity === 'medium' ? -4 : -3)
          : (severity === 'strong' ? -4 : severity === 'medium' ? -3 : -2),
        thresholdShift: severity === 'strong' && confidence !== 'low' ? 2 : 1,
        message: `weak ${snapshot.key} outcomes (${round1(hitRate * 100)}% / ${snapshot.avgReturn}%)`,
        confidence,
        severity,
        hitRate: round1(hitRate * 100),
        avgReturn: snapshot.avgReturn,
        sampleCount: snapshot.total,
      };
    }
    if (hitRate > 0.7 && snapshot.avgReturn > 0.8) {
      const severity = getStrongSeverity(hitRate, snapshot.avgReturn);
      return {
        key: snapshot.key,
        scoreDelta: snapshot.key === '1w'
          ? (severity === 'strong' ? 4 : severity === 'medium' ? 3 : 2)
          : (severity === 'strong' ? 3 : severity === 'medium' ? 2 : 1),
        thresholdShift: severity === 'strong' && confidence === 'high' ? -2 : -1,
        message: `strong ${snapshot.key} outcomes (${round1(hitRate * 100)}% / ${snapshot.avgReturn}%)`,
        confidence,
        severity,
        hitRate: round1(hitRate * 100),
        avgReturn: snapshot.avgReturn,
        sampleCount: snapshot.total,
      };
    }
    return null;
  }

  if (snapshot.key === 'avoid') return null;
  if (hitRate < 0.4 || snapshot.avgReturn < -0.5) {
    const severity = getWeakSeverity(hitRate, snapshot.avgReturn);
    return {
      key: snapshot.key,
      scoreDelta: severity === 'strong' ? -4 : severity === 'medium' ? -3 : -2,
      thresholdShift: severity === 'strong' && confidence !== 'low' ? 2 : 1,
      message: `weak ${snapshot.key} stance outcomes (${round1(hitRate * 100)}% / ${snapshot.avgReturn}%)`,
      confidence,
      severity,
      hitRate: round1(hitRate * 100),
      avgReturn: snapshot.avgReturn,
      sampleCount: snapshot.total,
    };
  }
  if (hitRate > 0.7 && snapshot.avgReturn > 0.8) {
    const severity = getStrongSeverity(hitRate, snapshot.avgReturn);
    return {
      key: snapshot.key,
      scoreDelta: severity === 'strong' ? 2 : 1,
      thresholdShift: severity === 'strong' && confidence === 'high' ? -2 : -1,
      message: `strong ${snapshot.key} stance outcomes (${round1(hitRate * 100)}% / ${snapshot.avgReturn}%)`,
      confidence,
      severity,
      hitRate: round1(hitRate * 100),
      avgReturn: snapshot.avgReturn,
      sampleCount: snapshot.total,
    };
  }
  return null;
}

export function adaptCalibrationAdjustment(
  current: CalibrationAdjustment,
  previous: CalibrationAdjustment | null,
): CalibrationAdjustment {
  if (!previous) return current;
  const currentDirection = sign(current.scoreDelta);
  const previousDirection = sign(previous.scoreDelta);
  if (currentDirection === 0 || previousDirection === 0) return current;

  if (currentDirection === previousDirection) {
    const persistent = Math.abs(current.scoreDelta) >= Math.abs(previous.scoreDelta);
    if (!persistent || current.confidence === 'low') return current;
    const growingSample = current.sampleCount > previous.sampleCount;
    const extraScore = current.confidence === 'high' && growingSample ? currentDirection : 0;
    const extraThreshold = current.severity === 'strong' && previous.confidence === 'high'
      ? sign(current.thresholdShift || currentDirection)
      : 0;
    return {
      ...current,
      scoreDelta: clamp(current.scoreDelta + currentDirection + extraScore, -7, 6),
      thresholdShift: clamp(
        current.thresholdShift + sign(current.thresholdShift || currentDirection) + extraThreshold,
        -2,
        2,
      ),
      message: `${current.message} · persistent`,
    };
  }

  const reversalPenalty = previous.confidence === 'high' ? currentDirection : 0;
  const softenedScore = current.scoreDelta - currentDirection - reversalPenalty;
  const softenedThreshold = current.thresholdShift === 0
    ? 0
    : current.thresholdShift - sign(current.thresholdShift) - (previous.confidence === 'high' ? sign(current.thresholdShift) : 0);
  return {
    ...current,
    scoreDelta: softenedScore === 0 ? current.scoreDelta : softenedScore,
    thresholdShift: softenedThreshold,
    message: `${current.message} · reversing`,
  };
}

export function describeSnapshotComparison(
  current: OutcomePerformanceSnapshot,
  previous: OutcomePerformanceSnapshot | null,
): string {
  if (!previous) {
    return `${current.key} recent ${current.positives}/${current.total} avg ${current.avgReturn}%`;
  }
  return `${current.key} recent ${current.positives}/${current.total} avg ${current.avgReturn}% vs prior ${previous.positives}/${previous.total} avg ${previous.avgReturn}%`;
}

export function describeCalibrationTrend(
  current: CalibrationAdjustment,
  previous: CalibrationAdjustment | null,
): string {
  if (!previous) {
    return `${current.key} now ${current.scoreDelta >= 0 ? '+' : ''}${current.scoreDelta} / stance ${current.thresholdShift >= 0 ? '+' : ''}${current.thresholdShift}`;
  }
  const scoreDeltaChange = current.scoreDelta - previous.scoreDelta;
  const thresholdDeltaChange = current.thresholdShift - previous.thresholdShift;
  return `${current.key} now ${current.scoreDelta >= 0 ? '+' : ''}${current.scoreDelta} / stance ${current.thresholdShift >= 0 ? '+' : ''}${current.thresholdShift} vs prior ${previous.scoreDelta >= 0 ? '+' : ''}${previous.scoreDelta} / ${previous.thresholdShift >= 0 ? '+' : ''}${previous.thresholdShift}${scoreDeltaChange || thresholdDeltaChange ? ` · drift ${scoreDeltaChange >= 0 ? '+' : ''}${scoreDeltaChange}/${thresholdDeltaChange >= 0 ? '+' : ''}${thresholdDeltaChange}` : ''}`;
}

export function buildIdeaRadarDailyChecklist(
  candidates: IdeaRadarGuideCandidate[],
  evaluationSummary: { calibrationFlags: string[]; coefficientSuggestions: string[] } | null,
): string[] {
  const ja = isJapaneseLocale();
  const swingLead = pickTopGuideCandidate(candidates, ['1d', '1w']);
  const tacticalLead = pickTopGuideCandidate(candidates, ['10m', '1h']);
  return [
    ja ? '1d -> 1w -> 1h -> 10m の順で見る。' : 'Review in the order 1d -> 1w -> 1h -> 10m.',
    swingLead
      ? ja
        ? `最初は ${swingLead.symbol} ${swingLead.horizon} ${swingLead.stance} を確認する。`
        : `Start with ${swingLead.symbol} ${swingLead.horizon} ${swingLead.stance}.`
      : ja
        ? '最初は 1d / 1w の候補から確認する。'
        : 'Start with the 1d / 1w candidates.',
    tacticalLead
      ? ja
        ? `短期は ${tacticalLead.symbol} ${tacticalLead.horizon} を最後に補助確認する。`
        : `Use ${tacticalLead.symbol} ${tacticalLead.horizon} as the short-horizon cross-check.`
      : ja
        ? '10m / 1h は最後に補助確認する。'
        : 'Use 10m / 1h last as supporting confirmation.',
    evaluationSummary?.calibrationFlags.length
      ? ja
        ? `結果レビューでは ${evaluationSummary.calibrationFlags[0]} を優先確認する。`
        : `Prioritize ${evaluationSummary.calibrationFlags[0]} in Outcome Review.`
      : ja
        ? '結果レビューでは hit mix と By horizon を確認する。'
        : 'Use Outcome Review to inspect hit mix and By horizon.',
    evaluationSummary?.coefficientSuggestions.length
      ? ja
        ? `補正比較では ${evaluationSummary.coefficientSuggestions[0]} の影響を見る。`
        : `Use Calibration Compare to inspect ${evaluationSummary.coefficientSuggestions[0]}.`
      : ja
        ? '補正比較では horizon compare と stance compare を確認する。'
        : 'Use Calibration Compare to inspect horizon compare and stance compare.',
  ];
}

export function buildIdeaRadarBeginnerSummary(
  candidates: IdeaRadarGuideCandidate[],
  evaluationSummary: { calibrationFlags: string[]; stanceOutcomes: string[] } | null,
): string[] {
  const ja = isJapaneseLocale();
  const swingLead = pickTopGuideCandidate(candidates, ['1d', '1w']);
  const dayLead = pickTopGuideCandidate(candidates, ['1d']);
  const weekLead = pickTopGuideCandidate(candidates, ['1w']);
  const shortLead = pickTopGuideCandidate(candidates, ['10m', '1h']);
  const lines: string[] = [];
  lines.push(
    ja
      ? 'この面は「今の候補」と「最近その選び方が当たっているか」を一緒に見るためのもの。'
      : 'This panel combines current candidates with recent evidence about whether the selection process is working.',
  );
  if (swingLead) {
    lines.push(
      ja
        ? `まず ${swingLead.symbol} ${swingLead.horizon} ${swingLead.stance} を見る。 score ${swingLead.score}。`
        : `Start with ${swingLead.symbol} ${swingLead.horizon} ${swingLead.stance}. Score ${swingLead.score}.`,
    );
  }
  if (dayLead && weekLead && dayLead.symbol !== weekLead.symbol) {
    lines.push(
      ja
        ? `1d の中心は ${dayLead.symbol}、1w の中心は ${weekLead.symbol}。`
        : `The 1d lead is ${dayLead.symbol}; the 1w lead is ${weekLead.symbol}.`,
    );
  }
  if (shortLead) {
    lines.push(
      ja
        ? `${shortLead.symbol} ${shortLead.horizon} は短期補助。単独では信用しすぎない。`
        : `${shortLead.symbol} ${shortLead.horizon} is a short-term assist. Do not rely on it alone.`,
    );
  } else {
    lines.push(
      ja
        ? '10m / 1h は補助。単独では信用しすぎない。'
        : 'Treat 10m / 1h as support signals rather than standalone conviction.',
    );
  }
  if (evaluationSummary?.calibrationFlags.length) {
    lines.push(
      ja
        ? `最近の注意点は ${evaluationSummary.calibrationFlags[0]}。`
        : `Current caution flag: ${evaluationSummary.calibrationFlags[0]}.`,
    );
  }
  if (evaluationSummary?.stanceOutcomes.length) {
    lines.push(`stance 実績は ${evaluationSummary.stanceOutcomes[0]} を起点に見る。`);
  }
  return lines;
}
