import type { ClusteredEventCore } from './news-clustering-core.js';
import type { NewsEntityContext } from './entity-extraction-core.js';

export type MarketAlertType =
  | 'prediction_leads_news'
  | 'explained_market_move'
  | 'silent_divergence'
  | 'flow_price_divergence';

export interface MarketAlertPrediction {
  title: string;
  yesPrice: number;
  volume?: number;
  url?: string;
}

export interface MarketAlertMarket {
  symbol: string;
  name: string;
  display: string;
  price: number | null;
  change: number | null;
}

export interface MarketAlertSignal<T extends string = MarketAlertType> {
  id: string;
  type: T;
  title: string;
  description: string;
  confidence: number;
  timestamp: Date;
  data: {
    newsVelocity?: number;
    marketChange?: number;
    /** Signed change in YES probability, in points: negative when the market fell. */
    predictionShift?: number;
    relatedTopics?: string[];
    correlatedEntities?: string[];
    correlatedNews?: string[];
    explanation?: string;
  };
}

export interface NewsMatch {
  clusterId: string;
  title: string;
  confidence: number;
}

export interface DetectMarketAlertsInput {
  markets: MarketAlertMarket[];
  predictions: MarketAlertPrediction[];
  /** Previous poll's snapshot; null skips the prediction-shift detector. */
  previousPredictionChanges: Map<string, number> | null;
  newsTopics: Map<string, number>;
  newsEntityContexts: Map<string, NewsEntityContext>;
  pipelineFlowMentions: number;
  isRecentDuplicate: (key: string) => boolean;
  markSignalSeen: (key: string) => void;
}

export declare const MARKET_ALERT_TYPES: readonly MarketAlertType[];

export declare const PREDICTION_SHIFT_THRESHOLD: number;
export declare const MARKET_MOVE_THRESHOLD: number;
export declare const NEWS_VELOCITY_THRESHOLD: number;
export declare const FLOW_PRICE_THRESHOLD: number;
export declare const ENERGY_COMMODITY_SYMBOLS: Set<string>;
export declare const PIPELINE_KEYWORDS: string[];
export declare const FLOW_DROP_KEYWORDS: string[];
export declare const TOPIC_MAPPINGS: Record<string, string[]>;

export declare function findRelatedTopics(prediction: string): string[];
export declare function generateSignalId(): string;
export declare function generateDedupeKey(type: string, identifier: string, value: number): string;

export declare function predictionMarketKey(market: Pick<MarketAlertPrediction, 'title' | 'url'>): string;
export declare function predictionChangesSnapshot(predictions: MarketAlertPrediction[]): Map<string, number>;
export declare function previousPredictionPrice(
  pred: MarketAlertPrediction,
  previous: Map<string, number>,
  currentCounts: Map<string, number>,
): number | undefined;
export declare function extractTopics(events: ClusteredEventCore[]): Map<string, number>;
export declare function countRelatedTopicMentions(
  newsTopics: Map<string, number>,
  market: Pick<MarketAlertMarket, 'name' | 'symbol'>,
): number;
export declare function detectPipelineFlowDrops(
  events: ClusteredEventCore[],
  isRecentDuplicate: (key: string) => boolean,
  markSignalSeen: (key: string) => void,
): MarketAlertSignal<'flow_drop'>[];

export declare function findNewsForEntity(
  entityId: string,
  newsContexts: Map<string, NewsEntityContext>,
): NewsMatch[];
export declare function findNewsForMarketSymbol(
  symbol: string,
  newsContexts: Map<string, NewsEntityContext>,
): NewsMatch[];

export declare function detectMarketAlerts(input: DetectMarketAlertsInput): MarketAlertSignal[];
