/**
 * Correlation analysis service - main thread wrapper.
 * Core logic is in analysis-core.ts (shared with worker).
 */

import type { ClusteredEvent, MarketData } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
import { getSourceType } from '@/config/feeds';
import {
  analyzeCorrelationsCore,
  type CorrelationSignalCore,
  type StreamSnapshot,
  type SourceType,
} from './analysis-core';

// Re-export types
export type SignalType = CorrelationSignalCore['type'];
export type CorrelationSignal = CorrelationSignalCore;

// Main-thread state management
let previousSnapshot: StreamSnapshot | null = null;
const signalHistory: CorrelationSignal[] = [];
const recentSignalKeys = new Map<string, number>();

const DEFAULT_DEDUPE_TTL = 30 * 60 * 1000;
const DEDUPE_TTLS: Record<string, number> = {
  silent_divergence: 6 * 60 * 60 * 1000,
  flow_price_divergence: 6 * 60 * 60 * 1000,
  explained_market_move: 6 * 60 * 60 * 1000,
  prediction_leads_news: 2 * 60 * 60 * 1000,
  keyword_spike: 30 * 60 * 1000,
};

function getDedupeType(key: string): string {
  return key.split(':')[0] || 'default';
}

function isRecentDuplicate(key: string): boolean {
  const seen = recentSignalKeys.get(key);
  if (!seen) return false;
  const type = getDedupeType(key);
  const ttl = DEDUPE_TTLS[type] ?? DEFAULT_DEDUPE_TTL;
  return Date.now() - seen < ttl;
}

function markSignalSeen(key: string): void {
  recentSignalKeys.set(key, Date.now());
  if (recentSignalKeys.size > 500) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, t] of recentSignalKeys) {
      if (t < cutoff) recentSignalKeys.delete(k);
    }
  }
}

export function analyzeCorrelations(
  events: ClusteredEvent[],
  predictions: PredictionMarket[],
  markets: MarketData[]
): CorrelationSignal[] {
  const getSourceTypeFn = (source: string): SourceType => getSourceType(source) as SourceType;

  const { signals, snapshot } = analyzeCorrelationsCore(
    events,
    predictions,
    markets,
    previousSnapshot,
    getSourceTypeFn,
    isRecentDuplicate,
    markSignalSeen
  );

  previousSnapshot = snapshot;
  return signals;
}

export function getRecentSignals(): CorrelationSignal[] {
  const cutoff = Date.now() - 30 * 60 * 1000;
  return signalHistory.filter(s => s.timestamp.getTime() > cutoff);
}

export function addToSignalHistory(signals: CorrelationSignal[]): void {
  signalHistory.push(...signals);
  while (signalHistory.length > 100) {
    signalHistory.shift();
  }
}
