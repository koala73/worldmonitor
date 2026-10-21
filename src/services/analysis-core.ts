/**
 * Core analysis functions shared between main thread and worker.
 * All functions here are PURE (no side effects, no external state).
 *
 * The clustering algorithm (clusterNewsCore, aggregateThreats,
 * MAX_CLUSTER_NEWS_ITEMS) and its input/output types now live in
 * shared/news-clustering-core.js (issue #5697) so server-side MCP tools
 * cluster identically; they are re-exported here unchanged. This module keeps
 * the correlation signal detection algorithms, which pull in entity
 * extraction and other client-coupled modules. The market-alert detectors and
 * the pipeline flow-drop detector live in shared/market-alert-core.js
 * (issue #8867) so a Railway seeder emits the same alerts.
 *
 * Both the main-thread services and the Web Worker import from here.
 */

import {
  SIMILARITY_THRESHOLD,
  SUPPRESSED_TRENDING_TERMS,
  NEWS_VELOCITY_THRESHOLD,
  tokenize,
  jaccardSimilarity,
  generateSignalId,
  generateDedupeKey,
} from '@/utils/analysis-constants';

import {
  predictionChangesSnapshot,
  extractTopics,
  detectPipelineFlowDrops,
  detectMarketAlerts,
} from '../../shared/market-alert-core.js';
import { extractEntitiesFromClusters } from './entity-extraction';
import { effectivePubDateMs } from './feed-date';

export {
  predictionMarketKey,
  detectPipelineFlowDrops,
} from '../../shared/market-alert-core.js';
export {
  MAX_CLUSTER_NEWS_ITEMS,
  aggregateThreats,
  clusterNewsCore,
} from '../../shared/news-clustering-core.js';
export type {
  NewsItemCore,
  NewsItemWithTier,
  ClusteredEventCore,
} from '../../shared/news-clustering-core.js';
import type { ClusteredEventCore } from '../../shared/news-clustering-core.js';

const TOPIC_BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOPIC_BASELINE_SPIKE_MULTIPLIER = 3;
const TOPIC_HISTORY_MAX_POINTS = 1000;

interface TopicVelocityPoint {
  timestamp: number;
  velocity: number;
}

// Re-export for convenience
export {
  SIMILARITY_THRESHOLD,
  tokenize,
  jaccardSimilarity,
  generateSignalId,
  generateDedupeKey,
};

export interface PredictionMarketCore {
  title: string;
  yesPrice: number;
  volume?: number;
  url?: string;
}

export interface MarketDataCore {
  symbol: string;
  name: string;
  display: string;
  price: number | null;
  change: number | null;
}

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

/**
 * One article a signal was built from. `correlatedNews` looks like this but is
 * NOT — it carries cluster IDs, not links (see `correlatedNews` below), so a
 * signal that wants to be drilled into needs this shape instead. Mirrors
 * `HeadlineWithUrl` in shared/analysis-focal-points.ts, plus the source name
 * and publication time the news pipeline already carries.
 */
export interface SignalArticle {
  title: string;
  source: string;
  link?: string;
  publishedAt?: number;
}

export interface CorrelationSignalCore {
  id: string;
  type: SignalType;
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
    term?: string;
    baseline?: number;
    multiplier?: number;
    sourceCount?: number;
    /**
     * Distinct source names behind `sourceCount`. Emitters must derive both
     * from the same set so the count and the names cannot disagree.
     */
    sourceNames?: string[];
    /** Bounded evidence list — the articles the signal was built from. */
    articles?: SignalArticle[];
  };
}

export type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other' | 'unknown';

export interface StreamSnapshot {
  newsVelocity: Map<string, number>;
  marketChanges: Map<string, number>;
  predictionChanges: Map<string, number>;
  topicVelocityHistory: Map<string, TopicVelocityPoint[]>;
  timestamp: number;
}

// ============================================================================
// CORRELATION FUNCTIONS
// ============================================================================

function pruneVelocityHistory(history: TopicVelocityPoint[], now: number): TopicVelocityPoint[] {
  return history.filter(point => now - point.timestamp <= TOPIC_BASELINE_WINDOW_MS);
}

function averageVelocity(history: TopicVelocityPoint[]): number {
  if (history.length === 0) return 0;
  const total = history.reduce((sum, point) => sum + point.velocity, 0);
  return total / history.length;
}

export function detectConvergence(
  events: ClusteredEventCore[],
  getSourceType: (source: string) => SourceType,
  isRecentDuplicate: (key: string) => boolean,
  markSignalSeen: (key: string) => void
): CorrelationSignalCore[] {
  const signals: CorrelationSignalCore[] = [];
  const WINDOW_MS = 60 * 60 * 1000;
  const now = Date.now();

  for (const event of events) {
    if (!event.allItems || event.allItems.length < 3) continue;

    const recentItems = event.allItems.filter(
      item => now - effectivePubDateMs(item) < WINDOW_MS
    );
    if (recentItems.length < 3) continue;

    const sourceTypes = new Set<SourceType>();
    for (const item of recentItems) {
      const type = getSourceType(item.source);
      sourceTypes.add(type);
    }

    if (sourceTypes.size >= 3) {
      const types = Array.from(sourceTypes).filter(t => t !== 'other' && t !== 'unknown');
      const dedupeKey = generateDedupeKey('convergence', event.id, sourceTypes.size);

      if (!isRecentDuplicate(dedupeKey) && types.length >= 3) {
        markSignalSeen(dedupeKey);
        signals.push({
          id: generateSignalId(),
          type: 'convergence',
          title: 'Source Convergence',
          description: `"${event.primaryTitle.slice(0, 50)}..." reported by ${types.join(', ')} (${recentItems.length} sources in 60m)`,
          confidence: Math.min(0.95, 0.6 + sourceTypes.size * 0.1),
          timestamp: new Date(),
          data: {
            newsVelocity: recentItems.length,
            relatedTopics: types,
          },
        });
      }
    }
  }

  return signals;
}

export function detectTriangulation(
  events: ClusteredEventCore[],
  getSourceType: (source: string) => SourceType,
  isRecentDuplicate: (key: string) => boolean,
  markSignalSeen: (key: string) => void
): CorrelationSignalCore[] {
  const signals: CorrelationSignalCore[] = [];
  const CRITICAL_TYPES: SourceType[] = ['wire', 'gov', 'intel'];

  for (const event of events) {
    if (!event.allItems || event.allItems.length < 3) continue;

    const typePresent = new Set<SourceType>();
    for (const item of event.allItems) {
      const t = getSourceType(item.source);
      if (CRITICAL_TYPES.includes(t)) {
        typePresent.add(t);
      }
    }

    if (typePresent.size === 3) {
      const dedupeKey = generateDedupeKey('triangulation', event.id, 3);

      if (!isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        signals.push({
          id: generateSignalId(),
          type: 'triangulation',
          title: 'Intel Triangulation',
          description: `Wire + Gov + Intel aligned: "${event.primaryTitle.slice(0, 45)}..."`,
          confidence: 0.9,
          timestamp: new Date(),
          data: {
            newsVelocity: event.sourceCount,
            relatedTopics: Array.from(typePresent),
          },
        });
      }
    }
  }

  return signals;
}

/**
 * Analyze correlations between news, predictions, and markets.
 * Pure function - state management (snapshots, deduplication) handled by caller.
 */
export function analyzeCorrelationsCore(
  events: ClusteredEventCore[],
  predictions: PredictionMarketCore[],
  markets: MarketDataCore[],
  previousSnapshot: StreamSnapshot | null,
  getSourceType: (source: string) => SourceType,
  isRecentDuplicate: (key: string) => boolean,
  markSignalSeen: (key: string) => void
): { signals: CorrelationSignalCore[]; snapshot: StreamSnapshot } {
  const signals: CorrelationSignalCore[] = [];
  const now = Date.now();

  const newsTopics = extractTopics(events);
  const pipelineFlowSignals = detectPipelineFlowDrops(events, isRecentDuplicate, markSignalSeen);
  const pipelineFlowMentions = pipelineFlowSignals.length;

  const newsEntityContexts = extractEntitiesFromClusters(events);

  const previousHistory = previousSnapshot?.topicVelocityHistory ?? new Map<string, TopicVelocityPoint[]>();
  const currentHistory = new Map<string, TopicVelocityPoint[]>();
  const topicUniverse = new Set<string>([
    ...previousHistory.keys(),
    ...newsTopics.keys(),
  ]);

  for (const topic of topicUniverse) {
    const prior = pruneVelocityHistory(previousHistory.get(topic) ?? [], now);
    const updated = [...prior, { timestamp: now, velocity: newsTopics.get(topic) ?? 0 }];
    if (updated.length > TOPIC_HISTORY_MAX_POINTS) {
      updated.splice(0, updated.length - TOPIC_HISTORY_MAX_POINTS);
    }
    currentHistory.set(topic, updated);
  }

  const currentSnapshot: StreamSnapshot = {
    newsVelocity: newsTopics,
    marketChanges: new Map(markets.map(m => [m.symbol, m.change ?? 0])),
    predictionChanges: predictionChangesSnapshot(predictions),
    topicVelocityHistory: currentHistory,
    timestamp: now,
  };

  if (!previousSnapshot) {
    return { signals: [], snapshot: currentSnapshot };
  }

  // Detect news velocity spikes
  for (const [topic, velocity] of newsTopics) {
    if (SUPPRESSED_TRENDING_TERMS.has(topic)) continue;
    const baselineHistory = pruneVelocityHistory(previousHistory.get(topic) ?? [], now);
    const baseline = averageVelocity(baselineHistory);
    const exceedsAbsoluteThreshold = velocity > NEWS_VELOCITY_THRESHOLD * 2;
    const exceedsBaseline = baseline > 0
      ? velocity > baseline * TOPIC_BASELINE_SPIKE_MULTIPLIER
      : exceedsAbsoluteThreshold;

    if (!exceedsAbsoluteThreshold || !exceedsBaseline) continue;

    const multiplier = baseline > 0 ? velocity / baseline : 0;
    const dedupeKey = generateDedupeKey('velocity_spike', topic, velocity);
    if (!isRecentDuplicate(dedupeKey)) {
      markSignalSeen(dedupeKey);
      const baselineText = baseline > 0
        ? `${baseline.toFixed(1)} baseline (${multiplier.toFixed(1)}x)`
        : 'cold-start baseline';
      signals.push({
        id: generateSignalId(),
        type: 'velocity_spike',
        title: 'News Velocity Spike',
        description: `"${topic}" coverage surging: ${velocity.toFixed(1)} activity score vs ${baselineText}`,
        confidence: Math.min(0.9, 0.45 + (multiplier > 0 ? multiplier / 8 : velocity / 18)),
        timestamp: new Date(),
        data: {
          newsVelocity: velocity,
          relatedTopics: [topic],
          baseline,
          multiplier: baseline > 0 ? multiplier : undefined,
          explanation: baseline > 0
            ? `Velocity ${velocity.toFixed(1)} is ${multiplier.toFixed(1)}x above baseline ${baseline.toFixed(1)}`
            : `Velocity ${velocity.toFixed(1)} exceeded cold-start threshold`,
        },
      });
    }
  }

  signals.push(...detectMarketAlerts({
    markets,
    predictions,
    previousPredictionChanges: previousSnapshot.predictionChanges,
    newsTopics,
    newsEntityContexts,
    pipelineFlowMentions,
    isRecentDuplicate,
    markSignalSeen,
  }));

  // Add convergence and triangulation signals
  signals.push(...detectConvergence(events, getSourceType, isRecentDuplicate, markSignalSeen));
  signals.push(...detectTriangulation(events, getSourceType, isRecentDuplicate, markSignalSeen));
  signals.push(...pipelineFlowSignals);

  // Dedupe by type to avoid spam
  const uniqueSignals = signals.filter((sig, idx) =>
    signals.findIndex(s => s.type === sig.type) === idx
  );

  // Only return high-confidence signals
  return {
    signals: uniqueSignals.filter(s => s.confidence >= 0.6),
    snapshot: currentSnapshot,
  };
}
