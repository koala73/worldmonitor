/**
 * World Happiness Data Service
 *
 * Curated dataset of world happiness scores from the World Happiness Report 2025
 * (Cantril Ladder scores, 0-10 scale, for year 2024). Pre-processed from the
 * WHR Excel file into static JSON keyed by ISO 3166-1 Alpha-2 country codes.
 *
 * Refresh cadence: update world-happiness.json annually when new WHR data
 * is published (typically each March).
 */

export interface HappinessData {
  year: number;
  source: string;
  scores: Map<string, number>; // ISO-2 code -> Cantril Ladder score (0-10)
}

/**
 * Load curated world happiness scores from static JSON.
 * Uses dynamic import for code-splitting (JSON only loaded for happy variant).
 */
export async function fetchHappinessScores(): Promise<HappinessData> {
  const { default: raw } = await import('@/data/world-happiness.json');
  return {
    year: raw.year,
    source: raw.source,
    scores: new Map(Object.entries(raw.scores)),
  };
}
