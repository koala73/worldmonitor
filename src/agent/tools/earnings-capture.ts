/**
 * Earnings Call Capture Monitor — tracks earnings announcements,
 * conference call schedules, and key metrics across all SP500 sectors.
 *
 * Monitors:
 * - Upcoming earnings dates for sector top holdings
 * - EPS beat/miss detection
 * - Revenue surprise signals
 * - Forward guidance changes
 * - Earnings-driven sector rotation signals
 * - Cross-sector earnings momentum
 */

import type { Signal, Severity } from '../types';
import { registerTool, createSignal } from './registry';
import { SP500_SECTORS, ALL_SP500_HOLDINGS, type SectorDefinition } from './sp500-sectors';

// ============================================================================
// EARNINGS CALENDAR & TRACKING
// ============================================================================

export interface EarningsEvent {
  symbol: string;
  company: string;
  sector: string;
  reportDate: string;
  fiscalQuarter: string;
  estimatedEps: number | null;
  actualEps: number | null;
  estimatedRevenue: number | null;
  actualRevenue: number | null;
  surprise: number | null;
  revenueSurprise: number | null;
  guidanceDirection: 'raised' | 'maintained' | 'lowered' | 'none' | null;
  callTime: 'pre-market' | 'after-hours' | 'during-market' | null;
  status: 'upcoming' | 'reported' | 'confirmed';
}

export interface SectorEarningsMomentum {
  sector: string;
  etf: string;
  totalReported: number;
  beatCount: number;
  missCount: number;
  meetCount: number;
  avgSurprise: number;
  revenueBeats: number;
  guidanceRaised: number;
  guidanceLowered: number;
  momentum: 'strong' | 'positive' | 'neutral' | 'negative' | 'weak';
}

// ============================================================================
// EARNINGS CAPTURE TOOL
// ============================================================================

registerTool({
  id: 'market.earnings',
  name: 'Earnings Call Capture Monitor',
  description: 'Tracks earnings announcements, EPS/revenue surprises, and forward guidance across all SP500 sectors',
  domains: ['economic'],
  inputSchema: {
    type: 'object',
    properties: {
      sector: { type: 'string', description: 'Filter to specific sector name' },
      symbols: { type: 'array', items: { type: 'string' }, description: 'Filter to specific symbols' },
      lookbackDays: { type: 'number', description: 'Days to look back for reported earnings' },
      lookforwardDays: { type: 'number', description: 'Days to look forward for upcoming earnings' },
    },
  },
  outputDomain: 'economic',
  concurrency: 2,
  timeout: 45_000,
  async execute(input) {
    const lookbackDays = (input.lookbackDays as number) ?? 14;
    const sectorFilter = input.sector as string | undefined;
    const symbolFilter = input.symbols as string[] | undefined;

    // Determine which symbols to monitor
    let targetSymbols: string[];
    if (symbolFilter) {
      targetSymbols = symbolFilter;
    } else if (sectorFilter) {
      const sector = SP500_SECTORS.find(s =>
        s.name.toLowerCase() === sectorFilter.toLowerCase() ||
        s.etf === sectorFilter.toUpperCase()
      );
      targetSymbols = sector ? sector.topHoldings : ALL_SP500_HOLDINGS;
    } else {
      targetSymbols = ALL_SP500_HOLDINGS;
    }

    // Fetch earnings data via news and market services
    const signals: Signal[] = [];

    // Use GDELT + news to find earnings-related headlines
    const { IntelligenceServiceClient } = await import(
      '@/generated/client/worldmonitor/intelligence/v1/service_client'
    );
    const clientOpts = { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) };

    const intelClient = new IntelligenceServiceClient('', clientOpts);

    // Search for earnings-related news across all target symbols
    const earningsQueries = buildEarningsQueries(targetSymbols, sectorFilter);

    for (const query of earningsQueries) {
      try {
        const gdeltResp = await intelClient.searchGdeltDocuments({
          query: query.query,
          maxRecords: 25,
          timespan: `${lookbackDays}d`,
        });

        for (const article of gdeltResp.articles ?? []) {
          const earningsData = parseEarningsFromHeadline(article.title, targetSymbols);
          if (!earningsData) continue;

          const sector = findSectorForSymbol(earningsData.symbol);
          const severity = earningsSeverity(earningsData);

          signals.push(createSignal('economic', {
            sourceId: `earnings-${earningsData.symbol}-${article.url.slice(-20)}`,
            severity,
            regions: ['US'],
            timestamp: article.date
              ? new Date(article.date).getTime()
              : Date.now(),
            payload: {
              type: 'earnings_event',
              symbol: earningsData.symbol,
              sector: sector?.name ?? 'Unknown',
              sectorEtf: sector?.etf ?? '',
              headline: article.title,
              source: article.source,
              url: article.url,
              surprise: earningsData.surprise,
              guidance: earningsData.guidance,
              sentiment: earningsData.sentiment,
              tone: article.tone,
            },
            confidence: earningsData.confidence,
            tags: [
              'earnings',
              earningsData.symbol.toLowerCase(),
              sector?.name.toLowerCase() ?? '',
              earningsData.surprise === 'beat' ? 'eps-beat' : earningsData.surprise === 'miss' ? 'eps-miss' : '',
              earningsData.guidance ?? '',
            ].filter(Boolean),
            provenance: 'tool:market.earnings',
          }));
        }
      } catch {
        // Individual query failures are non-fatal
      }
    }

    // Generate sector momentum signals
    const sectorMomentum = computeSectorEarningsMomentum(signals);
    for (const momentum of sectorMomentum) {
      if (momentum.totalReported < 2) continue;

      const severity = momentumSeverity(momentum);
      signals.push(createSignal('economic', {
        sourceId: `earnings-momentum-${momentum.etf}`,
        severity,
        regions: ['US'],
        timestamp: Date.now(),
        payload: {
          type: 'sector_earnings_momentum',
          ...momentum,
        },
        confidence: Math.min(0.95, 0.5 + momentum.totalReported * 0.05),
        tags: [
          'earnings',
          'sector-momentum',
          momentum.sector.toLowerCase(),
          momentum.momentum,
        ],
        provenance: 'tool:market.earnings',
      }));
    }

    return signals;
  },
});

// ============================================================================
// EARNINGS PARSING & ANALYSIS
// ============================================================================

interface ParsedEarnings {
  symbol: string;
  surprise: 'beat' | 'miss' | 'meet' | null;
  guidance: 'raised' | 'lowered' | 'maintained' | null;
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number;
}

const BEAT_PATTERNS = [
  /beats?\s+(estimates?|expectations?|consensus)/i,
  /tops?\s+(estimates?|expectations?)/i,
  /exceeds?\s+(estimates?|expectations?)/i,
  /better[\s-]than[\s-]expected/i,
  /blowout\s+quarter/i,
  /earnings\s+surprise/i,
  /strong\s+(quarter|results?|earnings?)/i,
];

const MISS_PATTERNS = [
  /miss(es)?\s+(estimates?|expectations?|consensus)/i,
  /falls?\s+short/i,
  /worse[\s-]than[\s-]expected/i,
  /disappointing\s+(quarter|results?|earnings?)/i,
  /weak\s+(quarter|results?|earnings?)/i,
  /earnings\s+miss/i,
];

const GUIDANCE_RAISED = [
  /raise[sd]?\s+(guidance|outlook|forecast)/i,
  /upward\s+revision/i,
  /lifts?\s+(guidance|outlook)/i,
  /increases?\s+forecast/i,
  /boosts?\s+(guidance|outlook)/i,
];

const GUIDANCE_LOWERED = [
  /lower[sed]?\s+(guidance|outlook|forecast)/i,
  /cut[s]?\s+(guidance|outlook|forecast)/i,
  /downward\s+revision/i,
  /warns?\s+(on|about)\s+(outlook|guidance)/i,
  /slashes?\s+(guidance|forecast)/i,
];

function parseEarningsFromHeadline(title: string, symbols: string[]): ParsedEarnings | null {
  // Find which symbol this headline is about
  const matchedSymbol = symbols.find(sym => {
    const regex = new RegExp(`\\b${sym}\\b`, 'i');
    return regex.test(title);
  });

  if (!matchedSymbol) return null;

  // Determine surprise direction
  let surprise: ParsedEarnings['surprise'] = null;
  if (BEAT_PATTERNS.some(p => p.test(title))) surprise = 'beat';
  else if (MISS_PATTERNS.some(p => p.test(title))) surprise = 'miss';

  // Determine guidance
  let guidance: ParsedEarnings['guidance'] = null;
  if (GUIDANCE_RAISED.some(p => p.test(title))) guidance = 'raised';
  else if (GUIDANCE_LOWERED.some(p => p.test(title))) guidance = 'lowered';

  // Only return if we found something meaningful
  if (!surprise && !guidance) {
    // Check if it's at least earnings-related
    if (!/earnings?|quarterly|results?|revenue|eps|profit/i.test(title)) {
      return null;
    }
  }

  const sentiment = surprise === 'beat' || guidance === 'raised'
    ? 'positive'
    : surprise === 'miss' || guidance === 'lowered'
      ? 'negative'
      : 'neutral';

  return {
    symbol: matchedSymbol,
    surprise,
    guidance,
    sentiment,
    confidence: (surprise ? 0.4 : 0) + (guidance ? 0.3 : 0) + 0.3,
  };
}

function buildEarningsQueries(
  symbols: string[],
  sectorFilter?: string,
): Array<{ query: string; sector?: string }> {
  const queries: Array<{ query: string; sector?: string }> = [];

  // Batch symbols into groups to avoid too many queries
  const batchSize = 10;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const symbolList = batch.join(' OR ');
    queries.push({
      query: `(${symbolList}) AND (earnings OR quarterly results OR EPS OR revenue)`,
      sector: sectorFilter,
    });
  }

  // Add sector-level earnings queries
  if (!sectorFilter) {
    queries.push({ query: 'S&P 500 earnings season results' });
    queries.push({ query: 'sector earnings rotation guidance' });
  }

  return queries;
}

function findSectorForSymbol(symbol: string): SectorDefinition | undefined {
  return SP500_SECTORS.find(s => s.topHoldings.includes(symbol));
}

function computeSectorEarningsMomentum(signals: Signal[]): SectorEarningsMomentum[] {
  const sectorMap = new Map<string, {
    beats: number;
    misses: number;
    meets: number;
    surprises: number[];
    revenueBeats: number;
    guidanceRaised: number;
    guidanceLowered: number;
  }>();

  for (const sig of signals) {
    const payload = sig.payload as Record<string, unknown>;
    if (payload.type !== 'earnings_event') continue;

    const sectorEtf = (payload.sectorEtf as string) || '';
    if (!sectorEtf) continue;

    if (!sectorMap.has(sectorEtf)) {
      sectorMap.set(sectorEtf, {
        beats: 0, misses: 0, meets: 0, surprises: [], revenueBeats: 0,
        guidanceRaised: 0, guidanceLowered: 0,
      });
    }
    const data = sectorMap.get(sectorEtf)!;

    if (payload.surprise === 'beat') data.beats++;
    else if (payload.surprise === 'miss') data.misses++;
    else data.meets++;

    if (payload.guidance === 'raised') data.guidanceRaised++;
    if (payload.guidance === 'lowered') data.guidanceLowered++;
  }

  const results: SectorEarningsMomentum[] = [];
  for (const [etf, data] of sectorMap) {
    const sector = SP500_SECTORS.find(s => s.etf === etf);
    if (!sector) continue;

    const total = data.beats + data.misses + data.meets;
    const beatRate = total > 0 ? data.beats / total : 0;
    const avgSurprise = data.surprises.length > 0
      ? data.surprises.reduce((a, b) => a + b, 0) / data.surprises.length
      : 0;

    let momentum: SectorEarningsMomentum['momentum'] = 'neutral';
    if (beatRate > 0.75 && data.guidanceLowered === 0) momentum = 'strong';
    else if (beatRate > 0.6) momentum = 'positive';
    else if (beatRate < 0.3 && data.guidanceLowered > data.guidanceRaised) momentum = 'weak';
    else if (beatRate < 0.5) momentum = 'negative';

    results.push({
      sector: sector.name,
      etf,
      totalReported: total,
      beatCount: data.beats,
      missCount: data.misses,
      meetCount: data.meets,
      avgSurprise,
      revenueBeats: data.revenueBeats,
      guidanceRaised: data.guidanceRaised,
      guidanceLowered: data.guidanceLowered,
      momentum,
    });
  }

  return results.sort((a, b) => b.totalReported - a.totalReported);
}

// ============================================================================
// SEVERITY HELPERS
// ============================================================================

function earningsSeverity(data: ParsedEarnings): Severity {
  if (data.surprise === 'miss' && data.guidance === 'lowered') return 'high';
  if (data.surprise === 'beat' && data.guidance === 'raised') return 'medium';
  if (data.surprise === 'miss' || data.guidance === 'lowered') return 'medium';
  return 'low';
}

function momentumSeverity(m: SectorEarningsMomentum): Severity {
  if (m.momentum === 'weak') return 'high';
  if (m.momentum === 'negative') return 'medium';
  if (m.momentum === 'strong') return 'medium';
  return 'low';
}
