/**
 * Conservation Data Service
 *
 * Curated dataset of species conservation success stories compiled from
 * published reports (USFWS, IUCN, NOAA, WWF, etc.). The IUCN Red List API
 * provides category assessments but lacks population count time-series,
 * so a curated static JSON is the correct approach for showing recovery
 * trends with historical population data points.
 *
 * Refresh cadence: update conservation-wins.json when new census reports
 * are published (typically annually per species).
 */

export interface SpeciesRecovery {
  id: string;
  commonName: string;
  scientificName: string;
  photoUrl: string;
  iucnCategory: string;
  populationTrend: 'increasing' | 'stable';
  recoveryStatus: 'recovered' | 'recovering' | 'stabilized';
  populationData: Array<{ year: number; value: number }>;
  summaryText: string;
  source: string;
  region: string;
  lastUpdated: string;
  recoveryZone?: {
    name: string;
    lat: number;
    lon: number;
  };
}

/**
 * Load curated conservation wins from static JSON.
 * Uses dynamic import for code-splitting (JSON only loaded for happy variant).
 */
export async function fetchConservationWins(): Promise<SpeciesRecovery[]> {
  const { default: data } = await import('@/data/conservation-wins.json');
  return data as SpeciesRecovery[];
}
