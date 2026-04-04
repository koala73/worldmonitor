import type { ResilienceRankingItem } from '@/services/resilience';
import type { MapLayers } from '@/types';

export type ResilienceChoroplethLevel = 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';

export interface ResilienceChoroplethEntry {
  overallScore: number;
  level: ResilienceChoroplethLevel;
  serverLevel: string;
  lowConfidence: boolean;
}

export const RESILIENCE_CHOROPLETH_COLORS: Record<ResilienceChoroplethLevel, [number, number, number, number]> = {
  very_low: [239, 68, 68, 160],
  low: [249, 115, 22, 160],
  moderate: [234, 179, 8, 160],
  high: [132, 204, 22, 160],
  very_high: [34, 197, 94, 160],
};

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Number(score.toFixed(1))));
}

export function getResilienceChoroplethLevel(score: number): ResilienceChoroplethLevel {
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'very_low';
}

export function formatResilienceChoroplethLevel(level: ResilienceChoroplethLevel): string {
  return level.replace(/_/g, ' ');
}

export function buildResilienceChoroplethMap(items: ResilienceRankingItem[]): Map<string, ResilienceChoroplethEntry> {
  const scores = new Map<string, ResilienceChoroplethEntry>();

  for (const item of items) {
    const countryCode = String(item.countryCode || '').trim().toUpperCase();
    const overallScore = Number(item.overallScore);
    if (!/^[A-Z]{2}$/.test(countryCode) || !Number.isFinite(overallScore) || overallScore < 0) continue;

    const normalizedScore = clampScore(overallScore);
    scores.set(countryCode, {
      overallScore: normalizedScore,
      level: getResilienceChoroplethLevel(normalizedScore),
      serverLevel: String(item.level || 'unknown'),
      lowConfidence: Boolean(item.lowConfidence),
    });
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
