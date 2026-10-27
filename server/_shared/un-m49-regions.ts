import table from '../../shared/un-m49-regions.json';

/** UN M49 region, sub-region and intermediate-region slugs, e.g. latin-america-and-the-caribbean. */
export const UN_M49_REGION_IDS = Object.keys(table.regions);

const REGIONS: Record<string, { countries: string[] }> = table.regions;

/** Member ISO2 countries of an M49 region slug, or null when the slug is unknown. */
export function unM49RegionCountries(id: string): string[] | null {
  return REGIONS[id]?.countries ?? null;
}
