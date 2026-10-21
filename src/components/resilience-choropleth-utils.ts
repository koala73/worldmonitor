import type { ResilienceRankingItem } from '@/services/resilience';
import type { MapLayers } from '@/types';
import { getResilienceVisualLevel, hasScoredResilienceOverall } from './resilience-widget-utils';

export type ResilienceChoroplethLevel = 'very_low' | 'low' | 'moderate' | 'high' | 'very_high' | 'insufficient_data';

export interface ResilienceChoroplethEntry {
  overallScore: number;
  level: ResilienceChoroplethLevel;
  serverLevel: string;
  lowConfidence: boolean;
  outsideHeadlineRanking: boolean;
}

export const RESILIENCE_CHOROPLETH_COLORS: Record<ResilienceChoroplethLevel, [number, number, number, number]> = {
  very_low: [239, 68, 68, 160],
  low: [249, 115, 22, 160],
  moderate: [234, 179, 8, 160],
  high: [132, 204, 22, 160],
  very_high: [34, 197, 94, 160],
  insufficient_data: [120, 120, 120, 60],
};

const INSUFFICIENT_SERVER_LEVELS = new Set(['insufficient', 'insufficient_data', 'insufficient data', 'insufficient-data']);

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Number(score.toFixed(1))));
}

function normalizeServerLevel(level: string | null | undefined): string {
  return String(level || 'unknown').trim().toLowerCase();
}

function hasScoredResilienceRankingItem(item: ResilienceRankingItem): boolean {
  const overallScore = Number(item.overallScore);
  if (!hasScoredResilienceOverall({ overallScore, level: item.level })) return false;

  const serverLevel = normalizeServerLevel(item.level);
  return overallScore !== 0 || !INSUFFICIENT_SERVER_LEVELS.has(serverLevel);
}

function toResilienceChoroplethEntry(item: ResilienceRankingItem): [string, ResilienceChoroplethEntry] | null {
  const countryCode = String(item.countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;

  if (!hasScoredResilienceRankingItem(item)) {
    return [countryCode, {
      overallScore: 0,
      level: 'insufficient_data',
      serverLevel: normalizeServerLevel(item.level),
      lowConfidence: true,
      outsideHeadlineRanking: false,
    }];
  }

  const normalizedScore = clampScore(Number(item.overallScore));
  return [countryCode, {
    overallScore: normalizedScore,
    level: getResilienceChoroplethLevel(normalizedScore),
    serverLevel: normalizeServerLevel(item.level),
    lowConfidence: Boolean(item.lowConfidence),
    outsideHeadlineRanking: item.headlineEligible === false,
  }];
}

export function getResilienceChoroplethLevel(score: number): ResilienceChoroplethLevel {
  const visualLevel = getResilienceVisualLevel(score);
  return visualLevel === 'unknown' ? 'insufficient_data' : visualLevel;
}

export function formatResilienceChoroplethLevel(level: ResilienceChoroplethLevel): string {
  return level.replace(/_/g, ' ');
}

export function buildResilienceChoroplethMap(
  items: ResilienceRankingItem[],
  greyedOut: ResilienceRankingItem[] = [],
): Map<string, ResilienceChoroplethEntry> {
  const scores = new Map<string, ResilienceChoroplethEntry>();

  for (const item of items) {
    const entry = toResilienceChoroplethEntry(item);
    if (entry) scores.set(entry[0], entry[1]);
  }

  for (const item of greyedOut) {
    const entry = toResilienceChoroplethEntry(item);
    if (entry) scores.set(entry[0], entry[1]);
  }

  return scores;
}

type ChoroplethToggleState = Pick<MapLayers, 'ciiChoropleth' | 'resilienceScore'>;

export function normalizeExclusiveChoropleths(
  layers: MapLayers,
  previousLayers?: ChoroplethToggleState | null,
): MapLayers {
  if (!layers.resilienceScore || !layers.ciiChoropleth) {
    return { ...layers };
  }

  const resilienceJustEnabled = layers.resilienceScore && !(previousLayers?.resilienceScore ?? false);
  const ciiJustEnabled = layers.ciiChoropleth && !(previousLayers?.ciiChoropleth ?? false);

  if (resilienceJustEnabled && !ciiJustEnabled) {
    return { ...layers, ciiChoropleth: false };
  }
  if (ciiJustEnabled && !resilienceJustEnabled) {
    return { ...layers, resilienceScore: false };
  }

  // Both newly enabled (e.g. bookmark restore): CII is the established layer, keep it
  return { ...layers, resilienceScore: false };
}
