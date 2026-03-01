/**
 * Book-Worthiness Scoring Engine
 *
 * Scores clustered events 0-100 for suitability as instant-book topics.
 * Consumes threat classification, CII scores, signal convergence,
 * velocity/spike data, and trending keywords.
 *
 * Also recommends book "flavors" based on event characteristics.
 */

import type { ClusteredEvent, ThreatLevel, EventCategory } from '@/types';
import type { CountryScore } from './country-instability';
import type { CountrySignalCluster } from './signal-aggregator';
import type { TrendingSpike } from './trending-keywords';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BookFlavor =
  | 'lite-briefing'
  | 'deep-history'
  | 'deep-technical'
  | 'executive-summary';

export interface BookFlavorMeta {
  id: BookFlavor;
  label: string;
  description: string;
  pageRange: string;
}

export const BOOK_FLAVORS: BookFlavorMeta[] = [
  {
    id: 'lite-briefing',
    label: 'Lite Briefing',
    description: 'Quick 5-10 page overview of what happened and what to watch.',
    pageRange: '5-10',
  },
  {
    id: 'deep-history',
    label: 'Deep History / Background',
    description: 'Comprehensive historical context going back decades, 50+ pages.',
    pageRange: '50+',
  },
  {
    id: 'deep-technical',
    label: 'Deep Technical Background',
    description: 'Technical analysis: capabilities, infrastructure, threat modeling.',
    pageRange: '30-50',
  },
  {
    id: 'executive-summary',
    label: 'Executive Summary',
    description: 'Decision-maker brief with BLUF, risk assessment, and recommendations.',
    pageRange: '15-20',
  },
];

export interface BookWorthinessScore {
  /** 0-100 composite score */
  score: number;
  /** Component breakdown (each 0-100) */
  components: {
    threat: number;
    sourceVelocity: number;
    signalConvergence: number;
    ciiSpike: number;
    trendingSpike: number;
    categoryFit: number;
    recency: number;
  };
  /** Recommended flavors, most relevant first */
  recommendedFlavors: BookFlavor[];
  /** Short rationale string */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Weights (must sum to 1.0)
// ---------------------------------------------------------------------------

const W_THREAT = 0.25;
const W_SOURCE_VELOCITY = 0.15;
const W_SIGNAL_CONVERGENCE = 0.20;
const W_CII_SPIKE = 0.15;
const W_TRENDING = 0.10;
const W_CATEGORY = 0.10;
const W_RECENCY = 0.05;

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

const THREAT_SCORES: Record<ThreatLevel, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
  info: 10,
};

const HIGH_VALUE_CATEGORIES = new Set<EventCategory>([
  'conflict', 'disaster', 'diplomatic', 'military', 'terrorism', 'cyber',
]);

const DEEP_HISTORY_CATEGORIES = new Set<EventCategory>([
  'diplomatic', 'conflict',
]);

const DEEP_TECH_CATEGORIES = new Set<EventCategory>([
  'cyber', 'infrastructure', 'tech', 'military',
]);

function scoreThreat(event: ClusteredEvent): number {
  if (!event.threat) return 30; // unknown defaults to moderate
  return THREAT_SCORES[event.threat.level] ?? 30;
}

function scoreSourceVelocity(event: ClusteredEvent): number {
  const count = event.sourceCount;
  if (count >= 20) return 100;
  if (count >= 10) return 80;
  if (count >= 5) return 60;
  if (count >= 3) return 40;
  return 20;
}

function scoreSignalConvergence(
  event: ClusteredEvent,
  signalClusters: CountrySignalCluster[],
): number {
  // Try to find a signal cluster in the same country/region as the event
  if (!event.lat || !event.lon || signalClusters.length === 0) return 20;

  // Pick the cluster with the highest convergence score
  let best = 0;
  for (const sc of signalClusters) {
    if (sc.convergenceScore > best) best = sc.convergenceScore;
  }
  // convergenceScore is typically 0-10; normalise to 0-100
  return Math.min(100, best * 10);
}

function scoreCiiSpike(
  event: ClusteredEvent,
  countryScores: CountryScore[],
): number {
  // Match event to a country via its allItems lat/lon or title keywords
  if (countryScores.length === 0) return 20;

  // Use the highest-scoring country near the event
  let best = 0;
  for (const cs of countryScores) {
    if (cs.score > best) best = cs.score;
  }
  return Math.min(100, best);
}

function scoreTrending(
  event: ClusteredEvent,
  spikes: TrendingSpike[],
): number {
  if (spikes.length === 0) return 10;

  // Check if any spike term appears in the event title
  const titleLower = event.primaryTitle.toLowerCase();
  for (const spike of spikes) {
    if (titleLower.includes(spike.term.toLowerCase())) {
      return Math.min(100, spike.multiplier * 20);
    }
  }
  return 10;
}

function scoreCategoryFit(event: ClusteredEvent): number {
  const cat = event.threat?.category;
  if (!cat) return 40;
  return HIGH_VALUE_CATEGORIES.has(cat) ? 90 : 40;
}

function scoreRecency(event: ClusteredEvent): number {
  const ageMs = Date.now() - event.lastUpdated.getTime();
  const ageHours = ageMs / (60 * 60 * 1000);
  if (ageHours < 1) return 100;
  if (ageHours < 6) return 80;
  if (ageHours < 24) return 60;
  if (ageHours < 72) return 40;
  return 20;
}

// ---------------------------------------------------------------------------
// Flavor recommendation
// ---------------------------------------------------------------------------

function recommendFlavors(event: ClusteredEvent, score: number): BookFlavor[] {
  const flavors: BookFlavor[] = [];
  const cat = event.threat?.category;

  // Lite briefing always recommended for worthy events
  if (score >= 60) flavors.push('lite-briefing');

  // Deep history for diplomatic/conflict long-running events
  if (cat && DEEP_HISTORY_CATEGORIES.has(cat) && event.sourceCount >= 5) {
    flavors.push('deep-history');
  }

  // Deep technical for cyber/infra/tech/military
  if (cat && DEEP_TECH_CATEGORIES.has(cat)) {
    flavors.push('deep-technical');
  }

  // Executive summary for high-convergence, multi-signal events
  if (score >= 70 && event.sourceCount >= 5) {
    flavors.push('executive-summary');
  }

  // Fallback: at least lite
  if (flavors.length === 0) flavors.push('lite-briefing');
  return flavors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BookWorthinessContext {
  signalClusters?: CountrySignalCluster[];
  countryScores?: CountryScore[];
  trendingSpikes?: TrendingSpike[];
}

/**
 * Score a single clustered event for book-worthiness.
 */
export function scoreBookWorthiness(
  event: ClusteredEvent,
  ctx: BookWorthinessContext = {},
): BookWorthinessScore {
  const components = {
    threat: scoreThreat(event),
    sourceVelocity: scoreSourceVelocity(event),
    signalConvergence: scoreSignalConvergence(event, ctx.signalClusters ?? []),
    ciiSpike: scoreCiiSpike(event, ctx.countryScores ?? []),
    trendingSpike: scoreTrending(event, ctx.trendingSpikes ?? []),
    categoryFit: scoreCategoryFit(event),
    recency: scoreRecency(event),
  };

  const score = Math.round(
    components.threat * W_THREAT
    + components.sourceVelocity * W_SOURCE_VELOCITY
    + components.signalConvergence * W_SIGNAL_CONVERGENCE
    + components.ciiSpike * W_CII_SPIKE
    + components.trendingSpike * W_TRENDING
    + components.categoryFit * W_CATEGORY
    + components.recency * W_RECENCY,
  );

  const recommendedFlavors = recommendFlavors(event, score);

  // Build rationale
  const parts: string[] = [];
  if (components.threat >= 75) parts.push(`${event.threat?.level ?? 'high'} threat`);
  if (components.sourceVelocity >= 60) parts.push(`${event.sourceCount} sources`);
  if (components.signalConvergence >= 50) parts.push('multi-signal convergence');
  if (components.trendingSpike >= 50) parts.push('trending spike');
  const rationale = parts.length > 0 ? parts.join(', ') : 'moderate interest';

  return { score, components, recommendedFlavors, rationale };
}

/**
 * Score all clustered events and return those above the threshold, sorted by score.
 */
export function rankBookWorthyEvents(
  events: ClusteredEvent[],
  ctx: BookWorthinessContext = {},
  minScore = 60,
): Array<{ event: ClusteredEvent; worthiness: BookWorthinessScore }> {
  return events
    .map((event) => ({ event, worthiness: scoreBookWorthiness(event, ctx) }))
    .filter((r) => r.worthiness.score >= minScore)
    .sort((a, b) => b.worthiness.score - a.worthiness.score);
}
