/**
 * Core analysis functions shared between main thread and worker.
 * All functions here are PURE (no side effects, no external state).
 *
 * This module is the single source of truth for:
 * - News clustering algorithm
 * - Correlation signal detection algorithms
 *
 * Both the main-thread services and the Web Worker import from here.
 */

import {
  SIMILARITY_THRESHOLD,
  PREDICTION_SHIFT_THRESHOLD,
  MARKET_MOVE_THRESHOLD,
  NEWS_VELOCITY_THRESHOLD,
  FLOW_PRICE_THRESHOLD,
  ENERGY_COMMODITY_SYMBOLS,
  PIPELINE_KEYWORDS,
  FLOW_DROP_KEYWORDS,
  TOPIC_KEYWORDS,
  SUPPRESSED_TRENDING_TERMS,
  tokenize,
  jaccardSimilarity,
  includesKeyword,
  containsTopicKeyword,
  findRelatedTopics,
  generateSignalId,
  generateDedupeKey,
} from '@/utils/analysis-constants';

import {
  extractEntitiesFromClusters,
  findNewsForMarketSymbol,
} from './entity-extraction';
import { getEntityIndex } from './entity-index';
import { aggregateThreats } from './threat-classifier';

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

// ============================================================================
// TYPES
// ============================================================================

export interface NewsItemCore {
  source: string;
  title: string;
  link: string;
  pubDate: Date;
  isAlert: boolean;
  monitorColor?: string;
  tier?: number;
  threat?: import('./threat-classifier').ThreatClassification;
  lat?: number;
  lon?: number;
  locationName?: string;
  lang?: string;
}

export type NewsItemWithTier = NewsItemCore & { tier: number };

export interface ClusteredEventCore {
  id: string;
  primaryTitle: string;
  primarySource: string;
  primaryLink: string;
  sourceCount: number;
  topSources: Array<{ name: string; tier: number; url: string }>;
  allItems: NewsItemCore[];
  firstSeen: Date;
  lastUpdated: Date;
  isAlert: boolean;
  monitorColor?: string;
  velocity?: { sourcesPerHour?: number };
  threat?: import('./threat-classifier').ThreatClassification;
  lat?: number;
  lon?: number;
  lang?: string;
}

export interface PredictionMarketCore {
  title: string;
  yesPrice: number;
  volume?: number;
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
    predictionShift?: number;
    relatedTopics?: string[];
    correlatedEntities?: string[];
    correlatedNews?: string[];
    explanation?: string;
    term?: string;
    baseline?: number;
    multiplier?: number;
    sourceCount?: number;
  };
}

export type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other';

export interface StreamSnapshot {
  newsVelocity: Map<string, number>;
  marketChanges: Map<string, number>;
  predictionChanges: Map<string, number>;
  topicVelocityHistory: Map<string, TopicVelocityPoint[]>;
  timestamp: number;
}

// ============================================================================
// CLUSTERING FUNCTIONS
// ============================================================================

function generateClusterId(items: NewsItemWithTier[]): string {
  const sorted = [...items].sort((a, b) => a.pubDate.getTime() - b.pubDate.getTime());
  const first = sorted[0]!;
  return `${first.pubDate.getTime()}-${first.title.slice(0, 20).replace(/\W/g, '')}`;
}

/**
 * Cluster news items by title similarity using Jaccard index.
 * Pure function - no side effects.
 */
export function clusterNewsCore(
  items: NewsItemCore[],
  getSourceTier: (source: string) => number
): ClusteredEventCore[] {
  if (items.length === 0) return [];

  const itemsWithTier: NewsItemWithTier[] = items.map(item => ({
    ...item,
    tier: item.tier ?? getSourceTier(item.source),
  }));

  const tokenCache = new Map<string, Set<string>>();
  const tokenList: Set<string>[] = [];
  const invertedIndex = new Map<string, number[]>();
  for (const item of itemsWithTier) {
    const tokens = tokenize(item.title);
    tokenCache.set(item.title, tokens);
    tokenList.push(tokens);
  }

  for (let index = 0; index < tokenList.length; index++) {
    const tokens = tokenList[index]!;
    for (const token of tokens) {
      const bucket = invertedIndex.get(token);
      if (bucket) {
        bucket.push(index);
      } else {
        invertedIndex.set(token, [index]);
      }
    }
  }

  const clusters: NewsItemWithTier[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < itemsWithTier.length; i++) {
    if (assigned.has(i)) continue;

    const currentItem = itemsWithTier[i]!;
    const cluster: NewsItemWithTier[] = [currentItem];
    assigned.add(i);
    const tokensI = tokenList[i]!;

    const candidateIndices = new Set<number>();
    for (const token of tokensI) {
      const bucket = invertedIndex.get(token);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (idx > i) {
          candidateIndices.add(idx);
        }
      }
    }

    const sortedCandidates = Array.from(candidateIndices).sort((a, b) => a - b);
    for (const j of sortedCandidates) {
      if (assigned.has(j)) {
        continue;
      }

      const otherItem = itemsWithTier[j]!;
      const tokensJ = tokenList[j]!;
      const similarity = jaccardSimilarity(tokensI, tokensJ);

      if (similarity >= SIMILARITY_THRESHOLD) {
        cluster.push(otherItem);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters.map(cluster => {
    const sorted = [...cluster].sort((a, b) => {
      const tierDiff = a.tier - b.tier;
      if (tierDiff !== 0) return tierDiff;
      return b.pubDate.getTime() - a.pubDate.getTime();
    });

    const primary = sorted[0]!;
    const dates = cluster.map(i => i.pubDate.getTime());

    const topSources = sorted
      .slice(0, 3)
      .map(item => ({
        name: item.source,
        tier: item.tier,
        url: item.link,
      }));

    const threat = aggregateThreats(cluster);

    // Pick most common geo location across items
    const locItems = cluster.filter((i): i is NewsItemWithTier & { lat: number; lon: number } => i.lat != null && i.lon != null);
    let clusterLat: number | undefined;
    let clusterLon: number | undefined;
    if (locItems.length > 0) {
      const locCounts = new Map<string, { lat: number; lon: number; count: number }>();
      for (const li of locItems) {
        const key = `${li.lat},${li.lon}`;
        const entry = locCounts.get(key) || { lat: li.lat, lon: li.lon, count: 0 };
        entry.count++;
        locCounts.set(key, entry);
      }
      const best = Array.from(locCounts.values()).sort((a, b) => b.count - a.count)[0]!;
      clusterLat = best.lat;
      clusterLon = best.lon;
    }

    return {
      id: generateClusterId(cluster),
      primaryTitle: primary.title,
      primarySource: primary.source,
      primaryLink: primary.link,
      sourceCount: cluster.length,
      topSources,
      allItems: cluster,
      firstSeen: new Date(Math.min(...dates)),
      lastUpdated: new Date(Math.max(...dates)),
      isAlert: cluster.some(i => i.isAlert),
      monitorColor: cluster.find(i => i.monitorColor)?.monitorColor,
      threat,
      ...(clusterLat != null && { lat: clusterLat, lon: clusterLon }),
      lang: primary.lang,
    };
  }).sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
}

// ============================================================================
// CORRELATION FUNCTIONS
// ============================================================================

function extractTopics(events: ClusteredEventCore[]): Map<string, number> {
  const topics = new Map<string, number>();

  for (const event of events) {
    const title = event.primaryTitle.toLowerCase();
    for (const kw of TOPIC_KEYWORDS) {
      if (SUPPRESSED_TRENDING_TERMS.has(kw)) continue;
      if (!containsTopicKeyword(title, kw)) continue;
      const velocity = event.velocity?.sourcesPerHour ?? 0;
      topics.set(kw, (topics.get(kw) ?? 0) + velocity + event.sourceCount);
    }
  }

  return topics;
}

function pruneVelocityHistory(history: TopicVelocityPoint[], now: number): TopicVelocityPoint[] {
  return history.filter(point => now - point.timestamp <= TOPIC_BASELINE_WINDOW_MS);
}

function averageVelocity(history: TopicVelocityPoint[]): number {
  if (history.length === 0) return 0;
  const total = history.reduce((sum, point) => sum + point.velocity, 0);
  return total / history.length;
}

export function detectPipelineFlowDrops(
  events: ClusteredEventCore[],
  isRecentDuplicate: (key: string) => boolean,
  markSignalSeen: (key: string) => void
): CorrelationSignalCore[] {
  const signals: CorrelationSignalCore[] = [];

  for (const event of events) {
    const titles = [
      event.primaryTitle,
      ...(event.allItems?.map(item => item.title) ?? []),
    ]
      .map(title => title.toLowerCase())
      .filter(Boolean);

    const hasPipeline = titles.some(title => includesKeyword(title, PIPELINE_KEYWORDS));
    const hasFlowDrop = titles.some(title => includesKeyword(title, FLOW_DROP_KEYWORDS));

    if (hasPipeline && hasFlowDrop) {
      const dedupeKey = generateDedupeKey('flow_drop', event.id, event.sourceCount);
      if (!isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        signals.push({
          id: generateSignalId(),
          type: 'flow_drop',
          title: 'Pipeline Flow Drop',
          description: `"${event.primaryTitle.slice(0, 70)}..." indicates reduced flow or disruption`,
          confidence: Math.min(0.9, 0.4 + event.sourceCount / 10),
          timestamp: new Date(),
          data: {
            newsVelocity: event.sourceCount,
            relatedTopics: ['pipeline', 'flow'],
          },
        });
      }
    }
  }

  return signals;
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
      item => now - item.pubDate.getTime() < WINDOW_MS
    );
    if (recentItems.length < 3) continue;

    const sourceTypes = new Set<SourceType>();
    for (const item of recentItems) {
      const type = getSourceType(item.source);
      sourceTypes.add(type);
    }

    if (sourceTypes.size >= 3) {
      const types = Array.from(sourceTypes).filter(t => t !== 'other');
      const dedupeKey = generateDedupeKey('convergence', event.id, sourceTypes.size);

      if (!isRecentDuplicate(dedupeKey) && types.length >= 3) {
        markSignalSeen(dedupeKey);
        signals.push({
          id: generateSignalId(),
          type: 'convergence',
          title: 'Source Convergence',
          description: `"${event.primaryTitle.slice(0, 50)}..." reported by ${types.join(', ')} (${recentItems.length} sources in 30m)`,
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

  const entityIndex = getEntityIndex();
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
    predictionChanges: new Map(predictions.map(p => [p.title.slice(0, 50), p.yesPrice])),
    topicVelocityHistory: currentHistory,
    timestamp: now,
  };

  if (!previousSnapshot) {
    return { signals: [], snapshot: currentSnapshot };
  }

  // Detect prediction shifts
  for (const pred of predictions) {
    const key = pred.title.slice(0, 50);
    const prev = previousSnapshot.predictionChanges.get(key);
    if (prev !== undefined) {
      const shift = Math.abs(pred.yesPrice - prev);
      if (shift >= PREDICTION_SHIFT_THRESHOLD) {
        const related = findRelatedTopics(pred.title);
        const newsActivity = related.reduce((sum, t) => sum + (newsTopics.get(t) ?? 0), 0);

        const dedupeKey = generateDedupeKey('prediction_leads_news', key, shift);
        if (newsActivity < NEWS_VELOCITY_THRESHOLD && !isRecentDuplicate(dedupeKey)) {
          markSignalSeen(dedupeKey);
          signals.push({
            id: generateSignalId(),
            type: 'prediction_leads_news',
            title: 'Prediction Market Shift',
            description: `"${pred.title.slice(0, 60)}..." moved ${shift > 0 ? '+' : ''}${shift.toFixed(1)}% with low news coverage`,
            confidence: Math.min(0.9, 0.5 + shift / 20),
            timestamp: new Date(),
            data: {
              predictionShift: shift,
              newsVelocity: newsActivity,
              relatedTopics: related,
            },
          });
        }
      }
    }
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

  // Detect market moves with entity-aware news correlation
  for (const market of markets) {
    const change = Math.abs(market.change ?? 0);
    if (change < MARKET_MOVE_THRESHOLD) continue;

    const entity = entityIndex.byId.get(market.symbol);
    const relatedNews = findNewsForMarketSymbol(market.symbol, newsEntityContexts);

    if (relatedNews.length > 0) {
      const topNews = relatedNews[0]!;
      const dedupeKey = generateDedupeKey('explained_market_move', market.symbol, change);
      if (!isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        const direction = market.change! > 0 ? '+' : '';
        signals.push({
          id: generateSignalId(),
          type: 'explained_market_move',
          title: 'Market Move Explained',
          description: `${market.name} ${direction}${market.change!.toFixed(2)}% correlates with: "${topNews.title.slice(0, 60)}..."`,
          confidence: Math.min(0.9, 0.5 + (relatedNews.length * 0.1) + (change / 20)),
          timestamp: new Date(),
          data: {
            marketChange: market.change!,
            newsVelocity: relatedNews.length,
            correlatedEntities: [market.symbol],
            correlatedNews: relatedNews.map(n => n.clusterId),
            explanation: `${relatedNews.length} related news item${relatedNews.length > 1 ? 's' : ''} found`,
          },
        });
      }
    } else {
      const oldRelatedNews = Array.from(newsTopics.entries())
        .filter(([k]) => market.name.toLowerCase().includes(k) || k.includes(market.symbol.toLowerCase()))
        .reduce((sum, [, v]) => sum + v, 0);

      const dedupeKey = generateDedupeKey('silent_divergence', market.symbol, change);
      if (oldRelatedNews < 2 && !isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        const searchedTerms = entity
          ? [market.symbol, market.name, ...(entity.keywords?.slice(0, 2) ?? [])].join(', ')
          : market.symbol;
        signals.push({
          id: generateSignalId(),
          type: 'silent_divergence',
          title: 'Silent Divergence',
          description: `${market.name} moved ${market.change! > 0 ? '+' : ''}${market.change!.toFixed(2)}% - no news found for: ${searchedTerms}`,
          confidence: Math.min(0.8, 0.4 + change / 10),
          timestamp: new Date(),
          data: {
            marketChange: market.change!,
            newsVelocity: oldRelatedNews,
            explanation: `Searched: ${searchedTerms}`,
          },
        });
      }
    }
  }

  // Detect flow/price divergence for energy commodities
  for (const market of markets) {
    if (!ENERGY_COMMODITY_SYMBOLS.has(market.symbol)) continue;

    const change = market.change ?? 0;
    if (change >= FLOW_PRICE_THRESHOLD) {
      const relatedNews = Array.from(newsTopics.entries())
        .filter(([k]) => market.name.toLowerCase().includes(k) || k.includes(market.symbol.toLowerCase()))
        .reduce((sum, [, v]) => sum + v, 0);

      const dedupeKey = generateDedupeKey('flow_price_divergence', market.symbol, change);
      if (relatedNews < 2 && pipelineFlowMentions === 0 && !isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        signals.push({
          id: generateSignalId(),
          type: 'flow_price_divergence',
          title: 'Flow/Price Divergence',
          description: `${market.name} up ${change.toFixed(2)}% without pipeline flow news`,
          confidence: Math.min(0.85, 0.4 + change / 8),
          timestamp: new Date(),
          data: {
            marketChange: change,
            newsVelocity: relatedNews,
            relatedTopics: ['pipeline', market.display],
          },
        });
      }
    }
  }

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
