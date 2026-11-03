/**
 * Shared constants for clustering and correlation analysis.
 * Used by both main-thread services and the analysis worker.
 *
 * The pure text primitives (tokenize, jaccardSimilarity, STOP_WORDS,
 * TOPIC_KEYWORDS, SUPPRESSED_TRENDING_TERMS, …) now live in
 * shared/text-analysis-core.js (issue #5697) so server-side MCP tools share
 * them; they are re-exported here unchanged, as are the correlation thresholds
 * and signal id/dedupe helpers from shared/market-alert-core.js (issue #8867).
 * This module additionally carries the client-only signal context/i18n, which
 * is why server code must import the shared modules, never this one.
 */

export {
  SIMILARITY_THRESHOLD,
  STOP_WORDS,
  TOPIC_KEYWORDS,
  SUPPRESSED_TRENDING_TERMS,
  tokenize,
  jaccardSimilarity,
  includesKeyword,
  escapeRegex,
  containsTopicKeyword,
} from '../../shared/text-analysis-core.js';
export {
  PREDICTION_SHIFT_THRESHOLD,
  MARKET_MOVE_THRESHOLD,
  NEWS_VELOCITY_THRESHOLD,
  FLOW_PRICE_THRESHOLD,
  ENERGY_COMMODITY_SYMBOLS,
  PIPELINE_KEYWORDS,
  FLOW_DROP_KEYWORDS,
  TOPIC_MAPPINGS,
  findRelatedTopics,
  generateSignalId,
  generateDedupeKey,
} from '../../shared/market-alert-core.js';

// Signal context: "Why it matters" explanations (Quick Win #3)
// Each signal type has a brief explanation of its analytical significance
export type SignalType =
  | 'prediction_leads_news'
  | 'news_leads_markets'
  | 'silent_divergence'
  | 'velocity_spike'
  | 'keyword_spike'
  | 'convergence'
  | 'triangulation'
  | 'flow_drop'
  | 'flow_price_divergence'
  | 'geo_convergence'
  | 'explained_market_move'
  | 'hotspot_escalation'
  | 'sector_cascade'
  | 'military_surge';

export interface SignalContext {
  whyItMatters: string;
  actionableInsight: string;
  confidenceNote: string;
}

export const SIGNAL_CONTEXT: Record<SignalType, SignalContext> = {
  prediction_leads_news: {
    whyItMatters: 'A prediction market moved while news coverage of the topic stayed low—the market may be reacting to information that has not been reported yet.',
    actionableInsight: 'Monitor for breaking news that could explain the market move.',
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
  keyword_spike: {
    whyItMatters: 'A term is appearing at significantly higher frequency than its baseline across multiple sources, indicating a developing story.',
    actionableInsight: 'Review related headlines and AI summary, then correlate with country instability and market moves.',
    confidenceNote: 'Confidence increases with stronger baseline multiplier and broader source diversity.',
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
  hotspot_escalation: {
    whyItMatters: 'Geopolitical hotspot showing significant escalation based on news activity, country instability, geographic convergence, and military presence.',
    actionableInsight: 'Increase monitoring priority; assess downstream impacts on infrastructure, markets, and regional stability.',
    confidenceNote: 'Confidence weighted by multiple data sources—news (35%), country instability (25%), geo-convergence (25%), military activity (15%).',
  },
  sector_cascade: {
    whyItMatters: 'Market movement is cascading across related sectors—indicates systemic reaction to a catalyzing event.',
    actionableInsight: 'Identify the primary catalyst; assess exposure across correlated assets.',
    confidenceNote: 'Higher confidence when multiple sectors move with similar velocity and direction.',
  },
  military_surge: {
    whyItMatters: 'Military transport activity significantly above baseline—indicates potential deployment, humanitarian operation, or force projection.',
    actionableInsight: 'Correlate with regional news; assess nearby base activity and naval movements.',
    confidenceNote: 'Higher confidence with sustained activity over multiple hours and diverse aircraft types.',
  },
};

import { t } from '@/services/i18n';

export function getSignalContext(type: SignalType): SignalContext {
  const key = SIGNAL_CONTEXT[type] ? type : 'fallback';
  return {
    whyItMatters: t(`signals.context.${key}.whyItMatters`),
    actionableInsight: t(`signals.context.${key}.actionableInsight`),
    confidenceNote: t(`signals.context.${key}.confidenceNote`),
  };
}
