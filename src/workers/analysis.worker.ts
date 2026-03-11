/**
 * Web Worker for heavy computational tasks (clustering & correlation analysis).
 * Runs O(n²) Jaccard clustering and correlation detection off the main thread.
 *
 * All core logic is imported from src/services/analysis-core.ts
 * to maintain a single source of truth.
 */

import {
  clusterNewsCore,
  analyzeCorrelationsCore,
  type NewsItemCore,
  type ClusteredEventCore,
  type PredictionMarketCore,
  type MarketDataCore,
  type CorrelationSignalCore,
  type SourceType,
  type StreamSnapshot,
} from '@/services/analysis-core';

// Message types for worker communication
interface ClusterMessage {
  type: 'cluster';
  id: string;
  items: NewsItemCore[];
  sourceTiers: Record<string, number>;
}

interface CorrelationMessage {
  type: 'correlation';
  id: string;
  clusters: ClusteredEventCore[];
  predictions: PredictionMarketCore[];
  markets: MarketDataCore[];
  sourceTypes: Record<string, SourceType>;
}

interface ResetMessage {
  type: 'reset';
}

type WorkerMessage = ClusterMessage | CorrelationMessage | ResetMessage;

interface ClusterResult {
  type: 'cluster-result';
  id: string;
  clusters: ClusteredEventCore[];
}

interface CorrelationResult {
  type: 'correlation-result';
  id: string;
  signals: CorrelationSignalCore[];
}

// Worker-local state (persists between messages)
let previousSnapshot: StreamSnapshot | null = null;
const recentSignalKeys = new Set<string>();

function isRecentDuplicate(key: string): boolean {
  return recentSignalKeys.has(key);
}

const RECENT_SIGNAL_MAX = 5_000;

function markSignalSeen(key: string): void {
  // Evict oldest entries if the set grows too large (e.g. during a high-velocity signal burst).
  if (recentSignalKeys.size >= RECENT_SIGNAL_MAX) {
    const first = recentSignalKeys.values().next().value;
    if (first !== undefined) recentSignalKeys.delete(first);
  }
  recentSignalKeys.add(key);
  setTimeout(() => recentSignalKeys.delete(key), 30 * 60 * 1000);
}

// Worker message handler
self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'cluster': {
      // Deserialize dates (they come as strings over postMessage)
      const items = message.items.map(item => ({
        ...item,
        pubDate: new Date(item.pubDate),
      }));

      const getSourceTier = (source: string): number => message.sourceTiers[source] ?? 4;
      const clusters = clusterNewsCore(items, getSourceTier);

      const result: ClusterResult = {
        type: 'cluster-result',
        id: message.id,
        clusters,
      };
      self.postMessage(result);
      break;
    }

    case 'correlation': {
      // Deserialize dates in clusters
      const clusters = message.clusters.map(cluster => ({
        ...cluster,
        firstSeen: new Date(cluster.firstSeen),
        lastUpdated: new Date(cluster.lastUpdated),
        allItems: cluster.allItems.map(item => ({
          ...item,
          pubDate: new Date(item.pubDate),
        })),
      }));

      const getSourceType = (source: string): SourceType => message.sourceTypes[source] ?? 'other';

      const { signals, snapshot } = analyzeCorrelationsCore(
        clusters,
        message.predictions,
        message.markets,
        previousSnapshot,
        getSourceType,
        isRecentDuplicate,
        markSignalSeen
      );

      previousSnapshot = snapshot;

      const result: CorrelationResult = {
        type: 'correlation-result',
        id: message.id,
        signals,
      };
      self.postMessage(result);
      break;
    }

    case 'reset': {
      previousSnapshot = null;
      recentSignalKeys.clear();
      break;
    }
  }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });
