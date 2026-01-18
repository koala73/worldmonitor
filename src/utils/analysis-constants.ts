/**
 * Shared constants for clustering and correlation analysis.
 * Used by both main-thread services and the analysis worker.
 *
 * IMPORTANT: If you change these values, update the worker too!
 * The worker (src/workers/analysis.worker.ts) has a copy of these
 * values for isolation. Keep them in sync.
 */

// Clustering constants
export const SIMILARITY_THRESHOLD = 0.5;

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than',
  'too', 'very', 'just', 'also', 'now', 'new', 'says', 'said', 'after',
]);

// Correlation constants
export const PREDICTION_SHIFT_THRESHOLD = 5;
export const MARKET_MOVE_THRESHOLD = 2;
export const NEWS_VELOCITY_THRESHOLD = 3;
export const FLOW_PRICE_THRESHOLD = 1.5;
export const ENERGY_COMMODITY_SYMBOLS = new Set(['CL=F', 'NG=F']);

export const PIPELINE_KEYWORDS = ['pipeline', 'pipelines', 'line', 'terminal'];
export const FLOW_DROP_KEYWORDS = [
  'flow', 'throughput', 'capacity', 'outage', 'leak', 'rupture', 'shutdown',
  'maintenance', 'curtailment', 'force majeure', 'halt', 'halted', 'reduced',
  'reduction', 'drop', 'offline', 'suspend', 'suspended', 'stoppage',
];

export const TOPIC_KEYWORDS = [
  'iran', 'israel', 'ukraine', 'russia', 'china', 'taiwan', 'oil', 'crypto',
  'fed', 'interest', 'inflation', 'recession', 'war', 'sanctions', 'tariff',
  'ai', 'tech', 'layoff', 'trump', 'biden', 'election',
];

export const TOPIC_MAPPINGS: Record<string, string[]> = {
  'iran': ['iran', 'israel', 'oil', 'sanctions'],
  'israel': ['israel', 'iran', 'war', 'gaza'],
  'ukraine': ['ukraine', 'russia', 'war', 'nato'],
  'russia': ['russia', 'ukraine', 'sanctions'],
  'china': ['china', 'taiwan', 'tariff', 'trade'],
  'taiwan': ['taiwan', 'china'],
  'trump': ['trump', 'election', 'tariff'],
  'fed': ['fed', 'interest', 'inflation', 'recession'],
  'bitcoin': ['crypto', 'bitcoin'],
  'recession': ['recession', 'fed', 'inflation'],
};

// Pure utility functions that can be shared
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

export function includesKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.includes(keyword));
}

export function findRelatedTopics(prediction: string): string[] {
  const title = prediction.toLowerCase();
  const related: string[] = [];

  for (const [key, topics] of Object.entries(TOPIC_MAPPINGS)) {
    if (title.includes(key)) {
      related.push(...topics);
    }
  }

  return [...new Set(related)];
}

export function generateSignalId(): string {
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateDedupeKey(type: string, identifier: string, value: number): string {
  // Market signals dedupe by symbol only (not by change value)
  // This prevents duplicates when price fluctuates slightly
  const marketSignals = ['silent_divergence', 'flow_price_divergence', 'explained_market_move'];
  if (marketSignals.includes(type)) {
    return `${type}:${identifier}`;
  }
  const roundedValue = Math.round(value * 10) / 10;
  return `${type}:${identifier}:${roundedValue}`;
}

// Signal context: "Why it matters" explanations (Quick Win #3)
// Each signal type has a brief explanation of its analytical significance
export type SignalType =
  | 'prediction_leads_news'
  | 'news_leads_markets'
  | 'silent_divergence'
  | 'velocity_spike'
  | 'convergence'
  | 'triangulation'
  | 'flow_drop'
  | 'flow_price_divergence'
  | 'geo_convergence'
  | 'explained_market_move';

export interface SignalContext {
  whyItMatters: string;
  actionableInsight: string;
  confidenceNote: string;
}

export const SIGNAL_CONTEXT: Record<SignalType, SignalContext> = {
  prediction_leads_news: {
    whyItMatters: 'Prediction markets often price in information before it becomes news—traders may have early access to developments.',
    actionableInsight: 'Monitor for breaking news in the next 1-6 hours that could explain the market move.',
    confidenceNote: 'Higher confidence if multiple prediction markets move in same direction.',
  },
  news_leads_markets: {
    whyItMatters: 'News is breaking faster than markets are reacting—potential mispricing opportunity.',
    actionableInsight: 'Watch for market catch-up as algorithms and traders digest the news.',
    confidenceNote: 'Stronger signal if news is from Tier 1 wire services.',
  },
  silent_divergence: {
    whyItMatters: 'Market moving significantly without any identifiable news catalyst—possible insider knowledge, algorithmic trading, or unreported development.',
    actionableInsight: 'Investigate alternative data sources; news may emerge later explaining the move.',
    confidenceNote: 'Lower confidence as cause is unknown—treat as early warning, not confirmed intelligence.',
  },
  velocity_spike: {
    whyItMatters: 'A story is accelerating across multiple news sources—indicates growing significance and potential for market/policy impact.',
    actionableInsight: 'This topic warrants immediate attention; expect official statements or market reactions.',
    confidenceNote: 'Higher confidence with more sources; check if Tier 1 sources are among them.',
  },
  convergence: {
    whyItMatters: 'Multiple independent source types confirming same event—cross-validation increases likelihood of accuracy.',
    actionableInsight: 'Treat this as high-confidence intelligence; triangulation reduces false positive risk.',
    confidenceNote: 'Very high confidence when wire + government + intel sources align.',
  },
  triangulation: {
    whyItMatters: 'The "authority triangle" (wire services, government sources, intel specialists) are aligned—this is the gold standard for breaking news confirmation.',
    actionableInsight: 'This is actionable intelligence; expect market/policy reactions imminently.',
    confidenceNote: 'Highest confidence signal in the system—multiple authoritative sources agree.',
  },
  flow_drop: {
    whyItMatters: 'Physical commodity flow disruption detected—supply constraints often precede price spikes.',
    actionableInsight: 'Monitor energy commodity prices; assess supply chain exposure.',
    confidenceNote: 'Confidence depends on disruption duration and alternative supply availability.',
  },
  flow_price_divergence: {
    whyItMatters: 'Supply disruption news is not yet reflected in commodity prices—potential information edge.',
    actionableInsight: 'Either markets are slow to react, or the disruption is less significant than reported.',
    confidenceNote: 'Medium confidence—markets may have better information than news reports.',
  },
  geo_convergence: {
    whyItMatters: 'Multiple news events clustering around same geographic location—potential escalation or coordinated activity.',
    actionableInsight: 'Increase monitoring priority for this region; correlate with satellite/AIS data if available.',
    confidenceNote: 'Higher confidence if events span multiple source types and time periods.',
  },
  explained_market_move: {
    whyItMatters: 'Market move has clear news catalyst—no mystery, price action reflects known information.',
    actionableInsight: 'Understand the narrative driving the move; assess if reaction is proportional.',
    confidenceNote: 'High confidence—news and price action are correlated.',
  },
};

export function getSignalContext(type: SignalType): SignalContext {
  return SIGNAL_CONTEXT[type] ?? {
    whyItMatters: 'Signal detected.',
    actionableInsight: 'Monitor for developments.',
    confidenceNote: 'Standard confidence.',
  };
}
