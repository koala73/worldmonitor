/**
 * Renewable Energy Installation Data Service
 *
 * Curated dataset of notable renewable energy installations worldwide,
 * including utility-scale solar farms, wind farms, hydro stations, and
 * geothermal sites. Compiled from WRI Global Power Plant Database and
 * published project reports.
 *
 * Refresh cadence: update renewable-installations.json when notable
 * new installations reach operational status.
 */

export interface RenewableInstallation {
  id: string;
  name: string;
  type: 'solar' | 'wind' | 'hydro' | 'geothermal';
  capacityMW: number;
  country: string; // ISO-2
  lat: number;
  lon: number;
  status: 'operational' | 'under_construction';
  year: number;
}

/**
 * Load curated renewable energy installations from static JSON.
 * Uses dynamic import for code-splitting (JSON only loaded for happy variant).
 */
export async function fetchRenewableInstallations(): Promise<RenewableInstallation[]> {
  const { default: data } = await import('@/data/renewable-installations.json');
  return data as RenewableInstallation[];
}
