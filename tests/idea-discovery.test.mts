import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildIdeaRadarViewModel } from '../src/services/idea-discovery.ts';
import type { PredictionMarket } from '../src/services/prediction/index.ts';
import type { MarketData } from '../src/types/index.ts';
import type { PersonalPortfolioExport, PersonalPortfolioTargets } from '../src/services/personal-portfolio.ts';
import type { NewsItem } from '../src/types/index.ts';

(globalThis as { document?: { documentElement?: { lang?: string } } }).document = {
  documentElement: { lang: 'ja' },
};

function isoDatePlus(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

const markets: MarketData[] = [
  { symbol: 'NVDA', name: 'NVIDIA', display: 'NVDA', price: 100, change: 3.2, sparkline: [96, 98, 97, 100] },
  { symbol: 'PLTR', name: 'Palantir', display: 'PLTR', price: 30, change: 4.8, sparkline: [28.5, 29.2, 29.8, 30.6] },
  { symbol: 'TSLA', name: 'Tesla', display: 'TSLA', price: 200, change: -2.1, sparkline: [206, 205, 203, 200] },
];

const predictions: PredictionMarket[] = [
  { title: 'Will Bitcoin trade above $120k this year?', yesPrice: 68, volume: 1250000, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
];

const portfolio: PersonalPortfolioExport = {
  schema_version: 1,
  generated_at: '2026-05-28T10:00:00',
  source: 'AI_System.portfolio.db',
  detail: 'risk',
  privacy: { exact_amounts: false, exact_quantities: false, intended_use: 'portfolio-impact-analysis' },
  summary: { holding_count: 1, account_count: 1, total_gain_pct: 10, cached_prices: true },
  accounts: [{ account: 'SBI', holding_count: 1, weight_pct: 100 }],
  currency: [{ currency: 'JPY', weight_pct: 100 }],
  holdings: [{ ticker: 'NVDA', name: 'NVIDIA', account: 'SBI', currency: 'JPY', weight_pct: 40, gain_pct: 10, priced: true }],
  risk_rules: [],
};

const news: NewsItem[] = [
  {
    source: 'Reuters',
    title: 'Broadcom expands AI networking push as cloud demand stays strong',
    link: 'https://example.com/avgo',
    pubDate: new Date('2026-05-28T09:00:00Z'),
    isAlert: false,
    snippet: 'AVGO benefits from AI capex.',
  },
  {
    source: 'CoinDesk',
    title: 'Bitcoin traders watch ETF inflows as stablecoin liquidity improves',
    link: 'https://example.com/btc',
    pubDate: new Date('2026-05-28T08:00:00Z'),
    isAlert: false,
    snippet: 'BTC setup strengthened by flows.',
  },
];

const portfolioTargets: PersonalPortfolioTargets = {
  description: 'Growth portfolio target mix',
  updated_at: '2026-05-28 10:00',
  allocations: [
    { label: 'US Equity', key: 'us_equity', target_pct: 70, color: '#f59e0b' },
    { label: 'Japan Equity', key: 'jp_equity', target_pct: 20, color: '#3b82f6' },
    { label: 'Crypto', key: 'crypto', target_pct: 10, color: '#8b5cf6' },
  ],
  ticker_map: {
    NVDA: 'us_equity',
  },
};

describe('idea discovery', () => {
  it('excludes currently held tickers and proposes non-held candidates', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions,
      portfolio,
      portfolioTargets,
      implications: {
        cards: [
          {
            ticker: 'AVGO',
            name: 'Broadcom',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'AI infra demand remains strong',
            narrative: 'Networking leverage to AI capex.',
            riskCaveat: 'Capex slowdown.',
            driver: 'AI infra',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      watchlistSymbols: ['AVGO', 'BTC'],
      backtests: [
        {
          available: true,
          symbol: 'PLTR',
          name: 'Palantir',
          display: 'PLTR',
          currency: 'USD',
          evalWindowDays: 10,
          evaluationsRun: 8,
          actionableEvaluations: 8,
          winRate: 61,
          directionAccuracy: 63,
          avgSimulatedReturnPct: 2.2,
          cumulativeSimulatedReturnPct: 17.6,
          latestSignal: 'buy',
          latestSignalScore: 78,
          summary: '',
          generatedAt: '2026-05-28T10:00:00',
          evaluations: [],
          engineVersion: 'test',
        },
      ],
      stockAnalyses: {
        PLTR: {
          available: true,
          symbol: 'PLTR',
          name: 'Palantir',
          display: 'PLTR',
          currency: 'USD',
          currentPrice: 42,
          changePercent: 3.1,
          signalScore: 78,
          signal: 'Buy',
          trendStatus: 'Strong',
          volumeStatus: 'Heavy',
          macdStatus: 'Bullish',
          rsiStatus: 'Constructive',
          summary: '',
          action: 'Watch',
          confidence: 'HIGH',
          technicalSummary: 'Constructive tape.',
          newsSummary: '',
          whyNow: '',
          bullishFactors: [],
          riskFactors: [],
          supportLevels: [],
          resistanceLevels: [],
          headlines: [],
          ma5: 0,
          ma10: 0,
          ma20: 0,
          ma60: 0,
          biasMa5: 0,
          biasMa10: 0,
          biasMa20: 0,
          volumeRatio5d: 2.4,
          rsi12: 0,
          macdDif: 0,
          macdDea: 0,
          macdBar: 0,
          provider: 'test',
          model: 'test',
          fallback: false,
          newsSearched: false,
          generatedAt: '2026-05-28T10:00:00',
          analysisId: 'pltr-test',
          analysisAt: 0,
          stopLoss: 0,
          takeProfit: 0,
          engineVersion: 'test',
          recentUpgrades: [],
          dividendYield: 0,
          trailingAnnualDividendRate: 0,
          exDividendDate: 0,
          dividendFrequency: '',
          dividendCagr: 0,
        },
      },
      etfFlows: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          etfCount: 10,
          totalVolume: 1000000,
          totalEstFlow: 250000000,
          netDirection: 'NET_INFLOW',
          inflowCount: 8,
          outflowCount: 2,
        },
        etfs: [],
        rateLimited: false,
      },
      sectorSummary: {
        sectors: [
          { symbol: 'XLK', name: 'Technology', change: 2.4 },
          { symbol: 'XLF', name: 'Finance', change: -0.3 },
        ],
      },
      marketBreadth: {
        currentPctAbove20d: 71,
        currentPctAbove50d: 68,
        currentPctAbove200d: 59,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      stablecoinMarkets: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          totalMarketCap: 100000000000,
          totalVolume24h: 50000000000,
          coinCount: 5,
          depeggedCount: 0,
          healthStatus: 'HEALTHY',
        },
        stablecoins: [],
      },
      cryptoSectors: {
        sectors: [
          { id: 'layer1', name: 'Layer 1', change: 4.2 },
          { id: 'defi', name: 'DeFi', change: 1.4 },
          { id: 'infra', name: 'Infrastructure', change: 2.1 },
        ],
      },
      hyperliquidFlow: {
        ts: '2026-05-28T10:00:00Z',
        fetchedAt: '2026-05-28T10:00:00Z',
        warmup: false,
        assetCount: 3,
        unavailable: false,
        assets: [
          {
            symbol: 'BTC',
            display: 'BTC',
            assetClass: 'crypto',
            group: 'majors',
            funding: '0.01',
            openInterest: '1200000000',
            markPx: '112000',
            oraclePx: '111900',
            dayNotional: '2500000000',
            fundingScore: 58,
            volumeScore: 74,
            oiScore: 68,
            basisScore: 61,
            composite: 77,
            sparkFunding: [55, 56, 58],
            sparkOi: [60, 64, 68],
            sparkScore: [70, 73, 77],
            warmup: false,
            stale: false,
            staleSince: '',
            missingPolls: 0,
            alerts: [],
          },
        ],
      },
      earningsCalendar: {
        earnings: [
          {
            symbol: 'AVGO',
            company: 'Broadcom',
            date: isoDatePlus(2),
            hour: 'amc',
            epsEstimate: 1.2,
            revenueEstimate: 1000000000,
            epsActual: 0,
            revenueActual: 0,
            hasActuals: false,
            surpriseDirection: '',
          },
          {
            symbol: 'AAPL',
            company: 'Apple',
            date: isoDatePlus(1),
            hour: 'amc',
            epsEstimate: 1.1,
            revenueEstimate: 900000000,
            epsActual: 1.22,
            revenueActual: 950000000,
            hasActuals: true,
            surpriseDirection: 'beat',
          },
          {
            symbol: 'MSFT',
            company: 'Microsoft',
            date: isoDatePlus(0),
            hour: 'amc',
            epsEstimate: 2.1,
            revenueEstimate: 1400000000,
            epsActual: 2.3,
            revenueActual: 1500000000,
            hasActuals: true,
            surpriseDirection: 'beat',
          },
        ],
        fromDate: isoDatePlus(0),
        toDate: isoDatePlus(14),
        total: 3,
        unavailable: false,
      },
      economicCalendar: {
        events: [
          {
            event: 'CPI',
            country: 'US',
            date: isoDatePlus(1),
            impact: 'high',
            actual: '',
            estimate: '3.2',
            previous: '3.1',
            unit: '%',
          },
        ],
        fromDate: isoDatePlus(0),
        toDate: isoDatePlus(14),
        total: 1,
        unavailable: false,
      },
      news,
    });

    const symbols = view.candidates.map((candidate) => candidate.symbol);
    assert.ok(!symbols.includes('NVDA'));
    assert.ok(symbols.includes('AVGO'));
    assert.ok(symbols.includes('BTC'));
    assert.ok(symbols.includes('PLTR'));
    assert.match(view.notes[2] ?? '', /マクロ環境: risk-on/);
    const pltr = view.candidates.find((candidate) => candidate.symbol === 'PLTR');
    assert.ok((pltr?.score ?? 0) >= 65);
    assert.ok((pltr?.drivers.length ?? 0) >= 2);
    assert.match(pltr?.whyNow ?? '', /10-minute/);
    assert.ok(pltr?.drivers.some((driver) => /Short-horizon tape:/i.test(driver)));
    assert.ok(pltr?.drivers.some((driver) => /Volume confirmation:/i.test(driver)));
    assert.notEqual(pltr?.shortTermConfirmation?.label, 'Thin');
    assert.ok((pltr?.shortTermConfirmation?.score ?? 0) >= 36);
    assert.ok((pltr?.orderFlowRegime ?? null) == null);
    assert.notEqual(pltr?.themeStrength.label, 'Confirmed');
    assert.ok(view.candidatesByHorizon['10m'].some((candidate) => candidate.symbol === 'PLTR'));
    assert.ok(view.candidatesByHorizon['1w'].some((candidate) => candidate.symbol === 'AVGO'));
    assert.ok(view.candidatesByHorizon['1w'].some((candidate) => candidate.symbol === 'BTC'));
    const btc = view.candidates.find((candidate) => candidate.symbol === 'BTC');
    assert.match(btc?.whyNow ?? '', /1-week crypto setup/);
    assert.ok((btc?.drivers.some((driver) => /Crypto breadth:/i.test(driver)) ?? false));
    assert.ok((btc?.drivers.some((driver) => /watchlist/i.test(driver)) ?? false));
    assert.ok((btc?.drivers.some((driver) => /On-chain proxy:/i.test(driver)) ?? false));
    assert.ok((btc?.drivers.some((driver) => /Prediction market volume/i.test(driver)) ?? false));
    assert.ok((btc?.drivers.some((driver) => /Order-flow:/i.test(driver)) ?? false));
    assert.equal(btc?.orderFlowRegime?.label, 'Strong');
    assert.match(view.notes[3] ?? '', /目標配分: Growth portfolio target mix/);
    assert.match(view.notes[4] ?? '', /セクター広がり: 2 セクターを読み込み済み/);
    assert.match(view.notes[5] ?? '', /市場の広がり: 50日線を上回る銘柄が 68\.0%/);
    assert.match(view.notes[6] ?? '', /暗号資産の広がり: 3 セクターを読み込み済み/);
    assert.match(view.notes[7] ?? '', /注文フロー: 3 資産を読み込み済み/);
    assert.match(view.notes[8] ?? '', /決算カタリスト: 3 件を読み込み済み/);
    assert.match(view.notes[9] ?? '', /経済カタリスト: 1 件を読み込み済み/);
    assert.match(view.notes[10] ?? '', /ETFフロー: 流入優勢/);
    assert.match(view.notes[11] ?? '', /ステーブルコイン: 概ね安定/);
    assert.match(view.notes[12] ?? '', /個人ルール: 現在警戒なし/);
    assert.match(view.notes[13] ?? '', /監視銘柄: 2銘柄を反映/);
    const avgo = view.candidates.find((candidate) => candidate.symbol === 'AVGO');
    assert.ok((avgo?.portfolioFitScore ?? 0) >= 40);
    assert.ok((avgo?.scoreMix.length ?? 0) >= 2);
    assert.ok(avgo?.scoreMix.some((item) => item.label === 'Breadth'));
    assert.ok(avgo?.scoreMix.some((item) => item.label === 'Earnings'));
    assert.ok((avgo?.themeStrength.score ?? 0) >= 35);
    assert.match(avgo?.themeStrength.label ?? '', /Building|Confirmed/);
    assert.match(avgo?.portfolioFitRationale ?? '', /under target|target/i);
    assert.match(avgo?.portfolioFitRationale ?? '', /Top position is already 40.0%|concentration room is limited/i);
    assert.match(avgo?.portfolioFitRationale ?? '', /Semiconductor sleeve is already 40.0%/);
    assert.ok(avgo?.drivers.some((driver) => /watchlist/i.test(driver)));
    assert.ok(avgo?.drivers.some((driver) => /Sector breadth:/i.test(driver)));
    assert.ok(avgo?.drivers.some((driver) => /Earnings catalyst/i.test(driver)));
    assert.ok(avgo?.drivers.some((driver) => /earnings cluster is supportive: 2 beats vs 0 misses/i.test(driver)));
    assert.ok(avgo?.drivers.some((driver) => /Macro catalyst/i.test(driver)));
    assert.ok((avgo?.relatedNews.length ?? 0) >= 1);
    assert.match(avgo?.relatedNews[0]?.title ?? '', /Broadcom/);
  });

  it('applies review-loop drag to recurring ideas', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions,
      portfolio,
      portfolioTargets,
      reviewHistory: {
        'AVGO:1w': {
          count: 5,
          firstSeenAt: '2026-05-20T00:00:00.000Z',
          lastSeenAt: '2026-05-28T00:00:00.000Z',
          lastScore: 82,
          lastStance: 'research',
          scoreBand: 'strong',
          driverCluster: 'breadth',
          thesisFamily: 'ai-semiconductor',
          scoreMix: [{ label: 'Breadth', pct: 48 }, { label: 'Earnings', pct: 34 }],
          themeStrength: { score: 42, label: 'Building' },
        },
      },
      implications: {
        cards: [
          {
            ticker: 'AVGO',
            name: 'Broadcom',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'AI infra demand remains strong',
            narrative: 'Networking leverage to AI capex.',
            riskCaveat: 'Capex slowdown.',
            driver: 'AI infra',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 2.4 }],
      },
      marketBreadth: {
        currentPctAbove20d: 71,
        currentPctAbove50d: 68,
        currentPctAbove200d: 59,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      news,
    });

    const avgo = view.candidates.find((candidate) => candidate.symbol === 'AVGO');
    assert.ok(avgo);
    assert.ok(avgo!.drivers.some((driver) => /same stance and score band/i.test(driver)));
    assert.equal(view.nextReviewHistory?.['AVGO:1w']?.count, 6);
    assert.equal(view.nextReviewHistory?.['AVGO:1w']?.lastStance, avgo?.stance);
    assert.equal(view.nextReviewHistory?.['AVGO:1w']?.scoreBand, 'strong');
    assert.equal(view.nextReviewHistory?.['AVGO:1w']?.driverCluster, 'breadth');
    assert.equal(view.nextReviewHistory?.['AVGO:1w']?.thesisFamily, 'ai-semiconductor');
    assert.ok((view.nextReviewHistory?.['AVGO:1w']?.scoreMix?.length ?? 0) >= 2);
    assert.ok((view.nextReviewHistory?.['AVGO:1w']?.themeStrength?.score ?? 0) >= 35);
    assert.equal(view.nextReviewHistory?.['AVGO:1w']?.backtestConsistency, undefined);
  });

  it('tracks recurring ideas across the same thesis family', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions,
      portfolio,
      portfolioTargets,
      reviewHistory: {
        'AVGO:1w': {
          count: 3,
          firstSeenAt: '2026-05-20T00:00:00.000Z',
          lastSeenAt: '2026-05-28T00:00:00.000Z',
          lastScore: 74,
          lastStance: 'watch',
          scoreBand: 'developing',
          driverCluster: 'earnings',
          thesisFamily: 'ai-semiconductor',
          scoreMix: [{ label: 'Momentum', pct: 55 }, { label: 'Peer', pct: 25 }],
          themeStrength: { score: 70, label: 'Confirmed' },
        },
      },
      implications: {
        cards: [
          {
            ticker: 'AVGO',
            name: 'Broadcom',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'AI infra demand remains strong',
            narrative: 'Networking leverage to AI capex.',
            riskCaveat: 'Capex slowdown.',
            driver: 'AI infra',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 2.4 }],
      },
      marketBreadth: {
        currentPctAbove20d: 71,
        currentPctAbove50d: 68,
        currentPctAbove200d: 59,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      news,
    });

    const avgo = view.candidates.find((candidate) => candidate.symbol === 'AVGO');
    assert.ok(avgo);
    assert.ok(avgo!.drivers.some((driver) => /same thesis family but with a shifted signal mix/i.test(driver)));
  });

  it('reduces thesis-family drag when theme strength has improved', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions,
      portfolio,
      portfolioTargets,
      reviewHistory: {
        'AVGO:1w': {
          count: 3,
          firstSeenAt: '2026-05-20T00:00:00.000Z',
          lastSeenAt: '2026-05-28T00:00:00.000Z',
          lastScore: 71,
          lastStance: 'watch',
          scoreBand: 'actionable',
          driverCluster: 'earnings',
          thesisFamily: 'ai-semiconductor',
          scoreMix: [{ label: 'Earnings', pct: 44 }, { label: 'Breadth', pct: 20 }],
          themeStrength: { score: 22, label: 'Fragile' },
        },
      },
      implications: {
        cards: [
          {
            ticker: 'AVGO',
            name: 'Broadcom',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'AI infra demand remains strong',
            narrative: 'Networking leverage to AI capex.',
            riskCaveat: 'Capex slowdown.',
            driver: 'AI infra',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 2.4 }],
      },
      marketBreadth: {
        currentPctAbove20d: 71,
        currentPctAbove50d: 68,
        currentPctAbove200d: 59,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      news,
    });

    const avgo = view.candidates.find((candidate) => candidate.symbol === 'AVGO');
    assert.ok(avgo);
    assert.ok(avgo!.drivers.some((driver) => /stronger theme confirmation/i.test(driver)));
    assert.ok((view.nextReviewHistory?.['AVGO:1w']?.themeStrength?.score ?? 0) > 22);
  });

  it('treats large score-mix weight changes as a shifted thesis replay', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions,
      portfolio,
      portfolioTargets,
      reviewHistory: {
        'AVGO:1w': {
          count: 3,
          firstSeenAt: '2026-05-20T00:00:00.000Z',
          lastSeenAt: '2026-05-28T00:00:00.000Z',
          lastScore: 74,
          lastStance: 'watch',
          scoreBand: 'actionable',
          driverCluster: 'earnings',
          thesisFamily: 'ai-semiconductor',
          scoreMix: [{ label: 'Earnings', pct: 52 }, { label: 'Breadth', pct: 28 }, { label: 'Inflation', pct: 20 }],
          themeStrength: { score: 68, label: 'Confirmed' },
        },
      },
      implications: {
        cards: [
          {
            ticker: 'AVGO',
            name: 'Broadcom',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'AI infra demand remains strong',
            narrative: 'Networking leverage to AI capex.',
            riskCaveat: 'Capex slowdown.',
            driver: 'AI infra',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 2.4 }],
      },
      marketBreadth: {
        currentPctAbove20d: 71,
        currentPctAbove50d: 68,
        currentPctAbove200d: 59,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      news,
    });

    const avgo = view.candidates.find((candidate) => candidate.symbol === 'AVGO');
    assert.ok(avgo);
    assert.ok(avgo!.drivers.some((driver) => /shifted signal mix/i.test(driver)));
    assert.match(avgo!.themeStrength.basisChange ?? '', /Earnings|Breadth|Inflation/);
  });

  it('classifies healthcare bundles into a richer thesis family', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions: [],
      portfolio,
      portfolioTargets,
      implications: {
        cards: [
          {
            ticker: 'LLY',
            name: 'Eli Lilly',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'Healthcare leadership remains intact',
            narrative: 'GLP-1 demand stays firm.',
            riskCaveat: 'Drug pricing pressure.',
            driver: 'Healthcare momentum',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 66,
        compositeLabel: 'risk-on',
        cnnFearGreed: 62,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [{ symbol: 'XLV', name: 'Healthcare', change: 1.9 }],
      },
      marketBreadth: {
        currentPctAbove20d: 61,
        currentPctAbove50d: 58,
        currentPctAbove200d: 52,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      news,
    });

    const lly = view.candidates.find((candidate) => candidate.symbol === 'LLY');
    assert.ok(lly);
    assert.equal(view.nextReviewHistory?.['LLY:1w']?.thesisFamily, 'healthcare-growth');
  });

  it('uses entity-registry sector coverage for non-hardcoded equities', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions: [],
      portfolio,
      portfolioTargets,
      implications: {
        cards: [
          {
            ticker: 'LLY',
            name: 'Eli Lilly',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'Healthcare leadership remains intact',
            narrative: 'GLP-1 demand stays firm.',
            riskCaveat: 'Drug pricing pressure.',
            driver: 'Healthcare momentum',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 66,
        compositeLabel: 'risk-on',
        cnnFearGreed: 62,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [
          { symbol: 'XLV', name: 'Healthcare', change: 1.9 },
        ],
      },
      marketBreadth: {
        currentPctAbove20d: 61,
        currentPctAbove50d: 58,
        currentPctAbove200d: 52,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: {
        earnings: [
          {
            symbol: 'LLY',
            company: 'Eli Lilly',
            date: isoDatePlus(1),
            hour: 'bmo',
            epsEstimate: 2.3,
            revenueEstimate: 1000000000,
            epsActual: 0,
            revenueActual: 0,
            hasActuals: false,
            surpriseDirection: '',
          },
          {
            symbol: 'UNH',
            company: 'UnitedHealth',
            date: isoDatePlus(0),
            hour: 'amc',
            epsEstimate: 5.2,
            revenueEstimate: 1000000000,
            epsActual: 5.5,
            revenueActual: 1050000000,
            hasActuals: true,
            surpriseDirection: 'beat',
          },
          {
            symbol: 'JNJ',
            company: 'Johnson & Johnson',
            date: isoDatePlus(0),
            hour: 'amc',
            epsEstimate: 2.1,
            revenueEstimate: 1000000000,
            epsActual: 2.3,
            revenueActual: 1030000000,
            hasActuals: true,
            surpriseDirection: 'beat',
          },
        ],
        fromDate: isoDatePlus(0),
        toDate: isoDatePlus(14),
        total: 3,
        unavailable: false,
      },
      economicCalendar: null,
      news,
    });

    const lly = view.candidates.find((candidate) => candidate.symbol === 'LLY');
    assert.ok(lly);
    assert.ok(lly!.drivers.some((driver) => /Sector breadth: Healthcare breadth is strong/i.test(driver)));
    assert.ok(lly!.drivers.some((driver) => /Healthcare earnings cluster is supportive: 2 beats vs 0 misses/i.test(driver)));
  });

  it('uses related peers for confirmation when linked equities move together', () => {
    const view = buildIdeaRadarViewModel({
      markets: [
        ...markets,
        { symbol: 'MSFT', name: 'Microsoft', display: 'MSFT', price: 420, change: 2.2, sparkline: [410, 412, 416, 420] },
        { symbol: 'GOOGL', name: 'Alphabet', display: 'GOOGL', price: 182, change: 1.8, sparkline: [178, 179, 180, 182] },
      ],
      predictions: [],
      portfolio,
      portfolioTargets,
      implications: {
        cards: [
          {
            ticker: 'AAPL',
            name: 'Apple',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'Mega-cap tech breadth remains firm',
            narrative: 'Platform strength remains broad.',
            riskCaveat: 'Consumer hardware slowdown.',
            driver: 'Mega-cap momentum',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 67,
        compositeLabel: 'risk-on',
        cnnFearGreed: 64,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 1.7 }],
      },
      marketBreadth: {
        currentPctAbove20d: 63,
        currentPctAbove50d: 61,
        currentPctAbove200d: 54,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      news,
    });

    const aapl = view.candidates.find((candidate) => candidate.symbol === 'AAPL');
    assert.ok(aapl);
    assert.ok(aapl!.drivers.some((driver) => /Peer confirmation: MSFT 2.2%, GOOGL 1.8% confirm the move/i.test(driver)));
    assert.ok(aapl!.drivers.some((driver) => /broad follow-through/i.test(driver)));
  });

  it('uses related peer news confirmation when linked companies are also in coverage', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions: [],
      portfolio,
      portfolioTargets,
      implications: {
        cards: [
          {
            ticker: 'AAPL',
            name: 'Apple',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'Apple ecosystem strength remains broad',
            narrative: 'Hardware and services demand stay resilient.',
            riskCaveat: 'Consumer spending slows.',
            driver: 'Platform resilience',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 65,
        compositeLabel: 'risk-on',
        cnnFearGreed: 63,
      },
      backtests: [],
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 1.4 }],
      },
      marketBreadth: {
        currentPctAbove20d: 60,
        currentPctAbove50d: 57,
        currentPctAbove200d: 53,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      news: [
        ...news,
        {
          source: 'CNBC',
          title: 'Microsoft leans into AI copilots as services demand holds up',
          link: 'https://example.com/msft-peer-news',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'Microsoft and Azure services remain central to software spending.',
        },
        {
          source: 'Reuters',
          title: 'Alphabet boosts cloud and services spending as Google demand stays firm',
          link: 'https://example.com/googl-peer-news',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'Google and Alphabet services continue to support the mega-cap tech narrative.',
        },
      ],
    });

    const aapl = view.candidates.find((candidate) => candidate.symbol === 'AAPL');
    assert.ok(aapl);
    assert.ok(aapl!.drivers.some((driver) => /Peer news confirmation: Microsoft Corporation, Alphabet Inc\. share the same narrative \(services, demand\)/i.test(driver)));
  });

  it('uses crypto peer graph confirmation for related assets', () => {
    const view = buildIdeaRadarViewModel({
      markets: [
        ...markets,
        { symbol: 'ETH', name: 'Ethereum', display: 'ETH', price: 4100, change: 3.1, sparkline: [3920, 3980, 4040, 4100] },
        { symbol: 'SOL', name: 'Solana', display: 'SOL', price: 220, change: 2.4, sparkline: [210, 214, 217, 220] },
      ],
      predictions: [
        { title: 'Will Bitcoin trade above $120k this year?', yesPrice: 68, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
      ],
      portfolio,
      portfolioTargets,
      implications: null,
      regimeContext: {
        compositeScore: 69,
        compositeLabel: 'risk-on',
        cnnFearGreed: 66,
      },
      backtests: [],
      etfFlows: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          etfCount: 10,
          totalVolume: 1000000,
          totalEstFlow: 180000000,
          netDirection: 'NET_INFLOW',
          inflowCount: 7,
          outflowCount: 3,
        },
        etfs: [],
        rateLimited: false,
      },
      stablecoinMarkets: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          totalMarketCap: 100000000000,
          totalVolume24h: 50000000000,
          coinCount: 5,
          depeggedCount: 0,
          healthStatus: 'HEALTHY',
        },
        stablecoins: [],
      },
      cryptoSectors: {
        sectors: [
          { id: 'layer1', name: 'Layer 1', change: 2.8 },
          { id: 'infra', name: 'Infrastructure', change: 1.9 },
        ],
      },
      sectorSummary: null,
      marketBreadth: null,
      earningsCalendar: null,
      economicCalendar: null,
      news: [
        ...news,
        {
          source: 'CoinDesk',
          title: 'Ethereum and Solana rally as blockchain activity accelerates',
          link: 'https://example.com/eth-sol-peer-news',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'Ethereum and Solana both benefit from stronger blockchain demand.',
        },
      ],
    });

    const btc = view.candidates.find((candidate) => candidate.symbol === 'BTC');
    assert.ok(btc);
    assert.ok(btc!.drivers.some((driver) => /Peer confirmation: ETH 3.1%, SOL 2.4% confirm the move/i.test(driver)));
    assert.ok(btc!.drivers.some((driver) => /Peer news confirmation: Ethereum, Solana share the same narrative \(blockchain\)/i.test(driver)));
    assert.equal(btc!.scoreMix[0]?.label, 'Flow');
    assert.ok(btc!.themeStrength.score >= 45);
    assert.match(btc!.themeStrength.label, /Building|Confirmed/);
  });

  it('reduces crypto recurring drag when the order-flow regime improves', () => {
    const view = buildIdeaRadarViewModel({
      markets: [
        ...markets,
        { symbol: 'BTC', name: 'Bitcoin', display: 'BTC', price: 112000, change: 2.7, sparkline: [108000, 109500, 110500, 112000] },
        { symbol: 'ETH', name: 'Ethereum', display: 'ETH', price: 4100, change: 3.1, sparkline: [3920, 3980, 4040, 4100] },
        { symbol: 'SOL', name: 'Solana', display: 'SOL', price: 220, change: 2.4, sparkline: [210, 214, 217, 220] },
      ],
      predictions: [
        { title: 'Will Bitcoin trade above $120k this year?', yesPrice: 68, volume: 1250000, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
      ],
      portfolio,
      portfolioTargets,
      reviewHistory: {
        'BTC:1w': {
          count: 3,
          firstSeenAt: '2026-05-20T00:00:00.000Z',
          lastSeenAt: '2026-05-28T00:00:00.000Z',
          lastScore: 71,
          lastStance: 'watch',
          scoreBand: 'actionable',
          driverCluster: 'prediction',
          thesisFamily: 'crypto-etf-liquidity',
          scoreMix: [{ label: 'Flow', pct: 44 }, { label: 'Peer', pct: 28 }],
          themeStrength: { score: 56, label: 'Building' },
          orderFlowRegime: { score: 54, label: 'Mixed' },
        },
      },
      implications: null,
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      backtests: [],
      etfFlows: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          etfCount: 10,
          totalVolume: 1000000,
          totalEstFlow: 250000000,
          netDirection: 'NET_INFLOW',
          inflowCount: 8,
          outflowCount: 2,
        },
        etfs: [],
        rateLimited: false,
      },
      stablecoinMarkets: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          totalMarketCap: 100000000000,
          totalVolume24h: 50000000000,
          coinCount: 5,
          depeggedCount: 0,
          healthStatus: 'HEALTHY',
        },
        stablecoins: [],
      },
      cryptoSectors: {
        sectors: [
          { id: 'layer1', name: 'Layer 1', change: 4.2 },
          { id: 'defi', name: 'DeFi', change: 1.4 },
          { id: 'infra', name: 'Infrastructure', change: 2.1 },
        ],
      },
      hyperliquidFlow: {
        ts: '2026-05-28T10:00:00Z',
        fetchedAt: '2026-05-28T10:00:00Z',
        warmup: false,
        assetCount: 3,
        unavailable: false,
        assets: [
          {
            symbol: 'BTC',
            display: 'BTC',
            assetClass: 'crypto',
            group: 'majors',
            funding: '0.01',
            openInterest: '1200000000',
            markPx: '112000',
            oraclePx: '111900',
            dayNotional: '2500000000',
            fundingScore: 58,
            volumeScore: 74,
            oiScore: 68,
            basisScore: 61,
            composite: 77,
            sparkFunding: [55, 56, 58],
            sparkOi: [60, 64, 68],
            sparkScore: [70, 73, 77],
            warmup: false,
            stale: false,
            staleSince: '',
            missingPolls: 0,
            alerts: [],
          },
        ],
      },
      sectorSummary: null,
      marketBreadth: null,
      earningsCalendar: null,
      economicCalendar: null,
      news,
    });

    const btc = view.candidates.find((candidate) => candidate.symbol === 'BTC');
    assert.ok(btc);
    assert.equal(btc!.orderFlowRegime?.deltaFromHistory, 23);
    assert.notEqual(btc!.stance, 'avoid');
    assert.match(btc!.stanceReason ?? '', /order-flow|theme|confirmation/i);
    assert.match(btc!.stanceReason ?? '', /mix/i);
    assert.match(btc!.stanceReason ?? '', /flow \+\d+/i);
  });

  it('lets backtest consistency lift theme strength on multi-day equity ideas', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions: [],
      portfolio,
      portfolioTargets,
      implications: null,
      regimeContext: {
        compositeScore: 70,
        compositeLabel: 'risk-on',
        cnnFearGreed: 65,
      },
      backtests: [
        {
          available: true,
          symbol: 'PLTR',
          name: 'Palantir',
          display: 'PLTR',
          currency: 'USD',
          evalWindowDays: 10,
          evaluationsRun: 8,
          actionableEvaluations: 8,
          winRate: 61,
          directionAccuracy: 63,
          avgSimulatedReturnPct: 2.2,
          cumulativeSimulatedReturnPct: 17.6,
          latestSignal: 'buy',
          latestSignalScore: 78,
          summary: '',
          generatedAt: '2026-05-28T10:00:00',
          evaluations: [],
          engineVersion: 'test',
        },
      ],
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 1.8 }],
      },
      marketBreadth: {
        currentPctAbove20d: 66,
        currentPctAbove50d: 63,
        currentPctAbove200d: 55,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      news,
    });

    const pltr = view.candidates.find((candidate) => candidate.symbol === 'PLTR');
    assert.ok(pltr);
    assert.ok(pltr!.drivers.some((driver) => /Backtest win rate 61% over 8 signals/i.test(driver)));
    assert.ok(pltr!.themeStrength.score >= 40);
    assert.equal(pltr!.backtestConsistency?.winRate, 61);
    assert.equal(pltr!.backtestConsistency?.actionableSignals, 8);
  });

  it('keeps backtest consistency deltas on recurring ideas inside the same thesis family', () => {
    const baseOptions = {
      markets: [{ symbol: 'PLTR', name: 'Palantir', display: 'PLTR', price: 42, change: 3.1, sparkline: [39.5, 40.1, 41.2, 42] }],
      predictions,
      portfolio,
      portfolioTargets,
      stockAnalyses: {
        PLTR: {
          available: true,
          symbol: 'PLTR',
          name: 'Palantir',
          display: 'PLTR',
          currency: 'USD',
          currentPrice: 42,
          changePercent: 3.1,
          signalScore: 78,
          signal: 'Buy',
          trendStatus: 'Strong',
          volumeStatus: 'Heavy',
          macdStatus: 'Bullish',
          rsiStatus: 'Constructive',
          summary: '',
          action: 'Watch',
          confidence: 'HIGH',
          technicalSummary: 'Constructive tape.',
          newsSummary: '',
          whyNow: '',
          bullishFactors: [],
          riskFactors: [],
          supportLevels: [],
          resistanceLevels: [],
          headlines: [],
          ma5: 0,
          ma10: 0,
          ma20: 0,
          ma60: 0,
          biasMa5: 0,
          biasMa10: 0,
          biasMa20: 0,
          volumeRatio5d: 2.4,
          rsi12: 0,
          macdDif: 0,
          macdDea: 0,
          macdBar: 0,
          provider: 'test',
          model: 'test',
          fallback: false,
          newsSearched: false,
          generatedAt: '2026-05-28T10:00:00',
          analysisId: 'pltr-test',
          analysisAt: 0,
          stopLoss: 0,
          takeProfit: 0,
          engineVersion: 'test',
          recentUpgrades: [],
          dividendYield: 0,
          trailingAnnualDividendRate: 0,
          exDividendDate: 0,
          dividendFrequency: '',
          dividendCagr: 0,
        },
      },
      implications: null,
      regimeContext: {
        compositeScore: 70,
        compositeLabel: 'risk-on',
        cnnFearGreed: 65,
      },
      backtests: [
        {
          available: true,
          symbol: 'PLTR',
          name: 'Palantir',
          display: 'PLTR',
          currency: 'USD',
          evalWindowDays: 10,
          evaluationsRun: 8,
          actionableEvaluations: 8,
          winRate: 61,
          directionAccuracy: 63,
          avgSimulatedReturnPct: 2.2,
          cumulativeSimulatedReturnPct: 17.6,
          latestSignal: 'buy',
          latestSignalScore: 78,
          summary: '',
          generatedAt: '2026-05-28T10:00:00',
          evaluations: [],
          engineVersion: 'test',
        },
      ],
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 1.8 }],
      },
      marketBreadth: {
        currentPctAbove20d: 66,
        currentPctAbove50d: 63,
        currentPctAbove200d: 55,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: null,
      economicCalendar: null,
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      news,
    };

    const reviewEntry = {
      count: 3,
      firstSeenAt: '2026-05-20T00:00:00.000Z',
      lastSeenAt: '2026-05-28T00:00:00.000Z',
      lastScore: 66,
      lastStance: 'watch',
      scoreBand: 'developing',
      driverCluster: 'breadth',
      thesisFamily: 'platform-software',
      scoreMix: [{ label: 'Momentum', pct: 48 }, { label: 'Breadth', pct: 22 }],
      themeStrength: { score: 58, label: 'Confirmed' },
      shortTermConfirmation: { score: 38, label: 'Developing' },
    };

    const view = buildIdeaRadarViewModel({
      ...baseOptions,
      reviewHistory: {
        'PLTR:1h': {
          ...reviewEntry,
          backtestConsistency: { winRate: 52, actionableSignals: 8 },
        },
      },
    });

    const pltr = view.candidates.find((candidate) => candidate.symbol === 'PLTR');
    assert.ok(pltr);
    assert.ok(pltr!.drivers.some((driver) => /recurring idea/i.test(driver)));
    assert.equal(pltr!.backtestConsistency?.deltaFromHistory, 9);
    assert.equal(pltr!.shortTermConfirmation?.deltaFromHistory, pltr!.shortTermConfirmation!.score - 38);
    assert.ok(pltr!.shortTermConfirmation?.basisChange == null || /Momentum|Flow|Peer|Breadth/.test(pltr!.shortTermConfirmation.basisChange));
  });

  it('classifies crypto ideas into richer thesis families', () => {
    const view = buildIdeaRadarViewModel({
      markets: [
        ...markets,
        { symbol: 'BTC', name: 'Bitcoin', display: 'BTC', price: 112000, change: 2.7, sparkline: [108000, 109500, 110500, 112000] },
        { symbol: 'ETH', name: 'Ethereum', display: 'ETH', price: 4100, change: 3.1, sparkline: [3920, 3980, 4040, 4100] },
        { symbol: 'SOL', name: 'Solana', display: 'SOL', price: 220, change: 2.4, sparkline: [210, 214, 217, 220] },
      ],
      predictions: [
        { title: 'Will Bitcoin trade above $120k this year?', yesPrice: 68, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
        { title: 'Will Solana stay above $300 this year?', yesPrice: 66, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
      ],
      portfolio,
      portfolioTargets,
      implications: null,
      regimeContext: {
        compositeScore: 69,
        compositeLabel: 'risk-on',
        cnnFearGreed: 66,
      },
      watchlistSymbols: ['BTC', 'SOL'],
      backtests: [],
      etfFlows: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          etfCount: 10,
          totalVolume: 1000000,
          totalEstFlow: 180000000,
          netDirection: 'NET_INFLOW',
          inflowCount: 7,
          outflowCount: 3,
        },
        etfs: [],
        rateLimited: false,
      },
      stablecoinMarkets: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          totalMarketCap: 100000000000,
          totalVolume24h: 50000000000,
          coinCount: 5,
          depeggedCount: 0,
          healthStatus: 'HEALTHY',
        },
        stablecoins: [],
      },
      cryptoSectors: {
        sectors: [
          { id: 'layer1', name: 'Layer 1', change: 2.8 },
          { id: 'infra', name: 'Infrastructure', change: 1.9 },
        ],
      },
      sectorSummary: null,
      marketBreadth: null,
      earningsCalendar: null,
      economicCalendar: null,
      news: [
        ...news,
        {
          source: 'CoinDesk',
          title: 'Ethereum and Solana rally as blockchain activity accelerates',
          link: 'https://example.com/eth-sol-peer-news',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'Ethereum and Solana both benefit from stronger blockchain demand.',
        },
      ],
    });

    assert.equal(view.nextReviewHistory?.['BTC:1w']?.thesisFamily, 'crypto-etf-liquidity');
    assert.equal(view.nextReviewHistory?.['SOL:1w']?.thesisFamily, 'crypto-infrastructure');
  });

  it('penalizes crypto ideas when the crypto sleeve is already above budget', () => {
    const cryptoHeavyPortfolio: PersonalPortfolioExport = {
      ...portfolio,
      currency: [{ currency: 'USD', weight_pct: 72 }, { currency: 'JPY', weight_pct: 28 }],
      holdings: [
        { ticker: 'BTC', name: 'Bitcoin', account: 'SBI', currency: 'USD', weight_pct: 18, gain_pct: 20, priced: true },
        { ticker: 'NVDA', name: 'NVIDIA', account: 'SBI', currency: 'USD', weight_pct: 38, gain_pct: 15, priced: true },
        { ticker: 'SMH', name: 'VanEck Semiconductor ETF', account: 'SBI', currency: 'USD', weight_pct: 22, gain_pct: 9, priced: true },
      ],
      summary: { holding_count: 3, account_count: 1, total_gain_pct: 12, cached_prices: true },
      risk_rules: [{ rule_id: 'R1', name: '集中度', ok: false, severity: 'alert', message: 'concentration high' }],
    };

    const view = buildIdeaRadarViewModel({
      markets,
      predictions: [
        { title: 'Will Solana stay above $300 this year?', yesPrice: 66, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
      ],
      portfolio: cryptoHeavyPortfolio,
      portfolioTargets,
      implications: null,
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      backtests: [],
      etfFlows: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          etfCount: 10,
          totalVolume: 1000000,
          totalEstFlow: 250000000,
          netDirection: 'NET_INFLOW',
          inflowCount: 8,
          outflowCount: 2,
        },
        etfs: [],
        rateLimited: false,
      },
      sectorSummary: {
        sectors: [
          { symbol: 'XLK', name: 'Technology', change: -1.4 },
        ],
      },
      marketBreadth: {
        currentPctAbove20d: 34,
        currentPctAbove50d: 36,
        currentPctAbove200d: 41,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      stablecoinMarkets: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          totalMarketCap: 100000000000,
          totalVolume24h: 50000000000,
          coinCount: 5,
          depeggedCount: 0,
          healthStatus: 'HEALTHY',
        },
        stablecoins: [],
      },
      cryptoSectors: {
        sectors: [
          { id: 'layer1', name: 'Layer 1', change: -2.5 },
          { id: 'defi', name: 'DeFi', change: -1.2 },
        ],
      },
      earningsCalendar: {
        earnings: [],
        fromDate: isoDatePlus(0),
        toDate: isoDatePlus(14),
        total: 0,
        unavailable: false,
      },
      economicCalendar: {
        events: [
          {
            event: 'Fed Decision',
            country: 'US',
            date: isoDatePlus(3),
            impact: 'high',
            actual: '',
            estimate: '',
            previous: '',
            unit: '',
          },
        ],
        fromDate: isoDatePlus(0),
        toDate: isoDatePlus(14),
        total: 1,
        unavailable: false,
      },
      news,
    });

    const solCandidate = view.candidates.find((candidate) => candidate.symbol === 'SOL');
    assert.ok(solCandidate);
    assert.ok((solCandidate?.portfolioFitScore ?? 100) <= 45);
    assert.match(solCandidate?.portfolioFitRationale ?? '', /Crypto sleeve is already 18.0%/);
    assert.match(solCandidate?.portfolioFitRationale ?? '', /Top position is already 38.0%/);
    assert.ok(solCandidate?.drivers.some((driver) => /Personal rule pressure: concentration/i.test(driver)));
    assert.ok(solCandidate?.drivers.some((driver) => /Macro catalyst/i.test(driver)));
  });

  it('surfaces earnings and macro surprises when actual results are available', () => {
    const view = buildIdeaRadarViewModel({
      markets: [{ symbol: 'AVGO', name: 'Broadcom', display: 'AVGO', price: 210, change: 2.4, sparkline: [204, 206, 208, 210] }],
      predictions,
      portfolio,
      portfolioTargets,
      implications: {
        cards: [
          {
            ticker: 'AVGO',
            name: 'Broadcom',
            direction: 'LONG',
            timeframe: '1-2 weeks',
            confidence: 'HIGH',
            title: 'AI infra demand remains strong',
            narrative: 'Networking leverage to AI capex.',
            riskCaveat: 'Capex slowdown.',
            driver: 'AI infra',
            transmissionChain: [],
          },
        ],
        degraded: false,
        emptyReason: '',
        generatedAt: '2026-05-28T10:00:00',
      },
      regimeContext: {
        compositeScore: 72,
        compositeLabel: 'risk-on',
        cnnFearGreed: 68,
      },
      backtests: [],
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 2.1 }],
      },
      marketBreadth: {
        currentPctAbove20d: 69,
        currentPctAbove50d: 66,
        currentPctAbove200d: 58,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: {
        earnings: [
          {
            symbol: 'AVGO',
            company: 'Broadcom',
            date: isoDatePlus(0),
            hour: 'amc',
            epsEstimate: 1.2,
            revenueEstimate: 1000000000,
            epsActual: 1.45,
            revenueActual: 1100000000,
            hasActuals: true,
            surpriseDirection: 'beat',
          },
        ],
        fromDate: isoDatePlus(-1),
        toDate: isoDatePlus(14),
        total: 1,
        unavailable: false,
      },
      economicCalendar: {
        events: [
          {
            event: 'CPI',
            country: 'US',
            date: isoDatePlus(0),
            impact: 'high',
            actual: '3.0',
            estimate: '3.2',
            previous: '3.4',
            unit: '%',
          },
        ],
        fromDate: isoDatePlus(-1),
        toDate: isoDatePlus(14),
        total: 1,
        unavailable: false,
      },
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      news,
    });

    const avgo = view.candidates.find((candidate) => candidate.symbol === 'AVGO');
    assert.ok(avgo);
    assert.ok(avgo!.drivers.some((driver) => /Earnings reported today \(beat, EPS delta \+0\.25\)/.test(driver)));
    assert.ok(avgo!.drivers.some((driver) => /Macro surprise: CPI came in cooler than expected \(3 vs 3\.2\)/.test(driver)));
    assert.ok(avgo!.drivers.some((driver) => /\[inflation\]/.test(driver)));
    assert.ok(avgo!.scoreMix.some((item) => item.label === 'Inflation'));
    assert.ok((avgo?.score ?? 0) >= 80);
  });

  it('covers payroll and retail-sales macro surprises', () => {
    const view = buildIdeaRadarViewModel({
      markets: [{ symbol: 'PLTR', name: 'Palantir', display: 'PLTR', price: 42, change: 3.1, sparkline: [39.5, 40.1, 41.2, 42] }],
      predictions,
      portfolio,
      portfolioTargets,
      implications: null,
      regimeContext: {
        compositeScore: 70,
        compositeLabel: 'risk-on',
        cnnFearGreed: 65,
      },
      backtests: [],
      sectorSummary: {
        sectors: [{ symbol: 'XLK', name: 'Technology', change: 1.8 }],
      },
      marketBreadth: {
        currentPctAbove20d: 66,
        currentPctAbove50d: 63,
        currentPctAbove200d: 55,
        updatedAt: new Date().toISOString(),
        history: [],
        unavailable: false,
      },
      earningsCalendar: {
        earnings: [],
        fromDate: isoDatePlus(-1),
        toDate: isoDatePlus(14),
        total: 0,
        unavailable: false,
      },
      economicCalendar: {
        events: [
          {
            event: 'Nonfarm Payrolls',
            country: 'US',
            date: isoDatePlus(0),
            impact: 'high',
            actual: '240',
            estimate: '190',
            previous: '175',
            unit: 'k',
          },
          {
            event: 'Retail Sales',
            country: 'US',
            date: isoDatePlus(0),
            impact: 'high',
            actual: '0.8',
            estimate: '0.4',
            previous: '0.2',
            unit: '%',
          },
        ],
        fromDate: isoDatePlus(-1),
        toDate: isoDatePlus(14),
        total: 2,
        unavailable: false,
      },
      etfFlows: null,
      stablecoinMarkets: null,
      cryptoSectors: null,
      news,
    });

    const pltr = view.candidates.find((candidate) => candidate.symbol === 'PLTR');
    assert.ok(pltr);
    assert.ok(pltr!.drivers.some((driver) => /Nonfarm Payrolls was stronger than expected \(240 vs 190\)/.test(driver)));
    assert.ok(pltr!.drivers.some((driver) => /\[labor\]/i.test(driver)));
  });

  it('interprets hawkish rate decisions and weak crypto breadth', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions: [
        { title: 'Will Ethereum stay above $5k this year?', yesPrice: 64, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
      ],
      portfolio,
      portfolioTargets,
      implications: null,
      regimeContext: {
        compositeScore: 58,
        compositeLabel: 'neutral',
        cnnFearGreed: 54,
      },
      backtests: [],
      etfFlows: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          etfCount: 10,
          totalVolume: 1000000,
          totalEstFlow: 50000000,
          netDirection: 'NET_OUTFLOW',
          inflowCount: 3,
          outflowCount: 7,
        },
        etfs: [],
        rateLimited: false,
      },
      stablecoinMarkets: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          totalMarketCap: 100000000000,
          totalVolume24h: 50000000000,
          coinCount: 5,
          depeggedCount: 1,
          healthStatus: 'CAUTION',
        },
        stablecoins: [],
      },
      cryptoSectors: {
        sectors: [
          { id: 'layer1', name: 'Layer 1', change: -3.1 },
          { id: 'defi', name: 'DeFi', change: -2.0 },
        ],
      },
      sectorSummary: null,
      marketBreadth: null,
      earningsCalendar: null,
      economicCalendar: {
        events: [
          {
            event: 'Fed Rate Decision',
            country: 'US',
            date: isoDatePlus(0),
            impact: 'high',
            actual: '5.50',
            estimate: '5.25',
            previous: '5.25',
            unit: '%',
          },
        ],
        fromDate: isoDatePlus(-1),
        toDate: isoDatePlus(14),
        total: 1,
        unavailable: false,
      },
      news: [
        ...news,
        {
          source: 'WSJ',
          title: 'Federal Reserve officials strike a hawkish tone after the latest dot plot',
          link: 'https://example.com/fomc-hawkish',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'Markets reprice higher-for-longer rates and price out cuts after the FOMC update.',
        },
        {
          source: 'Bloomberg',
          title: 'Powell press conference keeps a hawkish bias in focus',
          link: 'https://example.com/powell-press',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'The statement and press conference stressed sticky inflation and fewer cuts ahead.',
        },
      ],
    });

    const eth = view.candidates.find((candidate) => candidate.symbol === 'ETH');
    assert.ok(eth);
    assert.ok(eth!.drivers.some((driver) => /more hawkish than expected \(5\.5 vs 5\.25\)/.test(driver)));
    assert.ok(eth!.drivers.some((driver) => /\[policy\]/i.test(driver)));
    assert.ok(eth!.scoreMix.some((item) => item.label === 'Policy'));
    assert.ok(eth!.drivers.some((driver) => /Crypto breadth: 0\/2 sectors green/i.test(driver)));
    assert.ok(eth!.drivers.some((driver) => /FOMC context: recent Fed coverage leans hawkish/i.test(driver)));
    assert.ok(eth!.drivers.some((driver) => /statement or press-conference language/i.test(driver)));
    assert.ok(eth!.drivers.some((driver) => /rate-path repricing/i.test(driver)));
    assert.ok(eth!.drivers.some((driver) => /\[hawkish bias, statement coverage, higher-for-longer repricing\]/i.test(driver)));
    assert.ok(eth!.themeStrength.score >= 40);
    assert.match(eth!.themeStrength.label, /Building|Confirmed/);
  });

  it('interprets dovish Fed minutes and transcript language', () => {
    const view = buildIdeaRadarViewModel({
      markets,
      predictions: [
        { title: 'Will Bitcoin trade above $120k this year?', yesPrice: 68, source: 'polymarket', endDate: '2099-01-01T00:00:00.000Z' },
      ],
      portfolio,
      portfolioTargets,
      implications: null,
      regimeContext: {
        compositeScore: 61,
        compositeLabel: 'risk-on',
        cnnFearGreed: 60,
      },
      backtests: [],
      etfFlows: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          etfCount: 10,
          totalVolume: 1000000,
          totalEstFlow: 125000000,
          netDirection: 'NET_INFLOW',
          inflowCount: 6,
          outflowCount: 4,
        },
        etfs: [],
        rateLimited: false,
      },
      stablecoinMarkets: {
        timestamp: '2026-05-28T10:00:00Z',
        summary: {
          totalMarketCap: 100000000000,
          totalVolume24h: 50000000000,
          coinCount: 5,
          depeggedCount: 0,
          healthStatus: 'HEALTHY',
        },
        stablecoins: [],
      },
      cryptoSectors: {
        sectors: [
          { id: 'layer1', name: 'Layer 1', change: 2.4 },
          { id: 'infra', name: 'Infrastructure', change: 1.8 },
        ],
      },
      sectorSummary: null,
      marketBreadth: null,
      earningsCalendar: null,
      economicCalendar: null,
      news: [
        ...news,
        {
          source: 'Bloomberg',
          title: 'Fed minutes show greater confidence on inflation as officials discuss slower runoff',
          link: 'https://example.com/fed-minutes-dovish',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'Meeting minutes signaled room to ease and tapering runoff if labor market cooling continues.',
        },
        {
          source: 'Reuters',
          title: 'Powell transcript reinforces dovish turn in prepared remarks',
          link: 'https://example.com/powell-transcript-dovish',
          pubDate: new Date(),
          isAlert: false,
          snippet: 'Markets price in earlier cuts and a lower terminal rate after the press Q&A.',
        },
      ],
    });

    const btc = view.candidates.find((candidate) => candidate.symbol === 'BTC');
    assert.ok(btc);
    assert.ok(btc!.drivers.some((driver) => /FOMC context: recent Fed coverage leans dovish/i.test(driver)));
    assert.ok(btc!.drivers.some((driver) => /minutes or transcript language/i.test(driver)));
    assert.ok(btc!.drivers.some((driver) => /balance-sheet runoff language/i.test(driver)));
    assert.ok(btc!.drivers.some((driver) => /\[statement coverage, minutes\/transcript, inflation progress\]/i.test(driver)));
  });
});
