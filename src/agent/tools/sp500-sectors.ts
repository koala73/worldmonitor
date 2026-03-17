/**
 * SP500 Sector Monitor — tracks all 11 GICS sectors with real-time
 * performance, rotation signals, and relative strength analysis.
 *
 * Sectors: Energy, Materials, Industrials, Consumer Discretionary,
 * Consumer Staples, Health Care, Financials, IT, Communication Services,
 * Utilities, Real Estate.
 *
 * Each sector is tracked via its SPDR ETF proxy.
 */

import type { Signal, Severity } from '../types';
import { registerTool, createSignal } from './registry';

// ============================================================================
// GICS SECTOR DEFINITIONS
// ============================================================================

export interface SectorDefinition {
  name: string;
  etf: string;
  gicsCode: string;
  keywords: string[];
  topHoldings: string[];
}

export const SP500_SECTORS: SectorDefinition[] = [
  {
    name: 'Energy',
    etf: 'XLE',
    gicsCode: '10',
    keywords: ['oil', 'gas', 'petroleum', 'crude', 'drilling', 'refining', 'pipeline', 'lng'],
    topHoldings: ['XOM', 'CVX', 'COP', 'EOG', 'SLB', 'MPC', 'PSX', 'VLO', 'WMB', 'OKE'],
  },
  {
    name: 'Materials',
    etf: 'XLB',
    gicsCode: '15',
    keywords: ['mining', 'chemicals', 'metals', 'lumber', 'copper', 'steel', 'gold', 'lithium'],
    topHoldings: ['LIN', 'SHW', 'FCX', 'APD', 'ECL', 'NEM', 'NUE', 'DOW', 'VMC', 'MLM'],
  },
  {
    name: 'Industrials',
    etf: 'XLI',
    gicsCode: '20',
    keywords: ['aerospace', 'defense', 'manufacturing', 'transport', 'logistics', 'construction'],
    topHoldings: ['GE', 'CAT', 'UNP', 'HON', 'RTX', 'UPS', 'BA', 'DE', 'LMT', 'ADP'],
  },
  {
    name: 'Consumer Discretionary',
    etf: 'XLY',
    gicsCode: '25',
    keywords: ['retail', 'automotive', 'luxury', 'housing', 'consumer spending', 'e-commerce'],
    topHoldings: ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'BKNG', 'SBUX', 'TJX', 'ABNB'],
  },
  {
    name: 'Consumer Staples',
    etf: 'XLP',
    gicsCode: '30',
    keywords: ['food', 'beverage', 'tobacco', 'household', 'grocery', 'personal care'],
    topHoldings: ['PG', 'KO', 'PEP', 'COST', 'WMT', 'PM', 'MO', 'MDLZ', 'CL', 'KMB'],
  },
  {
    name: 'Health Care',
    etf: 'XLV',
    gicsCode: '35',
    keywords: ['pharma', 'biotech', 'medical devices', 'health insurance', 'hospital', 'drug'],
    topHoldings: ['UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'BMY'],
  },
  {
    name: 'Financials',
    etf: 'XLF',
    gicsCode: '40',
    keywords: ['banking', 'insurance', 'investment', 'credit', 'mortgage', 'fintech', 'rates'],
    topHoldings: ['BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'SPGI', 'BLK'],
  },
  {
    name: 'Information Technology',
    etf: 'XLK',
    gicsCode: '45',
    keywords: ['software', 'hardware', 'semiconductor', 'cloud', 'ai', 'chip', 'saas', 'data center'],
    topHoldings: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'CRM', 'AMD', 'ADBE', 'CSCO', 'ACN', 'ORCL'],
  },
  {
    name: 'Communication Services',
    etf: 'XLC',
    gicsCode: '50',
    keywords: ['social media', 'streaming', 'telecom', 'advertising', 'content', 'gaming'],
    topHoldings: ['META', 'GOOG', 'GOOGL', 'NFLX', 'DIS', 'CMCSA', 'TMUS', 'VZ', 'T', 'CHTR'],
  },
  {
    name: 'Utilities',
    etf: 'XLU',
    gicsCode: '55',
    keywords: ['electric', 'power', 'grid', 'water', 'renewable', 'nuclear', 'utility'],
    topHoldings: ['NEE', 'SO', 'DUK', 'CEG', 'SRE', 'AEP', 'D', 'EXC', 'PCG', 'XEL'],
  },
  {
    name: 'Real Estate',
    etf: 'XLRE',
    gicsCode: '60',
    keywords: ['reit', 'property', 'commercial real estate', 'housing', 'mortgage', 'rent'],
    topHoldings: ['PLD', 'AMT', 'EQIX', 'CCI', 'PSA', 'SPG', 'WELL', 'DLR', 'O', 'VICI'],
  },
];

/** All top holdings across all sectors for quick lookup */
export const ALL_SP500_HOLDINGS: string[] = SP500_SECTORS.flatMap(s => s.topHoldings);

// ============================================================================
// SECTOR MONITOR TOOL
// ============================================================================

registerTool({
  id: 'market.sp500sectors',
  name: 'SP500 Sector Monitor',
  description: 'Monitors all 11 GICS sectors via ETF proxies for rotation, relative strength, and divergence signals',
  domains: ['economic'],
  inputSchema: {
    type: 'object',
    properties: {
      sectors: { type: 'array', items: { type: 'string' }, description: 'Filter to specific sector ETFs' },
    },
  },
  outputDomain: 'economic',
  concurrency: 2,
  timeout: 30_000,
  async execute(input) {
    const { MarketServiceClient } = await import(
      '@/generated/client/worldmonitor/market/v1/service_client'
    );
    const client = new MarketServiceClient('', { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

    const sectorFilter = input.sectors as string[] | undefined;
    const sectors = sectorFilter
      ? SP500_SECTORS.filter(s => sectorFilter.includes(s.etf))
      : SP500_SECTORS;

    // Fetch ETF quotes for all sectors
    const etfSymbols = sectors.map(s => s.etf);
    const resp = await client.listMarketQuotes({ symbols: etfSymbols });
    const quotes = resp.quotes ?? [];

    // Also fetch SPY as benchmark
    const benchResp = await client.listMarketQuotes({ symbols: ['SPY'] });
    const spyQuote = (benchResp.quotes ?? [])[0];
    const spyChange = spyQuote && spyQuote.price > 0
      ? (spyQuote.change / spyQuote.price) * 100
      : 0;

    const signals: Signal[] = [];

    for (const sector of sectors) {
      const quote = quotes.find(q => q.symbol === sector.etf);
      if (!quote) continue;

      // MarketQuote has `change` (absolute) and `price` — derive percent
      const changePercent = quote.price > 0 ? (quote.change / quote.price) * 100 : 0;
      const relativeStrength = changePercent - spyChange;

      // Detect rotation signals
      const severity = sectorSignalSeverity(changePercent, relativeStrength);
      const tags = ['sp500', 'sector', sector.name.toLowerCase()];

      if (Math.abs(relativeStrength) > 1.5) {
        tags.push(relativeStrength > 0 ? 'sector-leader' : 'sector-laggard');
      }
      if (Math.abs(changePercent) > 2) {
        tags.push(changePercent > 0 ? 'sector-surge' : 'sector-selloff');
      }

      signals.push(createSignal('economic', {
        sourceId: `sector-${sector.etf}`,
        severity,
        regions: ['US'],
        timestamp: Date.now(),
        payload: {
          sector: sector.name,
          etf: sector.etf,
          gicsCode: sector.gicsCode,
          price: quote.price,
          change: quote.change,
          changePercent,
          relativeStrength,
          sparkline: quote.sparkline,
          topHoldings: sector.topHoldings,
          keywords: sector.keywords,
        },
        confidence: 0.95,
        tags,
        provenance: 'tool:market.sp500sectors',
      }));
    }

    // Cross-sector analysis: detect defensive rotation
    const defensiveSectors = ['XLU', 'XLP', 'XLV', 'XLRE'];
    const cyclicalSectors = ['XLY', 'XLK', 'XLI', 'XLB'];

    const defensiveAvg = avgChange(quotes, defensiveSectors);
    const cyclicalAvg = avgChange(quotes, cyclicalSectors);
    const rotationSpread = defensiveAvg - cyclicalAvg;

    if (Math.abs(rotationSpread) > 1.0) {
      signals.push(createSignal('economic', {
        sourceId: 'sector-rotation-signal',
        severity: Math.abs(rotationSpread) > 2.0 ? 'high' : 'medium',
        regions: ['US'],
        timestamp: Date.now(),
        payload: {
          type: 'sector_rotation',
          direction: rotationSpread > 0 ? 'defensive' : 'risk-on',
          spread: rotationSpread,
          defensiveAvg,
          cyclicalAvg,
        },
        confidence: 0.8,
        tags: ['sp500', 'rotation', rotationSpread > 0 ? 'defensive' : 'risk-on'],
        provenance: 'tool:market.sp500sectors',
      }));
    }

    return signals;
  },
});

// ============================================================================
// SECTOR HELPER FUNCTIONS
// ============================================================================

function sectorSignalSeverity(changePercent: number, relativeStrength: number): Severity {
  const absChange = Math.abs(changePercent);
  const absRS = Math.abs(relativeStrength);
  if (absChange > 3 || absRS > 3) return 'high';
  if (absChange > 1.5 || absRS > 1.5) return 'medium';
  if (absChange > 0.5 || absRS > 0.5) return 'low';
  return 'info';
}

function avgChange(quotes: Array<{ symbol: string; price: number; change: number }>, symbols: string[]): number {
  const matching = quotes.filter(q => symbols.includes(q.symbol));
  if (matching.length === 0) return 0;
  return matching.reduce((sum, q) => sum + (q.price > 0 ? (q.change / q.price) * 100 : 0), 0) / matching.length;
}

/**
 * Match a news headline to relevant sectors based on keyword overlap.
 */
export function matchSectors(headline: string): SectorDefinition[] {
  const lower = headline.toLowerCase();
  return SP500_SECTORS.filter(sector =>
    sector.keywords.some(kw => lower.includes(kw)) ||
    sector.topHoldings.some(ticker => {
      const regex = new RegExp(`\\b${ticker}\\b`, 'i');
      return regex.test(headline);
    })
  );
}
