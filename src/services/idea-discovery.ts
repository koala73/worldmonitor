import type { MarketData } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
import type { MarketImplicationsData } from '@/services/market-implications';
import type {
  IdeaRadarReviewHistoryEntry,
  PersonalPortfolioExport,
  PersonalPortfolioTargets,
} from '@/services/personal-portfolio';
import type { StockBacktestResult } from '@/services/stock-backtest';
import type {
  AnalyzeStockResponse,
  EarningsEntry,
  GetHyperliquidFlowResponse,
  HyperliquidAssetFlow,
  ListEtfFlowsResponse,
  ListCryptoSectorsResponse,
  ListEarningsCalendarResponse,
  GetMarketBreadthHistoryResponse,
  GetSectorSummaryResponse,
  SectorPerformance,
  ListStablecoinMarketsResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import type {
  GetEconomicCalendarResponse,
} from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { NewsItem } from '@/types';
import { ENTITY_REGISTRY } from '../config/entities.ts';
import { isJapaneseLocale } from '@/utils/locale';

function isJa(): boolean { return isJapaneseLocale(); }

export interface IdeaCandidate {
  symbol: string;
  name: string;
  assetType: 'equity' | 'crypto';
  horizon: '10m' | '1h' | '1d' | '1w';
  stance: 'watch' | 'research' | 'starter-size only' | 'avoid';
  stanceReason?: string;
  score: number;
  whyNow: string;
  invalidator: string;
  drivers: string[];
  portfolioFitScore: number;
  portfolioFitRationale: string;
  scoreMix: Array<{
    label: string;
    pct: number;
  }>;
  themeStrength: {
    score: number;
    label: string;
    deltaFromHistory?: number;
    previousLabel?: string | null;
    basisChange?: string | null;
  };
  shortTermConfirmation?: {
    score: number;
    label: string;
    deltaFromHistory?: number;
    previousLabel?: string | null;
    basisChange?: string | null;
  };
  orderFlowRegime?: {
    score: number;
    label: string;
    deltaFromHistory?: number;
  };
  backtestConsistency?: {
    winRate: number | null;
    actionableSignals: number;
    deltaFromHistory?: number;
  };
  relatedNews: Array<{
    title: string;
    source: string;
    link: string;
    publishedAt: string;
  }>;
  sources: string[];
}

export interface IdeaRadarViewModel {
  generatedAt: string;
  candidates: IdeaCandidate[];
  candidatesByHorizon: Record<IdeaCandidate['horizon'], IdeaCandidate[]>;
  notes: string[];
  nextReviewHistory?: Record<string, IdeaRadarReviewHistoryEntry>;
}

interface BuildIdeaRadarOptions {
  markets: MarketData[];
  predictions: PredictionMarket[];
  portfolio: PersonalPortfolioExport | null;
  portfolioTargets?: PersonalPortfolioTargets | null;
  reviewHistory?: Record<string, IdeaRadarReviewHistoryEntry> | null;
  watchlistSymbols?: string[];
  implications: MarketImplicationsData | null;
  regimeContext?: {
    compositeScore: number;
    compositeLabel: string;
    cnnFearGreed?: number;
  } | null;
  backtests?: StockBacktestResult[];
  etfFlows?: ListEtfFlowsResponse | null;
  stablecoinMarkets?: ListStablecoinMarketsResponse | null;
  cryptoSectors?: ListCryptoSectorsResponse | null;
  hyperliquidFlow?: GetHyperliquidFlowResponse | null;
  stockAnalyses?: Record<string, AnalyzeStockResponse>;
  sectorSummary?: GetSectorSummaryResponse | null;
  marketBreadth?: GetMarketBreadthHistoryResponse | null;
  earningsCalendar?: ListEarningsCalendarResponse | null;
  economicCalendar?: GetEconomicCalendarResponse | null;
  news?: NewsItem[];
}

const SCORE_MIX_LABELS = {
  inflation: 'Inflation',
  labor: 'Labor',
  consumer: 'Consumer',
  policy: 'Policy',
  macro: 'Macro',
  flow: 'Flow',
  earnings: 'Earnings',
  breadth: 'Breadth',
  peer: 'Peer',
  momentum: 'Momentum',
  portfolio: 'Portfolio',
} as const;

const CRYPTO_KEYWORDS = [
  { symbol: 'BTC', name: 'Bitcoin', match: /\b(bitcoin|btc)\b/i },
  { symbol: 'ETH', name: 'Ethereum', match: /\b(ethereum|eth)\b/i },
  { symbol: 'SOL', name: 'Solana', match: /\b(solana|sol)\b/i },
];
const CRYPTO_TICKER_SET = new Set(CRYPTO_KEYWORDS.map((asset) => asset.symbol));
const ENTITY_SECTOR_MAP: Record<string, string> = Object.fromEntries(
  ENTITY_REGISTRY
    .filter((entry) => entry.type === 'company' && entry.sector)
    .map((entry) => [normalizeTicker(entry.id), entry.sector as string]),
);
const ENTITY_RELATED_MAP: Record<string, string[]> = Object.fromEntries(
  ENTITY_REGISTRY
    .filter((entry) => (entry.type === 'company' || entry.type === 'crypto') && entry.related?.length)
    .map((entry) => [normalizeTicker(entry.id), (entry.related ?? []).map((related) => normalizeTicker(related))]),
);
const ENTITY_NAME_MAP: Record<string, string> = Object.fromEntries(
  ENTITY_REGISTRY.map((entry) => [normalizeTicker(entry.id), entry.name]),
);
const ENTITY_ALIAS_MAP: Record<string, string[]> = Object.fromEntries(
  ENTITY_REGISTRY.map((entry) => [normalizeTicker(entry.id), [entry.name, ...(entry.aliases ?? [])].map((alias) => alias.toLowerCase())]),
);
const ENTITY_KEYWORD_MAP: Record<string, string[]> = Object.fromEntries(
  ENTITY_REGISTRY.map((entry) => [normalizeTicker(entry.id), (entry.keywords ?? []).map((keyword) => keyword.toLowerCase())]),
);
const REGISTRY_KEY_BY_SYMBOL: Record<string, string> = Object.fromEntries(
  ENTITY_REGISTRY.flatMap((entry) => {
    const key = normalizeTicker(entry.id);
    const symbols = new Set<string>([key, normalizeTicker(entry.name)]);
    for (const alias of entry.aliases ?? []) symbols.add(normalizeTicker(alias));
    return [...symbols].filter(Boolean).map((symbol) => [symbol, key] as const);
  }),
);
const CRYPTO_REGISTRY_BY_SYMBOL: Record<string, string> = {
  BTC: 'BITCOIN',
  ETH: 'ETHEREUM',
  SOL: 'SOLANA',
};
const EQUITY_SECTOR_MAP: Record<string, string> = {
  ...ENTITY_SECTOR_MAP,
  AMD: 'Technology',
  PLTR: 'Technology',
  QCOM: 'Technology',
  GS: 'Finance',
  CVX: 'Energy',
  PFE: 'Healthcare',
};
const HORIZON_ORDER: IdeaCandidate['horizon'][] = ['10m', '1h', '1d', '1w'];
const SEMICONDUCTOR_TICKERS = new Set(['NVDA', 'AMD', 'TSM', 'ASML', 'SOXX', 'SMH', 'SOXL', 'AVGO']);
const HORIZON_LABELS: Record<IdeaCandidate['horizon'], string> = {
  '10m': '10-minute',
  '1h': '1-hour',
  '1d': '1-day',
  '1w': '1-week',
};

interface HorizonScoreInputs {
  positiveBias: number;
  momentumScore?: number;
  confidenceScore?: number;
  regimeScore?: number;
  backtestScore?: number;
  predictionScore?: number;
}

const HORIZON_WEIGHT_PROFILES: Record<IdeaCandidate['horizon'], {
  momentum: number;
  confidence: number;
  regime: number;
  backtest: number;
  prediction: number;
}> = {
  '10m': { momentum: 1.3, confidence: 0.4, regime: 0.2, backtest: 0.2, prediction: 0.1 },
  '1h': { momentum: 1.0, confidence: 0.7, regime: 0.6, backtest: 0.4, prediction: 0.5 },
  '1d': { momentum: 0.5, confidence: 1.0, regime: 1.0, backtest: 0.8, prediction: 0.6 },
  '1w': { momentum: 0.2, confidence: 0.9, regime: 0.8, backtest: 1.0, prediction: 1.0 },
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeTicker(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function normalizeWatchlistSymbols(symbols: string[] | undefined): Set<string> {
  return new Set((symbols ?? []).map((symbol) => normalizeTicker(symbol)).filter(Boolean));
}

function translateOverlayDirection(value: string | null | undefined): string {
  const v = (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'inflow' || v === 'net_inflow') return isJa() ? '流入優勢' : 'Net inflow';
  if (v === 'outflow' || v === 'net_outflow') return isJa() ? '流出優勢' : 'Net outflow';
  if (v === 'mixed' || v === 'net_mixed') return isJa() ? '方向感まちまち' : 'Mixed';
  if (v === 'neutral' || v === 'net_neutral') return isJa() ? '中立' : 'Neutral';
  return value || (isJa() ? '不明' : 'Unknown');
}

function translateStablecoinHealth(value: string | null | undefined): string {
  switch ((value ?? '').toLowerCase()) {
    case 'healthy':
      return isJa() ? '概ね安定' : 'HEALTHY';
    case 'watch':
      return isJa() ? '要監視' : 'WATCH';
    case 'stressed':
      return isJa() ? '不安定' : 'STRESSED';
    case 'unknown':
      return isJa() ? '不明' : 'UNKNOWN';
    default:
      return value || (isJa() ? '不明' : 'UNKNOWN');
  }
}

function buildHeldTickers(portfolio: PersonalPortfolioExport | null): Set<string> {
  return new Set((portfolio?.holdings ?? []).map((holding) => normalizeTicker(holding.ticker)));
}

function buildWatchlistCatalyst(
  watchlistSymbols: Set<string>,
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  if (!watchlistSymbols.has(symbol)) return { scoreDelta: 0, driver: null };
  return {
    scoreDelta: 5,
    driver: 'On your watchlist, so the idea is easier to prioritize.',
  };
}

function inferDriverCluster(candidate: Pick<IdeaCandidate, 'assetType' | 'sources' | 'drivers'>): string {
  const text = candidate.drivers.join(' ').toLowerCase();
  if (text.includes('fomc context') || text.includes('macro surprise')) return 'macro-fed';
  if (text.includes('earnings cluster') || text.includes('earnings catalyst')) return 'earnings';
  if (text.includes('sector breadth')) return 'breadth';
  if (text.includes('on-chain proxy') || text.includes('stablecoin health') || text.includes('crypto breadth')) return 'crypto-liquidity';
  if (text.includes('prediction market edge')) return 'prediction';
  if (text.includes('short-horizon tape') || text.includes('price move')) return 'tape';
  return `${candidate.assetType}:${candidate.sources[0] ?? 'general'}`;
}

function inferThesisFamily(candidate: Pick<IdeaCandidate, 'assetType' | 'symbol' | 'sources' | 'drivers'>): string {
  const cluster = inferDriverCluster(candidate);
  const text = candidate.drivers.join(' ').toLowerCase();

  if (SEMICONDUCTOR_TICKERS.has(candidate.symbol) || /(ai infra|ai capex|semiconductor|chip|foundry|networking leverage)/i.test(text)) {
    return 'ai-semiconductor';
  }
  if (candidate.assetType === 'crypto') {
    if (candidate.symbol === 'BTC') {
      return 'crypto-etf-liquidity';
    }
    if (/(defi|dex|staking|lending|yield farming|total value locked|tvl)/i.test(text)) {
      return 'crypto-defi';
    }
    if (
      /(infra|infrastructure|rollup|validator|throughput|scaling|sequencer)/i.test(text)
      || ['SOL'].includes(candidate.symbol)
    ) {
      return 'crypto-infrastructure';
    }
    if (
      /(layer 1|ethereum|solana|blockchain|smart-contract|smart contract|base layer)/i.test(text)
      || ['ETH'].includes(candidate.symbol)
    ) {
      return 'crypto-layer1';
    }
    if (
      /(etf flow regime|bitcoin etf|spot etf|stablecoin health|on-chain proxy|easier-path repricing)/i.test(text)
    ) {
      return 'crypto-etf-liquidity';
    }
  }
  if (/(healthcare|pharma|drug|glp-1|obesity|medical)/i.test(text) || ['LLY', 'UNH', 'JNJ', 'NVO', 'PFE'].includes(candidate.symbol)) {
    return 'healthcare-growth';
  }
  if (/(oil|gas|opec|lng|energy|drilling|refinery)/i.test(text) || ['XOM', 'CVX'].includes(candidate.symbol)) {
    return 'energy-supply';
  }
  if (/(cloud|services|software|platform|enterprise)/i.test(text) || ['MSFT', 'GOOGL', 'AMZN', 'ORCL', 'CRM', 'AAPL'].includes(candidate.symbol)) {
    return 'platform-software';
  }
  if (cluster === 'macro-fed') return candidate.assetType === 'crypto' ? 'macro-liquidity-crypto' : 'macro-liquidity-equity';
  if (cluster === 'earnings' || cluster === 'breadth') return candidate.assetType === 'crypto' ? 'market-structure-crypto' : 'market-structure-equity';
  if (cluster === 'crypto-liquidity') return 'crypto-liquidity';
  if (cluster === 'prediction') return candidate.assetType === 'crypto' ? 'crypto-risk-appetite' : 'equity-risk-appetite';
  if (cluster === 'tape') return 'short-horizon-momentum';
  return `${candidate.assetType}-general`;
}

function buildScoreMix(
  candidate: {
    drivers: IdeaCandidate['drivers'];
    assetType: IdeaCandidate['assetType'];
    horizon: IdeaCandidate['horizon'];
    thesisFamily?: string;
  }
): IdeaCandidate['scoreMix'] {
  const weights = {
    inflation: 0,
    labor: 0,
    consumer: 0,
    policy: 0,
    macro: 0,
    flow: 0,
    earnings: 0,
    breadth: 0,
    peer: 0,
    momentum: 0,
    portfolio: 0,
  };

  for (const driver of candidate.drivers) {
    const text = driver.toLowerCase();
    if (/\[inflation\]/.test(text)) {
      weights.inflation += 16;
    } else if (/\[labor\]/.test(text)) {
      weights.labor += 16;
    } else if (/\[consumer\]/.test(text)) {
      weights.consumer += 16;
    } else if (/\[policy\]/.test(text)) {
      weights.policy += 16;
    } else if (/fomc context|macro surprise|macro catalyst|macro regime|\[macro\]/.test(text)) {
      weights.macro += 16;
    }
    if (/etf flow regime|stablecoin health|on-chain proxy|prediction market edge|prediction market volume|order-flow:|contract horizon/.test(text)) weights.flow += 16;
    if (/earnings catalyst|earnings cluster|eps delta/.test(text)) weights.earnings += 16;
    if (/sector breadth|market breadth|crypto breadth/.test(text)) weights.breadth += 14;
    if (/peer confirmation|peer news confirmation/.test(text)) weights.peer += 14;
    if (/price move|short-horizon tape/.test(text)) weights.momentum += 16;
    if (/portfolio fit|personal rule|watchlist|same stance and score band|same driver cluster|same thesis family/.test(text)) weights.portfolio += 10;
  }

  switch (candidate.thesisFamily) {
    case 'ai-semiconductor':
      weights.earnings += 8;
      weights.breadth += 10;
      break;
    case 'platform-software':
      weights.policy += 4;
      weights.macro += 2;
      weights.peer += 8;
      break;
    case 'energy-supply':
      weights.inflation += 6;
      weights.policy += 4;
      weights.breadth += 6;
      break;
    case 'crypto-etf-liquidity':
      weights.flow += 14;
      weights.policy += 5;
      weights.macro += 3;
      break;
    case 'crypto-layer1':
      weights.flow += 8;
      weights.policy += 2;
      weights.macro += 2;
      weights.peer += 8;
      break;
    case 'crypto-infrastructure':
      weights.peer += 10;
      weights.breadth += 8;
      break;
    case 'crypto-defi':
      weights.flow += 10;
      weights.policy += 2;
      weights.macro += 4;
      break;
    default:
      break;
  }

  if (candidate.horizon === '10m') {
    weights.momentum += 8;
    weights.peer += 4;
    weights.flow += 6;
  } else if (candidate.horizon === '1h') {
    weights.momentum += 5;
    weights.flow += 5;
    weights.peer += 3;
  } else if (candidate.horizon === '1w') {
    weights.earnings += 4;
    weights.breadth += 4;
    weights.policy += 3;
  }

  const entries = Object.entries(weights)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return [];

  return entries
    .slice(0, 3)
    .map(([key, value]) => ({
      label: SCORE_MIX_LABELS[key as keyof typeof SCORE_MIX_LABELS],
      pct: Math.round((value / total) * 100),
    }));
}

function buildThemeStrength(
  horizon: IdeaCandidate['horizon'],
  drivers: string[],
  scoreMix: IdeaCandidate['scoreMix'],
  orderFlowRegime?: IdeaCandidate['orderFlowRegime'],
  backtestConsistency?: IdeaCandidate['backtestConsistency'],
): IdeaCandidate['themeStrength'] {
  const macroPct = scoreMix
    .filter((item) => ['Inflation', 'Labor', 'Consumer', 'Policy', 'Macro'].includes(item.label))
    .reduce((sum, item) => sum + item.pct, 0);
  const flowPct = scoreMix
    .filter((item) => item.label === 'Flow')
    .reduce((sum, item) => sum + item.pct, 0);
  const earningsPct = scoreMix
    .filter((item) => item.label === 'Earnings')
    .reduce((sum, item) => sum + item.pct, 0);
  const peerPct = scoreMix
    .filter((item) => item.label === 'Peer')
    .reduce((sum, item) => sum + item.pct, 0);
  const breadthPct = scoreMix
    .filter((item) => item.label === 'Breadth')
    .reduce((sum, item) => sum + item.pct, 0);
  const macroDriver = drivers.some((driver) => /macro surprise|macro catalyst|fomc context/i.test(driver));
  const flowDriver = drivers.some((driver) => /etf flow regime|stablecoin health|on-chain proxy|prediction market edge|prediction market volume|order-flow:/i.test(driver));
  const earningsDriver = drivers.some((driver) => /earnings catalyst|earnings cluster|earnings reported today/i.test(driver));
  const peerDriver = drivers.some((driver) => /peer confirmation|peer news confirmation/i.test(driver));
  const backtestDriver = drivers.some((driver) => /backtest win rate/i.test(driver));
  const backtestBonus = backtestConsistency?.winRate != null
    ? Math.max(
        0,
        Math.round((backtestConsistency.winRate - 50) * 0.35)
          + Math.min(6, Math.round((backtestConsistency.actionableSignals ?? 0) * 0.4))
      )
    : 0;
  const orderFlowBonus = orderFlowRegime
    ? horizon === '10m' || horizon === '1h'
      ? Math.round(orderFlowRegime.score * 0.22)
      : Math.round(orderFlowRegime.score * 0.12)
    : 0;

  const horizonThresholds = horizon === '10m'
    ? { confirmed: 76, building: 52 }
    : horizon === '1h'
      ? { confirmed: 66, building: 44 }
      : horizon === '1d'
        ? { confirmed: 58, building: 38 }
        : { confirmed: 55, building: 35 };

  const score = Math.min(
    100,
    macroPct
      + peerPct
      + Math.round(breadthPct * 0.5)
      + Math.round(flowPct * 0.6)
      + Math.round(earningsPct * 0.6)
      + (macroDriver ? 8 : 0)
      + (peerDriver ? 8 : 0)
      + (flowDriver ? 6 : 0)
      + (earningsDriver ? 6 : 0)
      + (backtestDriver ? 6 : 0)
      + backtestBonus
      + orderFlowBonus
  );
  const label = score >= horizonThresholds.confirmed
    ? 'Confirmed'
    : score >= horizonThresholds.building
      ? 'Building'
      : 'Fragile';
  return { score, label };
}

function buildShortTermConfirmation(
  horizon: IdeaCandidate['horizon'],
  drivers: string[],
  scoreMix: IdeaCandidate['scoreMix'],
): IdeaCandidate['shortTermConfirmation'] {
  if (horizon !== '10m' && horizon !== '1h') return undefined;

  const momentumPct = scoreMix
    .filter((item) => item.label === 'Momentum')
    .reduce((sum, item) => sum + item.pct, 0);
  const peerPct = scoreMix
    .filter((item) => item.label === 'Peer')
    .reduce((sum, item) => sum + item.pct, 0);
  const breadthPct = scoreMix
    .filter((item) => item.label === 'Breadth')
    .reduce((sum, item) => sum + item.pct, 0);
  const macroPct = scoreMix
    .filter((item) => ['Inflation', 'Labor', 'Consumer', 'Policy', 'Macro'].includes(item.label))
    .reduce((sum, item) => sum + item.pct, 0);
  const flowPct = scoreMix
    .filter((item) => item.label === 'Flow')
    .reduce((sum, item) => sum + item.pct, 0);

  const tapeDriver = drivers.some((driver) => /short-horizon tape/i.test(driver));
  const constructiveDrift = drivers.some((driver) => /closing drift \+|follow-through/i.test(driver));
  const weakPeer = drivers.some((driver) => /peer confirmation is weak/i.test(driver));
  const peerDriver = drivers.some((driver) => /peer confirmation:|peer news confirmation:/i.test(driver));
  const breadthDriver = drivers.some((driver) => /sector breadth:/i.test(driver));
  const macroDriver = drivers.some((driver) => /macro surprise|macro catalyst|fomc context/i.test(driver));
  const flowDriver = drivers.some((driver) => /prediction market volume|order-flow:|etf flow regime|stablecoin health|on-chain proxy/i.test(driver));

  const thresholds = horizon === '10m'
    ? { tight: 60, developing: 36 }
    : { tight: 54, developing: 32 };

  const score = clampScore(
    Math.round(momentumPct * 0.8)
      + Math.round(peerPct * 0.9)
      + Math.round(breadthPct * 0.45)
      + Math.round(macroPct * 0.35)
      + Math.round(flowPct * 0.3)
      + (tapeDriver ? 8 : 0)
      + (constructiveDrift ? 6 : 0)
      + (peerDriver ? 8 : 0)
      + (breadthDriver ? 5 : 0)
      + (macroDriver ? 4 : 0)
      + (flowDriver ? 5 : 0)
      - (weakPeer ? 8 : 0),
  );

  const label = score >= thresholds.tight
    ? 'Tight'
    : score >= thresholds.developing
      ? 'Developing'
      : 'Thin';

  return { score, label };
}

function buildReviewLoopCatalyst(
  history: Record<string, IdeaRadarReviewHistoryEntry>,
  symbol: string,
  horizon: IdeaCandidate['horizon'],
  stance: IdeaCandidate['stance'],
  score: number,
  driverCluster: string,
  thesisFamily: string,
  scoreMix: IdeaCandidate['scoreMix'],
  themeStrength: IdeaCandidate['themeStrength'],
  shortTermConfirmation: IdeaCandidate['shortTermConfirmation'],
  orderFlowRegime: IdeaCandidate['orderFlowRegime'],
  backtestConsistency: IdeaCandidate['backtestConsistency'],
): { scoreDelta: number; driver: string | null } {
  const horizonKey = `${symbol}:${horizon}`;
  const entry = history[horizonKey] ?? history[symbol];
  if (!entry) return { scoreDelta: 0, driver: null };
  const currentBand = score >= 75 ? 'strong' : score >= 60 ? 'actionable' : score >= 45 ? 'developing' : 'weak';
  const sameStance = entry.lastStance === stance;
  const sameBand = entry.scoreBand === currentBand;
  const sameCluster = !!entry.driverCluster && entry.driverCluster === driverCluster;
  const sameFamily = !!entry.thesisFamily && entry.thesisFamily === thesisFamily;
  const previousMixLabels = new Set((entry.scoreMix ?? []).map((item) => item.label));
  const currentMixLabels = new Set(scoreMix.map((item) => item.label));
  const sharedMixCount = [...currentMixLabels].filter((label) => previousMixLabels.has(label)).length;
  const previousMixMap = new Map((entry.scoreMix ?? []).map((item) => [item.label, item.pct]));
  const totalPctDrift = scoreMix.reduce((sum, item) => {
    const previousPct = previousMixMap.get(item.label);
    return sum + (previousPct == null ? item.pct : Math.abs(previousPct - item.pct));
  }, 0);
  const driftThreshold = horizon === '10m' ? 18 : horizon === '1h' ? 22 : horizon === '1d' ? 26 : 30;
  const mixShiftedByLabel = sameFamily && previousMixLabels.size > 0 && sharedMixCount < Math.min(2, previousMixLabels.size, currentMixLabels.size);
  const mixShiftedByWeight = sameFamily && sharedMixCount >= 2 && totalPctDrift >= driftThreshold;
  const mixShifted = mixShiftedByLabel || mixShiftedByWeight;
  const driftCredit = mixShiftedByWeight
    ? totalPctDrift >= driftThreshold + 18
      ? 2
      : 1
    : 0;
  const previousThemeScore = entry.themeStrength?.score ?? 0;
  const previousThemeLabel = entry.themeStrength?.label ?? '';
  const previousShortTermScore = entry.shortTermConfirmation?.score ?? 0;
  const previousShortTermLabel = entry.shortTermConfirmation?.label ?? '';
  const previousOrderFlowScore = entry.orderFlowRegime?.score ?? 0;
  const previousOrderFlowLabel = entry.orderFlowRegime?.label ?? '';
  const previousBacktestWinRate = entry.backtestConsistency?.winRate ?? null;
  const themeStrengthImproved =
    sameFamily
    && (
      themeStrength.score >= previousThemeScore + 10
      || (previousThemeLabel === 'Fragile' && themeStrength.label !== 'Fragile')
      || (previousThemeLabel === 'Building' && themeStrength.label === 'Confirmed')
    );
  const backtestImproved =
    sameFamily
    && typeof previousBacktestWinRate === 'number'
    && typeof backtestConsistency?.winRate === 'number'
    && backtestConsistency.winRate >= previousBacktestWinRate + 5;
  const shortTermImproved =
    sameFamily
    && shortTermConfirmation != null
    && (
      shortTermConfirmation.score >= previousShortTermScore + 10
      || (previousShortTermLabel === 'Thin' && shortTermConfirmation.label !== 'Thin')
      || (previousShortTermLabel === 'Developing' && shortTermConfirmation.label === 'Tight')
    );
  const orderFlowImproved =
    sameFamily
    && orderFlowRegime != null
    && (
      orderFlowRegime.score >= previousOrderFlowScore + 8
      || (previousOrderFlowLabel === 'Fragile' && orderFlowRegime.label !== 'Fragile')
      || (previousOrderFlowLabel === 'Mixed' && /Constructive|Strong/.test(orderFlowRegime.label))
      || (previousOrderFlowLabel === 'Constructive' && orderFlowRegime.label === 'Strong')
    );
  const coupledImprovement = sameFamily && themeStrengthImproved && orderFlowImproved;
  const tripleImprovement = sameFamily && themeStrengthImproved && orderFlowImproved && backtestImproved;
  const coupledCredit = coupledImprovement
    ? horizon === '1w'
      ? 2
      : 1
    : 0;
  const tripleCredit = tripleImprovement
    ? horizon === '10m'
      ? 1
      : horizon === '1h'
        ? 2
        : 3
    : 0;
  const stagnating = sameStance && sameBand;
  const recalibrationCredit = sameFamily && !stagnating
    ? driftCredit + coupledCredit + tripleCredit
    : 0;
  if (entry.count >= 5) {
    const baseDelta = stagnating ? -7 : sameCluster ? -6 : sameFamily ? (mixShifted ? -3 : -5) : -4;
    return {
      scoreDelta: (themeStrengthImproved || shortTermImproved || orderFlowImproved || backtestImproved) && sameFamily && !stagnating
        ? Math.min(0, baseDelta + (themeStrengthImproved ? 2 : 0) + (shortTermImproved ? 1 : 0) + (orderFlowImproved ? 1 : 0) + (backtestImproved ? 1 : 0) + recalibrationCredit)
        : baseDelta,
      driver: `Recurring idea: surfaced ${entry.count} times recently in ${HORIZON_LABELS[horizon]}${stagnating ? ', with the same stance and score band' : sameCluster ? ', around the same driver cluster' : sameFamily ? tripleImprovement ? ', around the same thesis family but with stronger theme confirmation, order-flow, and backtest consistency' : coupledImprovement ? ', around the same thesis family but with stronger theme confirmation and order-flow' : themeStrengthImproved ? ', around the same thesis family but with stronger theme confirmation' : shortTermImproved ? ', around the same thesis family but with tighter short-horizon confirmation' : orderFlowImproved ? ', around the same thesis family but with a stronger order-flow regime' : backtestImproved ? ', around the same thesis family but with stronger backtest consistency' : mixShifted ? ', around the same thesis family but with a shifted signal mix' : ', around the same thesis family' : ''}.`,
    };
  }
  if (entry.count >= 3) {
    const baseDelta = stagnating ? -4 : sameCluster ? -3 : sameFamily ? (mixShifted ? -1 : -2) : -1;
    return {
      scoreDelta: (themeStrengthImproved || shortTermImproved || orderFlowImproved || backtestImproved) && sameFamily && !stagnating
        ? Math.min(0, baseDelta + 1 + recalibrationCredit)
        : baseDelta,
      driver: `Recurring idea: surfaced ${entry.count} times recently in ${HORIZON_LABELS[horizon]}${stagnating ? ', with limited score progression' : sameCluster ? ', around the same driver cluster' : sameFamily ? tripleImprovement ? ', around the same thesis family but with stronger theme confirmation, order-flow, and backtest consistency' : coupledImprovement ? ', around the same thesis family but with stronger theme confirmation and order-flow' : themeStrengthImproved ? ', around the same thesis family but with stronger theme confirmation' : shortTermImproved ? ', around the same thesis family but with tighter short-horizon confirmation' : orderFlowImproved ? ', around the same thesis family but with a stronger order-flow regime' : backtestImproved ? ', around the same thesis family but with stronger backtest consistency' : mixShifted ? ', around the same thesis family but with a shifted signal mix' : ', around the same thesis family' : ''}.`,
    };
  }
  return {
    scoreDelta: 0,
    driver: entry.count >= 2 ? `Recent review memory: seen ${entry.count} times in ${HORIZON_LABELS[horizon]}.` : null,
  };
}

function hasCryptoExposure(portfolio: PersonalPortfolioExport | null): boolean {
  return (portfolio?.holdings ?? []).some((holding) => CRYPTO_TICKER_SET.has(normalizeTicker(holding.ticker)));
}

function hasSemiconductorExposure(portfolio: PersonalPortfolioExport | null): boolean {
  return (portfolio?.holdings ?? []).some((holding) => SEMICONDUCTOR_TICKERS.has(normalizeTicker(holding.ticker)));
}

function getAssetClassWeight(
  portfolio: PersonalPortfolioExport,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
  assetClass: string,
): number {
  return buildCurrentAllocationByClass(portfolio, portfolioTargets).get(assetClass) ?? 0;
}

function getSemiconductorWeight(portfolio: PersonalPortfolioExport): number {
  return portfolio.holdings
    .filter((holding) => SEMICONDUCTOR_TICKERS.has(normalizeTicker(holding.ticker)))
    .reduce((sum, holding) => sum + holding.weight_pct, 0);
}

function rankStance(score: number): IdeaCandidate['stance'] {
  if (score >= 75) return 'research';
  if (score >= 60) return 'watch';
  if (score >= 45) return 'starter-size only';
  return 'avoid';
}

function finalizeStance(
  score: number,
  assetType: IdeaCandidate['assetType'],
  horizon: IdeaCandidate['horizon'],
  themeStrength: IdeaCandidate['themeStrength'],
  shortTermConfirmation: IdeaCandidate['shortTermConfirmation'],
  orderFlowRegime: IdeaCandidate['orderFlowRegime'],
): IdeaCandidate['stance'] {
  let adjusted = score;

  if (themeStrength.label === 'Confirmed') adjusted += 4;
  else if (themeStrength.label === 'Fragile') adjusted -= 3;

  if ((horizon === '10m' || horizon === '1h') && shortTermConfirmation) {
    if (shortTermConfirmation.label === 'Tight') adjusted += 5;
    else if (shortTermConfirmation.label === 'Thin') adjusted -= 5;
  }

  if (assetType === 'crypto' && orderFlowRegime) {
    if (orderFlowRegime.label === 'Strong') adjusted += horizon === '10m' || horizon === '1h' ? 6 : 4;
    else if (orderFlowRegime.label === 'Constructive') adjusted += 3;
    else if (orderFlowRegime.label === 'Fragile') adjusted -= 4;
  }

  return rankStance(clampScore(adjusted));
}

function buildStanceReason(
  assetType: IdeaCandidate['assetType'],
  horizon: IdeaCandidate['horizon'],
  themeStrength: IdeaCandidate['themeStrength'],
  shortTermConfirmation: IdeaCandidate['shortTermConfirmation'],
  orderFlowRegime: IdeaCandidate['orderFlowRegime'],
  scoreMix: IdeaCandidate['scoreMix'],
  extras?: {
    themeDelta?: number;
    shortTermDelta?: number;
    orderFlowDelta?: number;
    backtestDelta?: number;
  },
): string {
  const stateReasons: string[] = [];
  const deltaReasons: string[] = [];
  const primaryMix = scoreMix.slice(0, 2).map((item) => `${item.label.toLowerCase()} ${item.pct}%`);
  if (themeStrength.label === 'Confirmed') stateReasons.push('confirmed theme');
  else if (themeStrength.label === 'Fragile') stateReasons.push('fragile theme');
  else stateReasons.push(`theme ${themeStrength.label.toLowerCase()}`);

  if ((horizon === '10m' || horizon === '1h') && shortTermConfirmation) {
    if (shortTermConfirmation.label === 'Tight') stateReasons.push('tight short-term confirmation');
    else if (shortTermConfirmation.label === 'Thin') stateReasons.push('thin short-term confirmation');
    else stateReasons.push(`short ${shortTermConfirmation.label.toLowerCase()}`);
  }

  if (assetType === 'crypto' && orderFlowRegime) {
    if (orderFlowRegime.label === 'Strong') stateReasons.push('strong order-flow');
    else if (orderFlowRegime.label === 'Constructive') stateReasons.push('constructive order-flow');
    else if (orderFlowRegime.label === 'Fragile') stateReasons.push('fragile order-flow');
    else stateReasons.push(`flow ${orderFlowRegime.label.toLowerCase()}`);
  }

  if (primaryMix.length) stateReasons.push(`mix ${primaryMix.join(' + ')}`);
  if ((extras?.themeDelta ?? 0) > 0) deltaReasons.push(`theme +${extras!.themeDelta}`);
  if ((extras?.shortTermDelta ?? 0) > 0) deltaReasons.push(`short +${extras!.shortTermDelta}`);
  if ((extras?.orderFlowDelta ?? 0) > 0) deltaReasons.push(`flow +${extras!.orderFlowDelta}`);
  if ((extras?.backtestDelta ?? 0) > 0) deltaReasons.push(`backtest +${extras!.backtestDelta}`);

  const stateText = stateReasons.length ? `state ${stateReasons.join(' · ')}` : '';
  const deltaText = deltaReasons.length ? `delta ${deltaReasons.join(' · ')}` : '';
  return [stateText, deltaText].filter(Boolean).join(' / ') || 'base score only';
}

function buildShiftIntensity(
  themeBasisChange: string | null | undefined,
  shortTermBasisChange: string | null | undefined,
  horizon: IdeaCandidate['horizon'],
): { scoreDelta: number; label: 'none' | 'single' | 'dual' } {
  const count = [themeBasisChange, shortTermBasisChange].filter(Boolean).length;
  if (count >= 2) {
    const scoreDelta = horizon === '10m' ? 2 : horizon === '1h' ? 2 : horizon === '1d' ? 3 : 4;
    return { scoreDelta, label: 'dual' };
  }
  if (count === 1) {
    const scoreDelta = horizon === '10m' ? 0 : horizon === '1h' ? 1 : horizon === '1d' ? 1 : 2;
    return { scoreDelta, label: 'single' };
  }
  return { scoreDelta: 0, label: 'none' };
}

function rawBacktestScore(backtests: StockBacktestResult[] | undefined, symbol: string): number {
  const match = backtests?.find((item) => normalizeTicker(item.symbol) === symbol);
  if (!match?.available) return 0;
  if (match.winRate >= 60) return 12;
  if (match.winRate >= 55) return 8;
  if (match.winRate >= 45) return 3;
  return -8;
}

function buildBacktestConsistency(
  backtests: StockBacktestResult[] | undefined,
  symbol: string,
  previousEntry?: IdeaRadarReviewHistoryEntry,
): IdeaCandidate['backtestConsistency'] {
  const match = backtests?.find((item) => normalizeTicker(item.symbol) === symbol);
  if (!match?.available) return { winRate: null, actionableSignals: 0, deltaFromHistory: undefined };
  const previousWinRate = previousEntry?.backtestConsistency?.winRate;
  return {
    winRate: match.winRate,
    actionableSignals: match.actionableEvaluations,
    deltaFromHistory: typeof previousWinRate === 'number' ? match.winRate - previousWinRate : undefined,
  };
}

function rawRegimeScore(
  regimeContext: BuildIdeaRadarOptions['regimeContext'],
  assetType: IdeaCandidate['assetType'],
  positiveMomentum: boolean,
): number {
  if (!regimeContext) return 0;
  const composite = regimeContext.compositeScore ?? 0;
  if (assetType === 'crypto') {
    if (composite >= 65 && positiveMomentum) return 10;
    if (composite <= 35) return -12;
    return 0;
  }
  if (composite >= 60 && positiveMomentum) return 8;
  if (composite <= 35 && positiveMomentum) return -10;
  return 0;
}

function rawConfidenceScore(confidence: string): number {
  const value = confidence.trim().toUpperCase();
  if (value === 'HIGH') return 20;
  if (value === 'MEDIUM') return 10;
  if (value === 'LOW') return 0;
  return 5;
}

function rawMomentumScore(change: number): number {
  return Math.min(Math.abs(change) * 6, 25);
}

function computeSparklineRangePct(points: number[] | undefined): number {
  if (!points?.length) return 0;
  const finite = points.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return 0;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const last = finite[finite.length - 1] ?? 0;
  if (!last || min <= 0) return 0;
  return ((max - min) / last) * 100;
}

function computeSparklineDriftPct(points: number[] | undefined): number {
  if (!points?.length || points.length < 2) return 0;
  const first = points[0] ?? 0;
  const last = points[points.length - 1] ?? 0;
  if (!first || !Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return ((last - first) / first) * 100;
}

function rawPredictionScore(yesPrice: number | undefined): number {
  return Math.abs((yesPrice ?? 50) - 50) / 2;
}

function daysUntil(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const ms = Date.parse(`${dateStr}T00:00:00`);
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - Date.now()) / 86_400_000);
}

function parseNumericField(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[%,$\s,]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function rawCryptoFlowScore(
  etfFlows: ListEtfFlowsResponse | null | undefined,
  stablecoinMarkets: ListStablecoinMarketsResponse | null | undefined,
): number {
  let score = 0;
  const netDirection = etfFlows?.summary?.netDirection?.toUpperCase() ?? '';
  if (netDirection.includes('INFLOW')) score += 10;
  else if (netDirection.includes('OUTFLOW')) score -= 10;

  const stableHealth = stablecoinMarkets?.summary?.healthStatus?.toUpperCase() ?? '';
  if (stableHealth === 'HEALTHY') score += 8;
  else if (stableHealth === 'CAUTION') score += 2;
  else if (stableHealth) score -= 8;

  const depeggedCount = stablecoinMarkets?.summary?.depeggedCount ?? 0;
  if (depeggedCount >= 2) score -= 6;

  return score;
}

function buildCryptoFlowDrivers(
  etfFlows: ListEtfFlowsResponse | null | undefined,
  stablecoinMarkets: ListStablecoinMarketsResponse | null | undefined,
): string[] {
  const drivers: string[] = [];
  const etfSummary = etfFlows?.summary;
  if (etfSummary) {
    drivers.push(`ETF flow regime ${etfSummary.netDirection || 'neutral'} with est. flow ${Math.round(etfSummary.totalEstFlow || 0)}.`);
  }
  const stableSummary = stablecoinMarkets?.summary;
  if (stableSummary) {
    drivers.push(`Stablecoin health ${stableSummary.healthStatus || 'unknown'} with ${stableSummary.depeggedCount} depegs.`);
  }
  return drivers;
}

function buildPredictionVolumeCatalyst(
  prediction: PredictionMarket,
): { scoreDelta: number; driver: string | null } {
  const volume = prediction.volume ?? 0;
  if (!Number.isFinite(volume) || volume <= 0) return { scoreDelta: 0, driver: null };
  if (volume >= 1_000_000) {
    return { scoreDelta: 8, driver: `Prediction market volume is heavy at ${Math.round(volume).toLocaleString()}.` };
  }
  if (volume >= 250_000) {
    return { scoreDelta: 5, driver: `Prediction market volume is active at ${Math.round(volume).toLocaleString()}.` };
  }
  if (volume >= 50_000) {
    return { scoreDelta: 2, driver: `Prediction market volume is building at ${Math.round(volume).toLocaleString()}.` };
  }
  return { scoreDelta: 0, driver: null };
}

function findHyperliquidAssetFlow(
  hyperliquidFlow: GetHyperliquidFlowResponse | null | undefined,
  symbol: string,
): HyperliquidAssetFlow | null {
  const normalized = normalizeTicker(symbol);
  return hyperliquidFlow?.assets?.find((asset) => normalizeTicker(asset.symbol) === normalized) ?? null;
}

function buildHyperliquidFlowCatalyst(
  hyperliquidFlow: GetHyperliquidFlowResponse | null | undefined,
  symbol: string,
  horizon: IdeaCandidate['horizon'],
): { scoreDelta: number; driver: string | null } {
  const asset = findHyperliquidAssetFlow(hyperliquidFlow, symbol);
  if (!asset) return { scoreDelta: 0, driver: null };

  let scoreDelta = 0;
  const parts: string[] = [];
  if (asset.composite >= 70) {
    scoreDelta += horizon === '10m' || horizon === '1h' ? 8 : 5;
    parts.push(`composite ${asset.composite}`);
  } else if (asset.composite >= 55) {
    scoreDelta += horizon === '10m' || horizon === '1h' ? 5 : 3;
    parts.push(`composite ${asset.composite}`);
  } else if (asset.composite <= 30) {
    scoreDelta -= 6;
    parts.push(`composite ${asset.composite}`);
  }

  if (asset.volumeScore >= 65) {
    scoreDelta += 4;
    parts.push(`volume score ${asset.volumeScore}`);
  } else if (asset.volumeScore <= 35) {
    scoreDelta -= 3;
    parts.push(`volume score ${asset.volumeScore}`);
  }

  if (asset.oiScore >= 60) {
    scoreDelta += 3;
    parts.push(`OI score ${asset.oiScore}`);
  }
  if (asset.basisScore >= 60) {
    scoreDelta += 2;
    parts.push(`basis score ${asset.basisScore}`);
  } else if (asset.basisScore <= 30) {
    scoreDelta -= 2;
    parts.push(`basis score ${asset.basisScore}`);
  }

  const alerts = asset.alerts ?? [];
  if (alerts.some((alert) => /flow[_ ]drop|divergence|stress|liquidation/i.test(alert))) {
    scoreDelta -= 4;
    parts.push(`alerts ${alerts.slice(0, 2).join(', ')}`);
  }

  return {
    scoreDelta,
    driver: parts.length
      ? `Order-flow: ${asset.display || asset.symbol} ${parts.join(', ')}.`
      : null,
  };
}

function buildOrderFlowRegime(
  hyperliquidFlow: GetHyperliquidFlowResponse | null | undefined,
  symbol: string,
  previousEntry?: IdeaRadarReviewHistoryEntry,
): IdeaCandidate['orderFlowRegime'] {
  const asset = findHyperliquidAssetFlow(hyperliquidFlow, symbol);
  if (!asset) return undefined;
  const score = asset.composite;
  const label = score >= 70 ? 'Strong' : score >= 55 ? 'Constructive' : score >= 40 ? 'Mixed' : 'Fragile';
  const previousScore = previousEntry?.orderFlowRegime?.score;
  return {
    score,
    label,
    deltaFromHistory: typeof previousScore === 'number' ? score - previousScore : undefined,
  };
}

function buildEquityVolumeCatalyst(
  analysis: AnalyzeStockResponse | null | undefined,
  horizon: IdeaCandidate['horizon'],
): { scoreDelta: number; driver: string | null } {
  if (!analysis?.available || (horizon !== '10m' && horizon !== '1h')) return { scoreDelta: 0, driver: null };
  const parts: string[] = [];
  let scoreDelta = 0;

  if (analysis.volumeRatio5d >= 2) {
    scoreDelta += 7;
    parts.push(`volume ratio ${analysis.volumeRatio5d.toFixed(1)}x`);
  } else if (analysis.volumeRatio5d >= 1.3) {
    scoreDelta += 4;
    parts.push(`volume ratio ${analysis.volumeRatio5d.toFixed(1)}x`);
  } else if (analysis.volumeRatio5d <= 0.8) {
    scoreDelta -= 3;
    parts.push(`volume ratio ${analysis.volumeRatio5d.toFixed(1)}x`);
  }

  if (analysis.volumeStatus) {
    if (/heavy|surging|elevated/i.test(analysis.volumeStatus)) scoreDelta += 3;
    if (/light|thin|weak/i.test(analysis.volumeStatus)) scoreDelta -= 2;
    parts.push(`volume ${analysis.volumeStatus}`);
  }

  return {
    scoreDelta,
    driver: parts.length ? `Volume confirmation: ${parts.join(', ')}.` : null,
  };
}

function describeBasisChange(
  previousMix: IdeaRadarReviewHistoryEntry['scoreMix'] | undefined,
  currentMix: IdeaCandidate['scoreMix'],
  focusLabels?: string[],
  horizon?: IdeaCandidate['horizon'],
): string | null {
  if (!previousMix?.length || !currentMix.length) return null;
  const current = focusLabels?.length ? currentMix.filter((item) => focusLabels.includes(item.label)) : currentMix;
  const previous = focusLabels?.length ? previousMix.filter((item) => focusLabels.includes(item.label)) : previousMix;
  if (!current.length || !previous.length) return null;
  const driftThreshold = horizon === '10m' ? 6 : horizon === '1h' ? 7 : horizon === '1d' ? 8 : 10;
  const previousMap = new Map(previous.map((item) => [item.label, item.pct]));
  const driftEntries = current
    .map((item) => ({
      label: item.label,
      drift: item.pct - (previousMap.get(item.label) ?? 0),
    }))
    .filter((item) => Math.abs(item.drift) >= driftThreshold)
    .sort((left, right) => Math.abs(right.drift) - Math.abs(left.drift));

  const prevTop = previous[0];
  const currTop = current[0];
  if (!prevTop || !currTop) return null;
  const parts: string[] = [];
  if (prevTop.label !== currTop.label) {
    parts.push(`${prevTop.label} -> ${currTop.label}`);
  }
  for (const entry of driftEntries.slice(0, 2)) {
    parts.push(`${entry.label} ${entry.drift >= 0 ? '+' : ''}${entry.drift}%`);
  }
  return parts.length ? parts.join(' · ') : null;
}

function buildOnChainProxyCatalyst(
  stablecoinMarkets: ListStablecoinMarketsResponse | null | undefined,
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  if (!CRYPTO_TICKER_SET.has(symbol)) return { scoreDelta: 0, driver: null };
  const summary = stablecoinMarkets?.summary;
  const stables = stablecoinMarkets?.stablecoins ?? [];
  if (!summary && stables.length === 0) return { scoreDelta: 0, driver: null };

  const majorStables = stables.filter((coin) => ['USDT', 'USDC', 'DAI'].includes(normalizeTicker(coin.symbol)));
  const avgDeviation = majorStables.length
    ? majorStables.reduce((sum, coin) => sum + Math.abs(coin.deviation ?? 0), 0) / majorStables.length
    : 0;
  const avgChange24h = majorStables.length
    ? majorStables.reduce((sum, coin) => sum + (coin.change24h ?? 0), 0) / majorStables.length
    : 0;
  const totalStableVolume = majorStables.reduce((sum, coin) => sum + (coin.volume24h ?? 0), 0);

  let scoreDelta = 0;
  const parts: string[] = [];

  if ((summary?.healthStatus || '').toUpperCase() === 'HEALTHY' && summary && summary.depeggedCount === 0) {
    scoreDelta += 4;
    parts.push('stablecoin plumbing is healthy');
  } else if ((summary?.depeggedCount ?? 0) >= 2 || avgDeviation >= 0.01) {
    scoreDelta -= 8;
    parts.push('stablecoin stress is elevated');
  }

  if (avgChange24h >= 0.5) {
    scoreDelta += 3;
    parts.push(`major stable supply is expanding ${avgChange24h >= 0 ? '+' : ''}${avgChange24h.toFixed(1)}%`);
  } else if (avgChange24h <= -0.5) {
    scoreDelta -= 3;
    parts.push(`major stable supply is contracting ${avgChange24h.toFixed(1)}%`);
  }

  if (totalStableVolume >= 10_000_000_000) {
    scoreDelta += 2;
    parts.push(`liquidity proxy volume ${Math.round(totalStableVolume / 1_000_000_000)}B`);
  }

  return {
    scoreDelta,
    driver: parts.length ? `On-chain proxy: ${parts.join(', ')}.` : null,
  };
}

function buildPortfolioFit(
  portfolio: PersonalPortfolioExport | null,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
  symbol: string,
  assetType: IdeaCandidate['assetType'],
): { score: number; rationale: string } {
  if (!portfolio) {
    return { score: 50, rationale: 'Portfolio context unavailable.' };
  }

  let score = 60;
  const reasons: string[] = ['New symbol not currently held.'];
  const usdWeight = portfolio.currency.find((entry) => entry.currency === 'USD')?.weight_pct ?? 0;
  const cryptoExposure = hasCryptoExposure(portfolio);
  const semiconductorExposure = hasSemiconductorExposure(portfolio);
  const activeRulePenalty = portfolio.risk_rules.some((rule) => !rule.ok && rule.severity === 'alert') ? 2 : 0;

  if (activeRulePenalty > 0) {
    score -= activeRulePenalty;
    reasons.push('Existing alert-level risk rules mildly reduce room for new positions.');
  }

  if (assetType === 'crypto') {
    if (cryptoExposure) {
      score -= 15;
      reasons.push('Adds to existing crypto exposure.');
    } else {
      score += 10;
      reasons.push('Introduces a new crypto sleeve.');
    }
  }

  if (SEMICONDUCTOR_TICKERS.has(symbol)) {
    if (semiconductorExposure) {
      score -= 12;
      reasons.push('Overlaps with existing semiconductor exposure.');
    } else {
      score += 8;
      reasons.push('Adds semiconductor exposure without an existing position.');
    }
  }

  if (assetType === 'equity' && usdWeight >= 50) {
    score -= 8;
    reasons.push(`USD exposure is already ${usdWeight.toFixed(1)}%.`);
  } else if (assetType === 'equity' && usdWeight < 35) {
    score += 6;
    reasons.push('USD exposure remains moderate.');
  }

  const targetFit = buildTargetAllocationFit(portfolio, portfolioTargets, symbol, assetType);
  const riskBudgetFit = buildRiskBudgetFit(portfolio, portfolioTargets, symbol, assetType);
  score += targetFit.scoreDelta;
  score += riskBudgetFit.scoreDelta;
  reasons.push(targetFit.rationale);
  reasons.push(riskBudgetFit.rationale);

  return {
    score: clampScore(score),
    rationale: reasons.join(' '),
  };
}

function findUpcomingEarnings(
  earningsCalendar: ListEarningsCalendarResponse | null | undefined,
  symbol: string,
): EarningsEntry | null {
  const earnings = earningsCalendar?.earnings ?? [];
  const normalized = normalizeTicker(symbol);
  return earnings.find((entry) => normalizeTicker(entry.symbol) === normalized) ?? null;
}

function buildEarningsCatalyst(
  earningsCalendar: ListEarningsCalendarResponse | null | undefined,
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  const match = findUpcomingEarnings(earningsCalendar, symbol);
  if (!match) return { scoreDelta: 0, driver: null };

  const days = daysUntil(match.date);
  const timing = days == null ? match.date : days <= 0 ? 'today' : `in ${days}d`;
  if (match.hasActuals) {
    const epsEstimate = parseNumericField(match.epsEstimate);
    const epsActual = parseNumericField(match.epsActual);
    const epsDelta = epsEstimate != null && epsActual != null ? epsActual - epsEstimate : null;
    return {
      scoreDelta: match.surpriseDirection === 'beat' ? 10 : match.surpriseDirection === 'miss' ? -8 : 4,
      driver: `Earnings reported ${timing} (${match.surpriseDirection || 'in line'}${epsDelta != null ? `, EPS delta ${epsDelta >= 0 ? '+' : ''}${epsDelta.toFixed(2)}` : ''}).`,
    };
  }

  const hour = match.hour ? ` ${match.hour.toUpperCase()}` : '';
  return {
    scoreDelta: days != null && days <= 7 ? 6 : 3,
    driver: `Earnings catalyst ${timing}${hour} for ${match.company || symbol}.`,
  };
}

function buildSectorEarningsClusterCatalyst(
  earningsCalendar: ListEarningsCalendarResponse | null | undefined,
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  const sectorName = EQUITY_SECTOR_MAP[normalizeTicker(symbol)];
  if (!sectorName) return { scoreDelta: 0, driver: null };

  const related = (earningsCalendar?.earnings ?? [])
    .filter((entry) => {
      const entrySector = EQUITY_SECTOR_MAP[normalizeTicker(entry.symbol)];
      if (entrySector !== sectorName) return false;
      const days = daysUntil(entry.date);
      return days != null && days >= -3 && days <= 3;
    });

  if (related.length < 2) return { scoreDelta: 0, driver: null };

  const beats = related.filter((entry) => entry.hasActuals && entry.surpriseDirection === 'beat').length;
  const misses = related.filter((entry) => entry.hasActuals && entry.surpriseDirection === 'miss').length;
  const upcoming = related.filter((entry) => !entry.hasActuals).length;

  if (beats === 0 && misses === 0) {
    return {
      scoreDelta: upcoming >= 2 ? 3 : 0,
      driver: upcoming >= 2 ? `${sectorName} earnings cluster has ${upcoming} nearby reports pending.` : null,
    };
  }

  if (beats >= 2 && beats > misses) {
    return {
      scoreDelta: 8,
      driver: `${sectorName} earnings cluster is supportive: ${beats} beats vs ${misses} misses.`,
    };
  }

  if (misses >= 2 && misses >= beats) {
    return {
      scoreDelta: -8,
      driver: `${sectorName} earnings cluster is weak: ${misses} misses vs ${beats} beats.`,
    };
  }

  return {
    scoreDelta: 2,
    driver: `${sectorName} earnings cluster is mixed: ${beats} beats, ${misses} misses.`,
  };
}

function buildMacroCatalyst(
  economicCalendar: GetEconomicCalendarResponse | null | undefined,
  assetType: IdeaCandidate['assetType'],
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  const events = (economicCalendar?.events ?? [])
    .filter((event) => (event.impact || '').toLowerCase() === 'high')
    .map((event) => ({ event, days: daysUntil(event.date) }))
    .filter((item) => item.days != null && item.days >= 0 && item.days <= 7);

  if (!events.length) return { scoreDelta: 0, driver: null };

  const candidateClass = inferCandidateAssetClass(symbol, assetType);
  const relevant = events.find(({ event }) => {
    if (assetType === 'crypto') return event.country === 'US';
    if (candidateClass === 'us_equity') return event.country === 'US';
    if (candidateClass === 'jp_equity') return event.country === 'JP' || event.country === 'US';
    return false;
  });
  if (!relevant) return { scoreDelta: 0, driver: null };
  const eventName = relevant.event.event.toLowerCase();
  const evidence = eventName.includes('cpi') || eventName.includes('pce') || eventName.includes('inflation') || eventName.includes('ppi')
    ? 'inflation'
    : eventName.includes('nonfarm') || eventName.includes('payroll') || /\bnfp\b/.test(eventName) || eventName.includes('jobs') || eventName.includes('claims')
      ? 'labor'
      : eventName.includes('retail sales')
        ? 'consumer'
        : eventName.includes('rate decision') || eventName.includes('fomc') || eventName.includes('fed funds') || eventName.includes('interest rate')
          ? 'policy'
          : 'macro';

  return {
    scoreDelta: 4,
    driver: `Macro catalyst in ${relevant.days}d: ${relevant.event.country} ${relevant.event.event} [${evidence}].`,
  };
}

function buildMacroSurpriseCatalyst(
  economicCalendar: GetEconomicCalendarResponse | null | undefined,
  assetType: IdeaCandidate['assetType'],
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  const candidateClass = inferCandidateAssetClass(symbol, assetType);
  const recent = (economicCalendar?.events ?? [])
    .filter((event) => (event.impact || '').toLowerCase() === 'high')
    .map((event) => ({ event, days: daysUntil(event.date) }))
    .filter((item) => item.days != null && item.days >= -2 && item.days <= 1);

  const relevant = recent.find(({ event }) => {
    if (assetType === 'crypto') return event.country === 'US';
    if (candidateClass === 'us_equity') return event.country === 'US';
    if (candidateClass === 'jp_equity') return event.country === 'JP' || event.country === 'US';
    return false;
  });
  if (!relevant) return { scoreDelta: 0, driver: null };

  const name = relevant.event.event.toLowerCase();
  const actual = parseNumericField(relevant.event.actual);
  const estimate = parseNumericField(relevant.event.estimate);
  if (actual == null || estimate == null) return { scoreDelta: 0, driver: null };

  if (name.includes('cpi') || name.includes('pce') || name.includes('inflation')) {
    const cooler = actual < estimate;
    return {
      scoreDelta: cooler ? 6 : -6,
      driver: `Macro surprise: ${relevant.event.event} came in ${cooler ? 'cooler' : 'hotter'} than expected (${actual} vs ${estimate}) [inflation].`,
    };
  }

  if (name.includes('ppi')) {
    const cooler = actual < estimate;
    return {
      scoreDelta: cooler ? 4 : -4,
      driver: `Macro surprise: ${relevant.event.event} printed ${cooler ? 'below' : 'above'} forecast (${actual} vs ${estimate}) [inflation].`,
    };
  }

  if (name.includes('nonfarm') || name.includes('payroll') || /\bnfp\b/.test(name) || name.includes('jobs')) {
    const stronger = actual > estimate;
    return {
      scoreDelta: stronger ? 5 : -5,
      driver: `Macro surprise: ${relevant.event.event} was ${stronger ? 'stronger' : 'softer'} than expected (${actual} vs ${estimate}) [labor].`,
    };
  }

  if (name.includes('jobless claims') || name.includes('initial claims') || name.includes('continuing claims')) {
    const better = actual < estimate;
    return {
      scoreDelta: better ? 4 : -4,
      driver: `Macro surprise: ${relevant.event.event} came in ${better ? 'below' : 'above'} forecast (${actual} vs ${estimate}) [labor].`,
    };
  }

  if (name.includes('retail sales')) {
    const stronger = actual > estimate;
    return {
      scoreDelta: stronger ? 5 : -5,
      driver: `Macro surprise: ${relevant.event.event} was ${stronger ? 'stronger' : 'weaker'} than expected (${actual} vs ${estimate}) [consumer].`,
    };
  }

  if (name.includes('rate decision') || name.includes('fomc') || name.includes('fed funds') || name.includes('interest rate')) {
    const dovish = actual < estimate;
    return {
      scoreDelta: dovish ? 6 : -6,
      driver: `Macro surprise: ${relevant.event.event} was ${dovish ? 'more dovish' : 'more hawkish'} than expected (${actual} vs ${estimate}) [policy].`,
    };
  }

  return { scoreDelta: 0, driver: null };
}

function findSectorBreadth(
  sectorSummary: GetSectorSummaryResponse | null | undefined,
  symbol: string,
): SectorPerformance | null {
  const sectorName = EQUITY_SECTOR_MAP[normalizeTicker(symbol)];
  if (!sectorName) return null;
  return sectorSummary?.sectors?.find((sector) => sector.name.toLowerCase() === sectorName.toLowerCase()) ?? null;
}

function buildSectorBreadthCatalyst(
  sectorSummary: GetSectorSummaryResponse | null | undefined,
  marketBreadth: GetMarketBreadthHistoryResponse | null | undefined,
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  const sector = findSectorBreadth(sectorSummary, symbol);
  const breadth50d = marketBreadth?.currentPctAbove50d ?? null;
  if (!sector && breadth50d == null) return { scoreDelta: 0, driver: null };

  let scoreDelta = 0;
  const parts: string[] = [];

  if (sector) {
    if (sector.change >= 1.5) {
      scoreDelta += 6;
      parts.push(`${sector.name} breadth is strong at ${sector.change.toFixed(1)}%.`);
    } else if (sector.change <= -1) {
      scoreDelta -= 6;
      parts.push(`${sector.name} breadth is weak at ${sector.change.toFixed(1)}%.`);
    } else {
      parts.push(`${sector.name} breadth is mixed at ${sector.change.toFixed(1)}%.`);
    }
  }

  if (breadth50d != null) {
    if (breadth50d >= 65) {
      scoreDelta += 4;
      parts.push(`${breadth50d.toFixed(1)}% of stocks remain above the 50-day average.`);
    } else if (breadth50d <= 40) {
      scoreDelta -= 4;
      parts.push(`Only ${breadth50d.toFixed(1)}% of stocks are above the 50-day average.`);
    }
  }

  return {
    scoreDelta,
    driver: parts.length ? `Sector breadth: ${parts.join(' ')}` : null,
  };
}

function resolveRegistryKey(symbol: string): string {
  const normalized = normalizeTicker(symbol);
  return CRYPTO_REGISTRY_BY_SYMBOL[normalized] ?? REGISTRY_KEY_BY_SYMBOL[normalized] ?? normalized;
}

function buildPeerConfirmationCatalyst(
  markets: MarketData[] | undefined,
  symbol: string,
  positiveBias: boolean,
): { scoreDelta: number; driver: string | null } {
  const peerSymbols = ENTITY_RELATED_MAP[resolveRegistryKey(symbol)] ?? [];
  if (!peerSymbols.length || !markets?.length) return { scoreDelta: 0, driver: null };

  const marketBySymbol = new Map<string, MarketData>();
  for (const market of markets) {
    marketBySymbol.set(normalizeTicker(market.symbol), market);
    marketBySymbol.set(resolveRegistryKey(market.symbol), market);
  }
  const peers = peerSymbols
    .map((peer) => marketBySymbol.get(peer))
    .filter((market): market is MarketData => !!market && typeof market.change === 'number');

  if (!peers.length) return { scoreDelta: 0, driver: null };

  const alignedPeers = peers.filter((peer) => positiveBias ? (peer.change ?? 0) >= 1 : (peer.change ?? 0) <= -1);
  const opposedPeers = peers.filter((peer) => positiveBias ? (peer.change ?? 0) <= -1 : (peer.change ?? 0) >= 1);
  const describePeerDepth = (items: MarketData[]): { bonus: number; note: string } => {
    const peerRanges = items
      .map((peer) => computeSparklineRangePct(peer.sparkline))
      .filter((value) => value > 0);
    const peerDrifts = items
      .map((peer) => computeSparklineDriftPct(peer.sparkline))
      .filter((value) => positiveBias ? value > 0 : value < 0);
    const avgRange = peerRanges.length ? peerRanges.reduce((sum, value) => sum + value, 0) / peerRanges.length : 0;
    const avgDriftAbs = peerDrifts.length
      ? peerDrifts.reduce((sum, value) => sum + Math.abs(value), 0) / peerDrifts.length
      : 0;

    if (avgRange >= 2.2 && avgDriftAbs >= 0.8) {
      return {
        bonus: 2,
        note: ` with broad follow-through (${avgRange.toFixed(1)}% peer range, ${positiveBias ? '+' : '-'}${avgDriftAbs.toFixed(1)}% drift)`,
      };
    }
    if (avgRange >= 1.5 || avgDriftAbs >= 0.6) {
      return {
        bonus: 1,
        note: ` with decent peer depth (${avgRange.toFixed(1)}% range)`,
      };
    }
    return { bonus: 0, note: '' };
  };

  if (alignedPeers.length >= 2) {
    const depth = describePeerDepth(alignedPeers);
    return {
      scoreDelta: 5 + depth.bonus,
      driver: `Peer confirmation: ${alignedPeers.slice(0, 3).map((peer) => `${normalizeTicker(peer.symbol)} ${peer.change?.toFixed(1)}%`).join(', ')} confirm the move${depth.note}.`,
    };
  }

  if (opposedPeers.length >= 2) {
    return {
      scoreDelta: -4,
      driver: `Peer confirmation is weak: ${opposedPeers.slice(0, 3).map((peer) => `${normalizeTicker(peer.symbol)} ${peer.change?.toFixed(1)}%`).join(', ')} move the other way.`,
    };
  }

  if (alignedPeers.length === 1) {
    const depth = describePeerDepth(alignedPeers);
    const firstPeer = alignedPeers[0]!;
    return {
      scoreDelta: 2 + depth.bonus,
      driver: `Peer confirmation: ${normalizeTicker(firstPeer.symbol)} ${firstPeer.change?.toFixed(1)}% supports the setup${depth.note}.`,
    };
  }

  return { scoreDelta: 0, driver: null };
}

function buildPeerNewsConfirmationCatalyst(
  news: NewsItem[] | undefined,
  symbol: string,
  narrativeText = '',
): { scoreDelta: number; driver: string | null } {
  const registryKey = resolveRegistryKey(symbol);
  const peerSymbols = ENTITY_RELATED_MAP[registryKey] ?? [];
  if (!peerSymbols.length || !news?.length) return { scoreDelta: 0, driver: null };
  const candidateKeywords = [
    ...(ENTITY_KEYWORD_MAP[registryKey] ?? []),
    ...narrativeText
      .toLowerCase()
      .split(/[^a-z0-9+-]+/)
      .filter((token) => token.length >= 4),
  ];

  const activePeers = peerSymbols
    .map((peer) => {
      const aliases = ENTITY_ALIAS_MAP[peer] ?? [peer.toLowerCase()];
      const peerKeywords = ENTITY_KEYWORD_MAP[peer] ?? [];
      const mentions = news.filter((item) => {
        if (Date.now() - item.pubDate.getTime() > 3 * 86_400_000) return false;
        const haystack = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
        return aliases.some((alias) => alias && haystack.includes(alias));
      });
      if (mentions.length === 0) return null;
      const sharedKeywords = [...new Set(candidateKeywords)].filter((keyword) => keyword.length >= 4 && (peerKeywords.includes(keyword) || mentions.some((item) => {
        const haystack = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
        return haystack.includes(keyword);
      })));
      const sharedNarrativeKeywords = sharedKeywords.filter((keyword) => mentions.some((item) => {
        const haystack = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
        return haystack.includes(keyword);
      }));
      return { peer, mentions, sharedNarrativeKeywords };
    })
    .filter((entry): entry is { peer: string; mentions: NewsItem[]; sharedNarrativeKeywords: string[] } => !!entry);

  const narrativePeers = activePeers.filter((entry) => entry.sharedNarrativeKeywords.length > 0);

  if (narrativePeers.length >= 2) {
    const keywords = [...new Set(narrativePeers.flatMap((entry) => entry.sharedNarrativeKeywords))].slice(0, 2);
    return {
      scoreDelta: 5,
      driver: `Peer news confirmation: ${narrativePeers.slice(0, 3).map(({ peer }) => ENTITY_NAME_MAP[peer] ?? peer).join(', ')} share the same narrative${keywords.length ? ` (${keywords.join(', ')})` : ''}.`,
    };
  }

  if (activePeers.length >= 2) {
    return {
      scoreDelta: 4,
      driver: `Peer news confirmation: ${activePeers.slice(0, 3).map(({ peer }) => ENTITY_NAME_MAP[peer] ?? peer).join(', ')} are also active in recent coverage.`,
    };
  }

  if (activePeers.length === 1) {
    const firstPeer = activePeers[0]!;
    return {
      scoreDelta: firstPeer.sharedNarrativeKeywords.length > 0 ? 3 : 2,
      driver: `Peer news confirmation: ${ENTITY_NAME_MAP[firstPeer.peer] ?? firstPeer.peer} is also active in recent coverage${firstPeer.sharedNarrativeKeywords.length ? ` around ${firstPeer.sharedNarrativeKeywords.slice(0, 2).join(', ')}` : ''}.`,
    };
  }

  return { scoreDelta: 0, driver: null };
}

function buildShortHorizonCatalyst(
  market: MarketData,
  horizon: IdeaCandidate['horizon'],
): { scoreDelta: number; driver: string | null } {
  if (horizon !== '10m' && horizon !== '1h') return { scoreDelta: 0, driver: null };
  const rangePct = computeSparklineRangePct(market.sparkline);
  const driftPct = computeSparklineDriftPct(market.sparkline);
  if (rangePct <= 0 && driftPct === 0) return { scoreDelta: 0, driver: null };

  let scoreDelta = 0;
  const parts: string[] = [];
  if (rangePct >= 3) {
    scoreDelta += 5;
    parts.push(`intraday range ${rangePct.toFixed(1)}%`);
  } else if (rangePct >= 1.5) {
    scoreDelta += 2;
    parts.push(`active tape with ${rangePct.toFixed(1)}% range`);
  }

  if (driftPct >= 1) {
    scoreDelta += 4;
    parts.push(`closing drift +${driftPct.toFixed(1)}%`);
  } else if (driftPct <= -1) {
    scoreDelta -= 4;
    parts.push(`closing drift ${driftPct.toFixed(1)}%`);
  }

  return {
    scoreDelta,
    driver: parts.length ? `Short-horizon tape: ${parts.join(', ')}.` : null,
  };
}

function buildCryptoSectorCatalyst(
  cryptoSectors: ListCryptoSectorsResponse | null | undefined,
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  const sectors = cryptoSectors?.sectors ?? [];
  if (!sectors.length) return { scoreDelta: 0, driver: null };

  const positiveCount = sectors.filter((sector) => sector.change > 0).length;
  const topSector = sectors.slice().sort((left, right) => right.change - left.change)[0] ?? null;
  const avgChange = sectors.reduce((sum, sector) => sum + sector.change, 0) / sectors.length;

  let scoreDelta = 0;
  if (avgChange >= 1.5) scoreDelta += 6;
  else if (avgChange >= 0.5) scoreDelta += 3;
  else if (avgChange <= -1) scoreDelta -= 6;

  if (symbol === 'SOL' && topSector && /(layer|smart|infra|l1)/i.test(topSector.name) && topSector.change > 0) {
    scoreDelta += 4;
  }
  if ((symbol === 'BTC' || symbol === 'ETH') && positiveCount >= Math.ceil(sectors.length / 2)) {
    scoreDelta += 3;
  }

  return {
    scoreDelta,
    driver: topSector
      ? `Crypto breadth: ${positiveCount}/${sectors.length} sectors green, leader ${topSector.name} ${topSector.change >= 0 ? '+' : ''}${topSector.change.toFixed(1)}%.`
      : null,
  };
}

function inferHoldingAssetClass(
  ticker: string,
  currency: string,
  tickerMap: Record<string, string> = {},
): string {
  const normalizedTicker = normalizeTicker(ticker);
  if (tickerMap[normalizedTicker]) return tickerMap[normalizedTicker];
  if (CRYPTO_TICKER_SET.has(normalizedTicker)) return 'crypto';
  if (/\.T$/.test(normalizedTicker) || /^\d{4,5}$/.test(normalizedTicker)) return 'jp_equity';
  if (currency.toUpperCase() === 'USD') return 'us_equity';
  return 'jp_equity';
}

function inferCandidateAssetClass(
  symbol: string,
  assetType: IdeaCandidate['assetType'],
): string {
  if (assetType === 'crypto') return 'crypto';
  if (/\.T$/.test(symbol) || /^\d{4,5}$/.test(symbol)) return 'jp_equity';
  return 'us_equity';
}

function buildCurrentAllocationByClass(
  portfolio: PersonalPortfolioExport,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
): Map<string, number> {
  const tickerMap = Object.fromEntries(
    Object.entries(portfolioTargets?.ticker_map ?? {}).map(([key, value]) => [normalizeTicker(key), value]),
  );
  const weights = new Map<string, number>();
  for (const holding of portfolio.holdings) {
    const assetClass = inferHoldingAssetClass(holding.ticker, holding.currency, tickerMap);
    weights.set(assetClass, (weights.get(assetClass) ?? 0) + holding.weight_pct);
  }
  return weights;
}

function buildTargetAllocationFit(
  portfolio: PersonalPortfolioExport,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
  symbol: string,
  assetType: IdeaCandidate['assetType'],
): { scoreDelta: number; rationale: string } {
  const allocations = portfolioTargets?.allocations ?? [];
  if (!allocations.length) {
    return { scoreDelta: 0, rationale: 'Target allocation unavailable.' };
  }

  const currentByClass = buildCurrentAllocationByClass(portfolio, portfolioTargets);
  const candidateClass = inferCandidateAssetClass(symbol, assetType);
  const matchedAllocation = allocations.find((item) => item.key === candidateClass);
  if (!matchedAllocation) {
    return { scoreDelta: -10, rationale: `No target allocation exists for ${candidateClass}.` };
  }

  const currentPct = currentByClass.get(candidateClass) ?? 0;
  const gap = matchedAllocation.target_pct - currentPct;
  if (gap >= 8) {
    return {
      scoreDelta: 14,
      rationale: `${matchedAllocation.label} is under target by ${gap.toFixed(1)} points.`,
    };
  }
  if (gap >= 3) {
    return {
      scoreDelta: 8,
      rationale: `${matchedAllocation.label} is modestly under target by ${gap.toFixed(1)} points.`,
    };
  }
  if (gap <= -8) {
    return {
      scoreDelta: -16,
      rationale: `${matchedAllocation.label} is already above target by ${Math.abs(gap).toFixed(1)} points.`,
    };
  }
  if (gap <= -3) {
    return {
      scoreDelta: -8,
      rationale: `${matchedAllocation.label} is slightly above target by ${Math.abs(gap).toFixed(1)} points.`,
    };
  }
  return {
    scoreDelta: 2,
    rationale: `${matchedAllocation.label} is close to its ${matchedAllocation.target_pct.toFixed(1)}% target.`,
  };
}

function buildRiskBudgetFit(
  portfolio: PersonalPortfolioExport,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
  symbol: string,
  assetType: IdeaCandidate['assetType'],
): { scoreDelta: number; rationale: string } {
  const reasons: string[] = [];
  let scoreDelta = 0;

  const topHoldingWeight = portfolio.holdings.reduce((max, holding) => Math.max(max, holding.weight_pct), 0);
  if (topHoldingWeight >= 35) {
    scoreDelta -= 12;
    reasons.push(`Top position is already ${topHoldingWeight.toFixed(1)}%.`);
  } else if (topHoldingWeight >= 25) {
    scoreDelta -= 6;
    reasons.push(`Top position is ${topHoldingWeight.toFixed(1)}%, so concentration room is limited.`);
  }

  const candidateClass = inferCandidateAssetClass(symbol, assetType);
  const usdWeight = portfolio.currency.find((entry) => entry.currency === 'USD')?.weight_pct ?? 0;
  if (assetType === 'equity' && candidateClass === 'us_equity') {
    if (usdWeight >= 65) {
      scoreDelta -= 12;
      reasons.push(`USD budget is already stretched at ${usdWeight.toFixed(1)}%.`);
    } else if (usdWeight >= 50) {
      scoreDelta -= 6;
      reasons.push(`USD exposure is already ${usdWeight.toFixed(1)}%.`);
    }
  }

  const cryptoWeight = getAssetClassWeight(portfolio, portfolioTargets, 'crypto');
  if (assetType === 'crypto') {
    if (cryptoWeight >= 15) {
      scoreDelta -= 16;
      reasons.push(`Crypto sleeve is already ${cryptoWeight.toFixed(1)}%.`);
    } else if (cryptoWeight >= 8) {
      scoreDelta -= 8;
      reasons.push(`Crypto sleeve already uses ${cryptoWeight.toFixed(1)}% of the portfolio.`);
    } else {
      scoreDelta += 4;
      reasons.push('Crypto sleeve remains sized for new ideas.');
    }
  }

  if (SEMICONDUCTOR_TICKERS.has(symbol)) {
    const semiconductorWeight = getSemiconductorWeight(portfolio);
    if (semiconductorWeight >= 35) {
      scoreDelta -= 14;
      reasons.push(`Semiconductor sleeve is already ${semiconductorWeight.toFixed(1)}%.`);
    } else if (semiconductorWeight >= 20) {
      scoreDelta -= 7;
      reasons.push(`Semiconductor sleeve is already ${semiconductorWeight.toFixed(1)}%.`);
    } else {
      scoreDelta += 3;
      reasons.push('Semiconductor sleeve still has room.');
    }
  }

  const classWeight = getAssetClassWeight(portfolio, portfolioTargets, candidateClass);
  if (classWeight >= 70) {
    scoreDelta -= 10;
    reasons.push(`${candidateClass} already dominates at ${classWeight.toFixed(1)}%.`);
  }

  if (reasons.length === 0) {
    reasons.push('Current budget pressures are manageable.');
  }

  return {
    scoreDelta,
    rationale: reasons.join(' '),
  };
}

function buildPersonalRuleCatalyst(
  portfolio: PersonalPortfolioExport | null,
  symbol: string,
  assetType: IdeaCandidate['assetType'],
): { scoreDelta: number; driver: string | null } {
  const activeRules = (portfolio?.risk_rules ?? []).filter((rule) => !rule.ok);
  if (!activeRules.length) return { scoreDelta: 0, driver: null };

  let scoreDelta = 0;
  const tags = new Set<string>();
  const text = activeRules.map((rule) => `${rule.name} ${rule.message}`.toLowerCase()).join(' ');
  const isUsdLinked = assetType === 'crypto' || inferCandidateAssetClass(symbol, assetType) === 'us_equity';

  if (text.includes('集中') || text.includes('concentration')) {
    scoreDelta -= assetType === 'crypto' ? 2 : 3;
    tags.add('concentration');
  }
  if (isUsdLinked && (text.includes('usd') || text.includes('為替') || text.includes('currency'))) {
    scoreDelta -= 2;
    tags.add('usd exposure');
  }
  if (assetType === 'crypto' && text.includes('crypto')) {
    scoreDelta -= 3;
    tags.add('crypto limit');
  }
  if (SEMICONDUCTOR_TICKERS.has(symbol) && (text.includes('semi') || text.includes('semiconductor') || text.includes('半導体'))) {
    scoreDelta -= 2;
    tags.add('semiconductor limit');
  }

  if (scoreDelta === 0) {
    scoreDelta -= 1;
    tags.add(`${activeRules.length} active personal rule${activeRules.length > 1 ? 's' : ''}`);
  }

  return {
    scoreDelta,
    driver: `Personal rule pressure: ${[...tags].join(', ')}.`,
  };
}

function collectFedSignalLabels(
  text: string,
): {
  tone: number;
  statementSignal: number;
  transcriptSignal: number;
  pricingShift: number;
  growthSupport: number;
  balanceSheetSignal: number;
  labels: string[];
} {
  const labels: string[] = [];
  let tone = 0;
  let statementSignal = 0;
  let transcriptSignal = 0;
  let pricingShift = 0;
  let growthSupport = 0;
  let balanceSheetSignal = 0;

  const addLabel = (label: string): void => {
    if (!labels.includes(label)) labels.push(label);
  };

  if (/(hawkish|higher for longer|no cuts|fewer cuts|sticky inflation|rate hike|yields rise|hotter)/i.test(text)) {
    tone -= 1;
    addLabel('hawkish bias');
  }
  if (/(dovish|rate cut|cuts ahead|cooling inflation|disinflation|easing|soft landing|yields fall)/i.test(text)) {
    tone += 1;
    addLabel('dovish bias');
  }
  if (/(dot plot|summary of economic projections|statement|press conference|powell said|powell signals|minutes|meeting minutes|transcript|prepared remarks|opening statement)/i.test(text)) {
    statementSignal += 1;
    addLabel('statement coverage');
  }
  if (/(transcript|meeting minutes|minutes showed|minutes revealed|prepared remarks|qa session|question and answer|press q&a)/i.test(text)) {
    transcriptSignal += 1;
    addLabel('minutes/transcript');
  }
  if (/(cuts priced out|market repric|terminal rate|higher terminal|dot plot.*higher|fewer cuts ahead|reduced cuts)/i.test(text)) {
    pricingShift -= 1;
    addLabel('higher-for-longer repricing');
  }
  if (/(more cuts than expected|earlier cuts|markets price in.*cuts|lower terminal rate|dot plot.*lower|yields.*fall sharply)/i.test(text)) {
    pricingShift += 1;
    addLabel('easier-path repricing');
  }
  if (/(soft landing|growth holds up|productivity|ai capex|risk assets supported)/i.test(text)) {
    growthSupport += 1;
    addLabel('growth support');
  }
  if (/(pause but hawkish|hold rates steady but|unchanged rates but warned|kept rates unchanged while)/i.test(text)) {
    tone -= 1;
    statementSignal += 1;
    addLabel('hawkish hold');
  }
  if (/(confident inflation is moving down|greater confidence on inflation|progress on inflation|labor market cooling|downside risks to growth|room to ease|prepared to cut)/i.test(text)) {
    tone += 1;
    statementSignal += 1;
    addLabel('inflation progress');
  }
  if (/(not confident on inflation|inflation remains too high|labor market remains tight|prepared to stay restrictive|upside inflation risks|no urgency to cut)/i.test(text)) {
    tone -= 1;
    statementSignal += 1;
    addLabel('restrictive guidance');
  }
  if (/(quantitative tightening|balance sheet runoff|runoff pace|tapering runoff|slower runoff|faster runoff)/i.test(text)) {
    balanceSheetSignal += 1;
    addLabel('balance-sheet runoff');
    if (/(slower runoff|tapering runoff|slowing quantitative tightening)/i.test(text)) {
      tone += 1;
      addLabel('slower QT');
    }
    if (/(faster runoff|accelerating runoff|maintain aggressive runoff)/i.test(text)) {
      tone -= 1;
      addLabel('faster QT');
    }
  }

  return {
    tone,
    statementSignal,
    transcriptSignal,
    pricingShift,
    growthSupport,
    balanceSheetSignal,
    labels,
  };
}

function buildFomcContextCatalyst(
  news: NewsItem[] | undefined,
  assetType: IdeaCandidate['assetType'],
  symbol: string,
): { scoreDelta: number; driver: string | null } {
  const candidateClass = inferCandidateAssetClass(symbol, assetType);
  const isUsdLinked = assetType === 'crypto' || candidateClass === 'us_equity' || candidateClass === 'jp_equity';
  if (!isUsdLinked || !news?.length) return { scoreDelta: 0, driver: null };

  const recentFedItems = news
    .filter((item) => {
      const text = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
      return /(fomc|federal reserve|fed |powell|rate decision|dot plot)/i.test(text);
    })
    .filter((item) => Date.now() - item.pubDate.getTime() <= 7 * 86_400_000)
    .slice(0, 4);

  if (!recentFedItems.length) return { scoreDelta: 0, driver: null };

  let tone = 0;
  let statementSignal = 0;
  let pricingShift = 0;
  let growthSupport = 0;
  let transcriptSignal = 0;
  let balanceSheetSignal = 0;
  const evidenceLabels = new Set<string>();
  for (const item of recentFedItems) {
    const text = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
    const signals = collectFedSignalLabels(text);
    tone += signals.tone;
    statementSignal += signals.statementSignal;
    transcriptSignal += signals.transcriptSignal;
    pricingShift += signals.pricingShift;
    growthSupport += signals.growthSupport;
    balanceSheetSignal += signals.balanceSheetSignal;
    for (const label of signals.labels) evidenceLabels.add(label);
  }

  const netTone = tone + growthSupport + pricingShift;

  if (netTone === 0) {
    return {
      scoreDelta: 0,
      driver: `FOMC context: ${recentFedItems.length} recent Fed items are mixed${statementSignal > 0 ? ', including statement or press-conference coverage' : ''}.`,
    };
  }

  const leaning = netTone > 0 ? 'dovish' : 'hawkish';
  const scoreDelta = (netTone > 0 ? 6 : -6)
    + (statementSignal > 0 ? (netTone > 0 ? 1 : -1) : 0)
    + (transcriptSignal > 0 ? (netTone > 0 ? 1 : -1) : 0)
    + (balanceSheetSignal > 0 ? (netTone > 0 ? 1 : -1) : 0)
    + (Math.abs(pricingShift) >= 1 ? (netTone > 0 ? 1 : -1) : 0);

  const descriptors: string[] = [];
  if (statementSignal > 0) descriptors.push('statement or press-conference language');
  if (transcriptSignal > 0) descriptors.push('minutes or transcript language');
  if (pricingShift !== 0) descriptors.push('rate-path repricing');
  if (balanceSheetSignal > 0) descriptors.push('balance-sheet runoff language');
  if (growthSupport > 0) descriptors.push('growth-supportive read-through');
  const evidence = [...evidenceLabels].slice(0, 3);

  return {
    scoreDelta,
    driver: `FOMC context: recent Fed coverage leans ${leaning} across ${recentFedItems.length} items${descriptors.length ? `, reinforced by ${descriptors.join(' and ')}` : ''}${evidence.length ? ` [${evidence.join(', ')}]` : ''}.`,
  };
}

function tokenizeCandidate(symbol: string, name: string, assetType: IdeaCandidate['assetType']): string[] {
  const tokens = new Set<string>([symbol.toLowerCase()]);
  for (const part of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 4) tokens.add(part);
  }
  if (assetType === 'crypto') {
    for (const asset of CRYPTO_KEYWORDS) {
      if (asset.symbol === symbol) {
        tokens.add(asset.name.toLowerCase());
      }
    }
  }
  return [...tokens];
}

function buildRelatedNews(
  news: NewsItem[] | undefined,
  symbol: string,
  name: string,
  assetType: IdeaCandidate['assetType'],
): IdeaCandidate['relatedNews'] {
  if (!news?.length) return [];
  const tokens = tokenizeCandidate(symbol, name, assetType);
  return news
    .filter((item) => {
      const haystack = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
      return tokens.some((token) => haystack.includes(token));
    })
    .sort((left, right) => right.pubDate.getTime() - left.pubDate.getTime())
    .slice(0, 2)
    .map((item) => ({
      title: item.title,
      source: item.source,
      link: item.link,
      publishedAt: item.pubDate.toISOString(),
    }));
}

function horizonFromTimeframe(timeframe: string): IdeaCandidate['horizon'] {
  const value = timeframe.toLowerCase();
  if (value.includes('10m') || value.includes('15m') || value.includes('30m')) return '10m';
  if (value.includes('intraday') || value.includes('hour') || value.includes('4h')) return '1h';
  if (value.includes('day') || value.includes('24h')) return '1d';
  if (value.includes('week')) return '1w';
  return '1d';
}

function horizonFromPredictionEndDate(endDate?: string): IdeaCandidate['horizon'] {
  if (!endDate) return '1w';
  const ms = Date.parse(endDate);
  if (!Number.isFinite(ms)) return '1w';
  const delta = ms - Date.now();
  if (delta <= 60 * 60 * 1000) return '1h';
  if (delta <= 24 * 60 * 60 * 1000) return '1d';
  return '1w';
}

function horizonFromMarketMomentum(change: number): IdeaCandidate['horizon'] {
  const absoluteChange = Math.abs(change);
  if (absoluteChange >= 4) return '10m';
  if (absoluteChange >= 2) return '1h';
  return '1d';
}

function computeHorizonScore(horizon: IdeaCandidate['horizon'], inputs: HorizonScoreInputs): number {
  const weights = HORIZON_WEIGHT_PROFILES[horizon];
  return clampScore(
    inputs.positiveBias
    + (inputs.momentumScore ?? 0) * weights.momentum
    + (inputs.confidenceScore ?? 0) * weights.confidence
    + (inputs.regimeScore ?? 0) * weights.regime
    + (inputs.backtestScore ?? 0) * weights.backtest
    + (inputs.predictionScore ?? 0) * weights.prediction,
  );
}

function buildDrivers(parts: Array<string | null | undefined>): string[] {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).slice(0, 7);
}

function formatBacktestDriver(backtests: StockBacktestResult[] | undefined, symbol: string): string | null {
  const match = backtests?.find((item) => normalizeTicker(item.symbol) === symbol);
  if (!match?.available) return null;
  return `Backtest win rate ${match.winRate.toFixed(0)}% over ${match.actionableEvaluations} signals.`;
}

function buildImplicationCandidates(
  implications: MarketImplicationsData | null,
  markets: MarketData[],
  heldTickers: Set<string>,
  watchlistSymbols: Set<string>,
  portfolio: PersonalPortfolioExport | null,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
  regimeContext?: BuildIdeaRadarOptions['regimeContext'],
  backtests?: StockBacktestResult[],
  sectorSummary?: GetSectorSummaryResponse | null,
  marketBreadth?: GetMarketBreadthHistoryResponse | null,
  earningsCalendar?: ListEarningsCalendarResponse | null,
  economicCalendar?: GetEconomicCalendarResponse | null,
  news?: NewsItem[],
): IdeaCandidate[] {
  if (!implications || implications.degraded) return [];
  return implications.cards
    .filter((card) => !!card.ticker && !heldTickers.has(normalizeTicker(card.ticker)))
    .map((card) => {
      const isLong = card.direction.toUpperCase() === 'LONG';
      const symbol = normalizeTicker(card.ticker);
      const horizon = horizonFromTimeframe(card.timeframe);
      const portfolioFit = buildPortfolioFit(portfolio, portfolioTargets, symbol, 'equity');
      const personalRule = buildPersonalRuleCatalyst(portfolio, symbol, 'equity');
      const watchlist = buildWatchlistCatalyst(watchlistSymbols, symbol);
      const sectorBreadth = buildSectorBreadthCatalyst(sectorSummary, marketBreadth, symbol);
      const earningsCatalyst = buildEarningsCatalyst(earningsCalendar, symbol);
      const sectorEarningsCluster = buildSectorEarningsClusterCatalyst(earningsCalendar, symbol);
      const macroCatalyst = buildMacroCatalyst(economicCalendar, 'equity', symbol);
      const macroSurprise = buildMacroSurpriseCatalyst(economicCalendar, 'equity', symbol);
      const fomcContext = buildFomcContextCatalyst(news, 'equity', symbol);
      const peerConfirmation = buildPeerConfirmationCatalyst(markets, symbol, isLong);
      const peerNewsConfirmation = buildPeerNewsConfirmationCatalyst(news, symbol, `${card.title} ${card.narrative} ${card.driver}`);
      const score = clampScore(
        computeHorizonScore(horizon, {
          positiveBias: (isLong ? 52 : 34) + watchlist.scoreDelta + personalRule.scoreDelta + sectorBreadth.scoreDelta + peerConfirmation.scoreDelta + peerNewsConfirmation.scoreDelta + earningsCatalyst.scoreDelta + sectorEarningsCluster.scoreDelta + macroCatalyst.scoreDelta + macroSurprise.scoreDelta + fomcContext.scoreDelta,
          confidenceScore: rawConfidenceScore(card.confidence),
          regimeScore: rawRegimeScore(regimeContext, 'equity', isLong),
          backtestScore: rawBacktestScore(backtests, symbol),
        }),
      );
      return {
        symbol,
        name: card.name || symbol,
        assetType: 'equity' as const,
        horizon,
        stance: rankStance(score),
        score,
        whyNow: `${HORIZON_LABELS[horizon]} thesis: ${card.title || card.narrative}`,
        invalidator: card.riskCaveat || `${HORIZON_LABELS[horizon]} thesis fails if the narrative decouples from price and macro support.`,
        drivers: buildDrivers([
          card.driver ? `Driver: ${card.driver}.` : null,
          watchlist.driver,
          personalRule.driver,
          sectorBreadth.driver,
          earningsCatalyst.driver,
          sectorEarningsCluster.driver,
          macroCatalyst.driver,
          macroSurprise.driver,
          fomcContext.driver,
          peerConfirmation.driver,
          peerNewsConfirmation.driver,
          regimeContext ? `Macro regime ${regimeContext.compositeLabel || 'unknown'} (${regimeContext.compositeScore}).` : null,
          formatBacktestDriver(backtests, symbol),
        ]),
        portfolioFitScore: portfolioFit.score,
        portfolioFitRationale: portfolioFit.rationale,
        scoreMix: [],
        themeStrength: { score: 0, label: 'Fragile', deltaFromHistory: 0, previousLabel: null },
        backtestConsistency: { winRate: null, actionableSignals: 0, deltaFromHistory: undefined },
        relatedNews: buildRelatedNews(news, symbol, card.name || symbol, 'equity'),
        sources: ['market-implications'],
      };
    });
}

function buildMarketMomentumCandidates(
  markets: MarketData[],
  heldTickers: Set<string>,
  watchlistSymbols: Set<string>,
  portfolio: PersonalPortfolioExport | null,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
  regimeContext?: BuildIdeaRadarOptions['regimeContext'],
  backtests?: StockBacktestResult[],
  sectorSummary?: GetSectorSummaryResponse | null,
  marketBreadth?: GetMarketBreadthHistoryResponse | null,
  earningsCalendar?: ListEarningsCalendarResponse | null,
  economicCalendar?: GetEconomicCalendarResponse | null,
  news?: NewsItem[],
  stockAnalyses?: Record<string, AnalyzeStockResponse>,
): IdeaCandidate[] {
  return markets
    .filter((market) => !heldTickers.has(normalizeTicker(market.symbol)) && typeof market.change === 'number')
    .sort((left, right) => Math.abs(right.change ?? 0) - Math.abs(left.change ?? 0))
    .slice(0, 5)
    .map((market) => {
      const change = market.change ?? 0;
      const symbol = normalizeTicker(market.symbol);
      const positive = change >= 0;
      const horizon = horizonFromMarketMomentum(change);
      const portfolioFit = buildPortfolioFit(portfolio, portfolioTargets, symbol, 'equity');
      const personalRule = buildPersonalRuleCatalyst(portfolio, symbol, 'equity');
      const watchlist = buildWatchlistCatalyst(watchlistSymbols, symbol);
      const shortHorizon = buildShortHorizonCatalyst(market, horizon);
      const volumeConfirmation = buildEquityVolumeCatalyst(stockAnalyses?.[symbol], horizon);
      const sectorBreadth = buildSectorBreadthCatalyst(sectorSummary, marketBreadth, symbol);
      const peerConfirmation = buildPeerConfirmationCatalyst(markets, symbol, positive);
      const earningsCatalyst = buildEarningsCatalyst(earningsCalendar, symbol);
      const sectorEarningsCluster = buildSectorEarningsClusterCatalyst(earningsCalendar, symbol);
      const macroCatalyst = buildMacroCatalyst(economicCalendar, 'equity', symbol);
      const macroSurprise = buildMacroSurpriseCatalyst(economicCalendar, 'equity', symbol);
      const fomcContext = buildFomcContextCatalyst(news, 'equity', symbol);
      const peerNewsConfirmation = buildPeerNewsConfirmationCatalyst(news, symbol, `${market.name} ${market.display}`);
      const score = clampScore(computeHorizonScore(horizon, {
        positiveBias: (positive ? 44 : 24) + watchlist.scoreDelta + personalRule.scoreDelta + shortHorizon.scoreDelta + volumeConfirmation.scoreDelta + sectorBreadth.scoreDelta + peerConfirmation.scoreDelta + peerNewsConfirmation.scoreDelta + earningsCatalyst.scoreDelta + sectorEarningsCluster.scoreDelta + macroCatalyst.scoreDelta + macroSurprise.scoreDelta + fomcContext.scoreDelta,
        momentumScore: rawMomentumScore(change),
        regimeScore: rawRegimeScore(regimeContext, 'equity', positive),
        backtestScore: rawBacktestScore(backtests, symbol),
      }));
      return {
        symbol,
        name: market.name,
        assetType: 'equity' as const,
        horizon,
        stance: positive ? rankStance(score) : 'avoid',
        score,
        whyNow: positive
          ? `${HORIZON_LABELS[horizon]}のモメンタムシグナル: ${market.display} は ${change.toFixed(2)}% 上昇。`
          : `${HORIZON_LABELS[horizon]}の下落シグナル: ${market.display} は ${change.toFixed(2)}% 下落。反転の根拠が出た場合のみ行動候補です。`,
        invalidator: horizon === '10m'
          ? '短期の勢いが冷え込み、追随が続かず、新しい材料でも補強されない場合は無効です。'
          : 'モメンタムが反転し、追随が続かず、広い市場環境の裏付けが得られない場合は無効です。',
        drivers: buildDrivers([
          `Price move ${change >= 0 ? '+' : ''}${change.toFixed(2)}%.`,
          watchlist.driver,
          personalRule.driver,
          shortHorizon.driver,
          volumeConfirmation.driver,
          sectorBreadth.driver,
          earningsCatalyst.driver,
          sectorEarningsCluster.driver,
          macroCatalyst.driver,
          macroSurprise.driver,
          fomcContext.driver,
          peerConfirmation.driver,
          peerNewsConfirmation.driver,
          regimeContext ? `Macro regime ${regimeContext.compositeLabel || 'unknown'} (${regimeContext.compositeScore}).` : null,
          formatBacktestDriver(backtests, symbol),
        ]),
        portfolioFitScore: portfolioFit.score,
        portfolioFitRationale: portfolioFit.rationale,
        scoreMix: [],
        themeStrength: { score: 0, label: 'Fragile', deltaFromHistory: 0, previousLabel: null, basisChange: null },
        backtestConsistency: { winRate: null, actionableSignals: 0, deltaFromHistory: undefined },
        shortTermConfirmation: undefined,
        orderFlowRegime: undefined,
        relatedNews: buildRelatedNews(news, symbol, market.name, 'equity'),
        sources: ['markets'],
      };
    });
}

function buildPredictionCandidates(
  predictions: PredictionMarket[],
  markets: MarketData[],
  heldTickers: Set<string>,
  watchlistSymbols: Set<string>,
  portfolio: PersonalPortfolioExport | null,
  portfolioTargets: PersonalPortfolioTargets | null | undefined,
  regimeContext?: BuildIdeaRadarOptions['regimeContext'],
  etfFlows?: ListEtfFlowsResponse | null,
  stablecoinMarkets?: ListStablecoinMarketsResponse | null,
  cryptoSectors?: ListCryptoSectorsResponse | null,
  hyperliquidFlow?: GetHyperliquidFlowResponse | null,
  economicCalendar?: GetEconomicCalendarResponse | null,
  news?: NewsItem[],
): IdeaCandidate[] {
  const ideas: IdeaCandidate[] = [];
  for (const prediction of predictions) {
    for (const asset of CRYPTO_KEYWORDS) {
      if (!asset.match.test(prediction.title) || heldTickers.has(asset.symbol)) continue;
      const horizon = horizonFromPredictionEndDate(prediction.endDate);
      const cryptoFlowScore = rawCryptoFlowScore(etfFlows, stablecoinMarkets);
      const portfolioFit = buildPortfolioFit(portfolio, portfolioTargets, asset.symbol, 'crypto');
      const personalRule = buildPersonalRuleCatalyst(portfolio, asset.symbol, 'crypto');
      const watchlist = buildWatchlistCatalyst(watchlistSymbols, asset.symbol);
      const predictionVolume = buildPredictionVolumeCatalyst(prediction);
      const onChainProxy = buildOnChainProxyCatalyst(stablecoinMarkets, asset.symbol);
      const hyperliquidOrderFlow = buildHyperliquidFlowCatalyst(hyperliquidFlow, asset.symbol, horizon);
      const cryptoSector = buildCryptoSectorCatalyst(cryptoSectors, asset.symbol);
      const macroCatalyst = buildMacroCatalyst(economicCalendar, 'crypto', asset.symbol);
      const macroSurprise = buildMacroSurpriseCatalyst(economicCalendar, 'crypto', asset.symbol);
      const fomcContext = buildFomcContextCatalyst(news, 'crypto', asset.symbol);
      const peerConfirmation = buildPeerConfirmationCatalyst(markets, asset.symbol, true);
      const peerNewsConfirmation = buildPeerNewsConfirmationCatalyst(news, asset.symbol, `${prediction.title} ${prediction.source}`);
      const score = clampScore(computeHorizonScore(horizon, {
        positiveBias: 48 + watchlist.scoreDelta + personalRule.scoreDelta + predictionVolume.scoreDelta + onChainProxy.scoreDelta + hyperliquidOrderFlow.scoreDelta + cryptoSector.scoreDelta + macroCatalyst.scoreDelta + macroSurprise.scoreDelta + fomcContext.scoreDelta + peerConfirmation.scoreDelta + peerNewsConfirmation.scoreDelta,
        regimeScore: rawRegimeScore(regimeContext, 'crypto', true),
        predictionScore: rawPredictionScore(prediction.yesPrice),
        confidenceScore: cryptoFlowScore,
      }));
      ideas.push({
        symbol: asset.symbol,
        name: asset.name,
        assetType: 'crypto',
        horizon,
        stance: rankStance(score),
        score,
        whyNow: `${HORIZON_LABELS[horizon]} crypto setup: prediction markets are leaning on "${prediction.title}".`,
        invalidator: horizon === '1h'
          ? 'Odds snap back quickly or crypto beta disconnects from the narrative.'
          : 'Prediction market odds mean-revert or broader risk appetite collapses.',
        drivers: buildDrivers([
          `Prediction market edge ${(prediction.yesPrice ?? 50).toFixed(0)} / ${Math.max(0, 100 - (prediction.yesPrice ?? 50)).toFixed(0)}.`,
          watchlist.driver,
          personalRule.driver,
          predictionVolume.driver,
          onChainProxy.driver,
          hyperliquidOrderFlow.driver,
          cryptoSector.driver,
          macroCatalyst.driver,
          macroSurprise.driver,
          fomcContext.driver,
          peerConfirmation.driver,
          peerNewsConfirmation.driver,
          regimeContext ? `Macro regime ${regimeContext.compositeLabel || 'unknown'} (${regimeContext.compositeScore}).` : null,
          ...buildCryptoFlowDrivers(etfFlows, stablecoinMarkets),
          prediction.endDate ? `Contract horizon into ${new Date(prediction.endDate).toLocaleDateString()}.` : null,
        ]),
        portfolioFitScore: portfolioFit.score,
        portfolioFitRationale: portfolioFit.rationale,
        scoreMix: [],
        themeStrength: { score: 0, label: 'Fragile', deltaFromHistory: 0, previousLabel: null, basisChange: null },
        backtestConsistency: { winRate: null, actionableSignals: 0, deltaFromHistory: undefined },
        shortTermConfirmation: undefined,
        orderFlowRegime: undefined,
        relatedNews: buildRelatedNews(news, asset.symbol, asset.name, 'crypto'),
        sources: ['prediction-markets'],
      });
    }
  }
  return ideas;
}

export function buildIdeaRadarViewModel(options: BuildIdeaRadarOptions): IdeaRadarViewModel {
  const heldTickers = buildHeldTickers(options.portfolio);
  const watchlistSymbols = normalizeWatchlistSymbols(options.watchlistSymbols);
  const reviewHistory = options.reviewHistory ?? {};
  const candidates = [
    ...buildImplicationCandidates(options.implications, options.markets, heldTickers, watchlistSymbols, options.portfolio, options.portfolioTargets, options.regimeContext, options.backtests, options.sectorSummary, options.marketBreadth, options.earningsCalendar, options.economicCalendar, options.news),
    ...buildMarketMomentumCandidates(options.markets, heldTickers, watchlistSymbols, options.portfolio, options.portfolioTargets, options.regimeContext, options.backtests, options.sectorSummary, options.marketBreadth, options.earningsCalendar, options.economicCalendar, options.news, options.stockAnalyses),
    ...buildPredictionCandidates(options.predictions, options.markets, heldTickers, watchlistSymbols, options.portfolio, options.portfolioTargets, options.regimeContext, options.etfFlows, options.stablecoinMarkets, options.cryptoSectors, options.hyperliquidFlow, options.economicCalendar, options.news),
  ]
    .map((candidate) => {
      const driverCluster = inferDriverCluster(candidate);
      const thesisFamily = inferThesisFamily(candidate);
      const provisionalDrivers = buildDrivers(candidate.drivers);
      const provisionalScoreMix = buildScoreMix({
        assetType: candidate.assetType,
        drivers: provisionalDrivers,
        horizon: candidate.horizon,
        thesisFamily,
      });
      const provisionalShortTermConfirmation = buildShortTermConfirmation(candidate.horizon, provisionalDrivers, provisionalScoreMix);
      const provisionalOrderFlowRegime = buildOrderFlowRegime(
        options.hyperliquidFlow,
        candidate.symbol,
        reviewHistory[`${candidate.symbol}:${candidate.horizon}`] ?? reviewHistory[candidate.symbol],
      );
      const provisionalBacktestConsistency = buildBacktestConsistency(
        options.backtests,
        candidate.symbol,
        reviewHistory[`${candidate.symbol}:${candidate.horizon}`] ?? reviewHistory[candidate.symbol],
      );
      const reviewLoop = buildReviewLoopCatalyst(
        reviewHistory,
        candidate.symbol,
        candidate.horizon,
        candidate.stance,
        candidate.score,
        driverCluster,
        thesisFamily,
        provisionalScoreMix,
        buildThemeStrength(candidate.horizon, provisionalDrivers, provisionalScoreMix, provisionalOrderFlowRegime, provisionalBacktestConsistency),
        provisionalShortTermConfirmation,
        provisionalOrderFlowRegime,
        provisionalBacktestConsistency,
      );
      const finalDrivers = buildDrivers([...candidate.drivers, reviewLoop.driver]);
      const finalScoreMix = buildScoreMix({
        assetType: candidate.assetType,
        drivers: finalDrivers,
        horizon: candidate.horizon,
        thesisFamily,
      });
      const previousTheme = reviewHistory[`${candidate.symbol}:${candidate.horizon}`] ?? reviewHistory[candidate.symbol];
      const finalBacktestConsistency = buildBacktestConsistency(options.backtests, candidate.symbol, previousTheme);
      const finalOrderFlowRegime = buildOrderFlowRegime(options.hyperliquidFlow, candidate.symbol, previousTheme);
      const finalThemeStrength = buildThemeStrength(
        candidate.horizon,
        finalDrivers,
        finalScoreMix,
        finalOrderFlowRegime,
        finalBacktestConsistency,
      );
      const finalShortTermConfirmation = buildShortTermConfirmation(candidate.horizon, finalDrivers, finalScoreMix);
      const themeBasisChange = describeBasisChange(previousTheme?.scoreMix, finalScoreMix, undefined, candidate.horizon);
      const shortTermBasisChange = describeBasisChange(previousTheme?.scoreMix, finalScoreMix, ['Momentum', 'Peer', 'Breadth', 'Flow'], candidate.horizon);
      const shiftIntensity = buildShiftIntensity(themeBasisChange, shortTermBasisChange, candidate.horizon);
      const finalScore = clampScore(candidate.score + reviewLoop.scoreDelta + shiftIntensity.scoreDelta);
      const themeDelta = previousTheme?.themeStrength ? finalThemeStrength.score - (previousTheme.themeStrength.score ?? 0) : undefined;
      const shortTermDelta = previousTheme?.shortTermConfirmation && finalShortTermConfirmation
        ? finalShortTermConfirmation.score - (previousTheme.shortTermConfirmation.score ?? 0)
        : undefined;
      const finalStance = finalizeStance(
        finalScore,
        candidate.assetType,
        candidate.horizon,
        finalThemeStrength,
        finalShortTermConfirmation,
        finalOrderFlowRegime,
      );
      const finalStanceReason = buildStanceReason(
        candidate.assetType,
        candidate.horizon,
        finalThemeStrength,
        finalShortTermConfirmation,
        finalOrderFlowRegime,
        finalScoreMix,
        {
          themeDelta,
          shortTermDelta,
          orderFlowDelta: finalOrderFlowRegime?.deltaFromHistory,
          backtestDelta: finalBacktestConsistency?.deltaFromHistory,
        },
      );
      return {
        ...candidate,
        score: finalScore,
        stance: finalStance,
        stanceReason: finalStanceReason,
        drivers: finalDrivers,
        scoreMix: finalScoreMix,
        themeStrength: {
          ...finalThemeStrength,
          deltaFromHistory: themeDelta,
          previousLabel: previousTheme?.themeStrength?.label ?? null,
          basisChange: themeBasisChange,
        },
        shortTermConfirmation: finalShortTermConfirmation
          ? {
              ...finalShortTermConfirmation,
              deltaFromHistory: shortTermDelta,
              previousLabel: previousTheme?.shortTermConfirmation?.label ?? null,
              basisChange: shortTermBasisChange,
            }
          : undefined,
        orderFlowRegime: finalOrderFlowRegime,
        backtestConsistency: finalBacktestConsistency,
      };
    })
    .sort((left, right) => right.score - left.score)
    .filter((candidate, index, all) => all.findIndex((item) => item.symbol === candidate.symbol) === index)
    .slice(0, 8);

  const nextHistory = { ...reviewHistory };
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    const historyKey = `${candidate.symbol}:${candidate.horizon}`;
    const current = nextHistory[historyKey] ?? nextHistory[candidate.symbol];
    nextHistory[historyKey] = {
      count: (current?.count ?? 0) + 1,
      firstSeenAt: current?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastScore: candidate.score,
      lastStance: candidate.stance,
      scoreBand: candidate.score >= 75 ? 'strong' : candidate.score >= 60 ? 'actionable' : candidate.score >= 45 ? 'developing' : 'weak',
      driverCluster: inferDriverCluster(candidate),
      thesisFamily: inferThesisFamily(candidate),
      scoreMix: candidate.scoreMix,
      themeStrength: candidate.themeStrength,
      shortTermConfirmation: candidate.shortTermConfirmation
        ? {
            score: candidate.shortTermConfirmation.score,
            label: candidate.shortTermConfirmation.label,
          }
        : undefined,
      orderFlowRegime: candidate.orderFlowRegime
        ? {
            score: candidate.orderFlowRegime.score,
            label: candidate.orderFlowRegime.label,
          }
        : undefined,
      backtestConsistency: candidate.backtestConsistency && candidate.backtestConsistency.winRate != null
        ? {
            winRate: candidate.backtestConsistency.winRate,
            actionableSignals: candidate.backtestConsistency.actionableSignals,
          }
        : undefined,
    };
  }
  const notes = [
    isJa() ? '保有情報がある場合、現在保有中の銘柄は候補から除外しています。' : 'Currently held positions are excluded from candidates when portfolio data is available.',
    isJa() ? '短期アイデアは自動売買の合図ではなく、監視のきっかけとして使います。' : 'Short-term ideas are watchlist triggers, not automated trade signals.',
  ];
  const missingOverlays: string[] = [];

  if (options.regimeContext) {
    notes.push(isJa()
      ? `マクロ環境: ${options.regimeContext.compositeLabel || '不明'} (${options.regimeContext.compositeScore}).`
      : `Macro regime: ${options.regimeContext.compositeLabel || 'unknown'} (${options.regimeContext.compositeScore}).`);
  } else {
    missingOverlays.push(isJa() ? 'マクロ環境' : 'Macro regime');
  }

  if (options.portfolioTargets?.description) {
    notes.push(isJa()
      ? `目標配分: ${options.portfolioTargets.description}.`
      : `Target allocation: ${options.portfolioTargets.description}.`);
  } else if ((options.portfolioTargets?.allocations?.length ?? 0) > 0) {
    notes.push(isJa()
      ? `目標配分: ${options.portfolioTargets!.allocations.length}分類の配分目標を読み込み済み。`
      : `Target allocation: ${options.portfolioTargets!.allocations.length} allocation buckets loaded.`);
  } else {
    notes.push(isJa() ? '目標配分: 未設定。' : 'Target allocation: not configured.');
  }

  if (options.sectorSummary?.sectors?.length) {
    notes.push(isJa()
      ? `セクター広がり: ${options.sectorSummary.sectors.length} セクターを読み込み済み。`
      : `Sector breadth loaded: ${options.sectorSummary.sectors.length} sectors.`);
  } else {
    missingOverlays.push(isJa() ? 'セクター広がり' : 'Sector breadth');
  }

  if (options.marketBreadth && options.marketBreadth.currentPctAbove50d != null) {
    notes.push(isJa()
      ? `市場の広がり: 50日線を上回る銘柄が ${options.marketBreadth.currentPctAbove50d.toFixed(1)}%。`
      : `Market breadth: ${options.marketBreadth.currentPctAbove50d.toFixed(1)}% above 50-day.`);
  } else {
    missingOverlays.push(isJa() ? '市場の広がり' : 'Market breadth');
  }

  if (options.cryptoSectors?.sectors?.length) {
    notes.push(isJa()
      ? `暗号資産の広がり: ${options.cryptoSectors.sectors.length} セクターを読み込み済み。`
      : `Crypto breadth loaded: ${options.cryptoSectors.sectors.length} sectors.`);
  } else {
    missingOverlays.push(isJa() ? '暗号資産の広がり' : 'Crypto breadth');
  }

  if (options.hyperliquidFlow && !options.hyperliquidFlow.unavailable) {
    notes.push(isJa()
      ? `注文フロー: ${options.hyperliquidFlow.assetCount} 資産を読み込み済み。`
      : `Order-flow loaded: ${options.hyperliquidFlow.assetCount} assets.`);
  } else {
    missingOverlays.push(isJa() ? '注文フロー' : 'Order-flow');
  }

  if (options.earningsCalendar?.total) {
    notes.push(isJa()
      ? `決算カタリスト: ${options.earningsCalendar.total} 件を読み込み済み。`
      : `Earnings catalysts loaded: ${options.earningsCalendar.total}.`);
  } else {
    missingOverlays.push(isJa() ? '決算カタリスト' : 'Earnings catalysts');
  }

  if (options.economicCalendar?.total) {
    notes.push(isJa()
      ? `経済カタリスト: ${options.economicCalendar.total} 件を読み込み済み。`
      : `Economic catalysts loaded: ${options.economicCalendar.total}.`);
  } else {
    missingOverlays.push(isJa() ? '経済カタリスト' : 'Economic catalysts');
  }

  if (options.etfFlows?.summary) {
    notes.push(isJa()
      ? `ETFフロー: ${translateOverlayDirection(options.etfFlows.summary.netDirection)}（推定 ${Math.round(options.etfFlows.summary.totalEstFlow || 0)}）。`
      : `ETF flows: ${translateOverlayDirection(options.etfFlows.summary.netDirection)} (est. ${Math.round(options.etfFlows.summary.totalEstFlow || 0)}).`);
  } else {
    missingOverlays.push(isJa() ? 'ETFフロー' : 'ETF flows');
  }

  if (options.stablecoinMarkets?.summary) {
    notes.push(isJa()
      ? `ステーブルコイン: ${translateStablecoinHealth(options.stablecoinMarkets.summary.healthStatus)}、デペグ ${options.stablecoinMarkets.summary.depeggedCount} 件。`
      : `Stablecoins: ${translateStablecoinHealth(options.stablecoinMarkets.summary.healthStatus)}, ${options.stablecoinMarkets.summary.depeggedCount} depegged.`);
  } else {
    missingOverlays.push(isJa() ? 'ステーブルコイン' : 'Stablecoins');
  }

  const activePersonalRules = options.portfolio?.risk_rules?.filter((rule) => !rule.ok) ?? [];
  notes.push(activePersonalRules.length > 0
    ? (isJa() ? `個人ルール警戒: ${activePersonalRules.length}件。` : `Personal rule overlay: ${activePersonalRules.length} alert(s) active.`)
    : (isJa() ? '個人ルール: 現在警戒なし。' : 'Personal rule overlay quiet.'));
  notes.push(watchlistSymbols.size
    ? (isJa() ? `監視銘柄: ${watchlistSymbols.size}銘柄を反映。` : `Watchlist overlay active: ${watchlistSymbols.size} symbols.`)
    : (isJa() ? '監視銘柄: 未設定。' : 'Watchlist overlay: not configured.'));

  if (missingOverlays.length > 0) {
    notes.push(isJa()
      ? `補助オーバーレイ未接続: ${missingOverlays.join(' / ')}。`
      : `Overlays not connected: ${missingOverlays.join(' / ')}.`);
  }

  const candidatesByHorizon = {
    '10m': [] as IdeaCandidate[],
    '1h': [] as IdeaCandidate[],
    '1d': [] as IdeaCandidate[],
    '1w': [] as IdeaCandidate[],
  };
  for (const horizon of HORIZON_ORDER) {
    candidatesByHorizon[horizon] = candidates.filter((candidate) => candidate.horizon === horizon);
  }

  return {
    generatedAt: new Date().toISOString(),
    candidates,
    candidatesByHorizon,
    notes,
    nextReviewHistory: nextHistory,
  };
}
