/**
 * Curated hotspot-to-country mapping shared by browser and server analysis.
 *
 * Hotspot ids are descriptive slugs, while CII caches are keyed by ISO-2
 * country codes. Regional hotspots may map to multiple countries; callers
 * should aggregate the available country values according to their domain
 * semantics (the escalation score uses the maximum live CII).
 */
export const HOTSPOT_COUNTRY_MAP: Readonly<Record<string, string | readonly string[]>> = {
  tehran: 'IR',
  moscow: 'RU',
  beijing: 'CN',
  kyiv: 'UA',
  taipei: 'TW',
  telaviv: 'IL',
  pyongyang: 'KP',
  sanaa: 'YE',
  riyadh: 'SA',
  ankara: 'TR',
  damascus: 'SY',
  caracas: 'VE',
  dc: 'US',
  london: 'GB',
  brussels: 'BE',
  baghdad: 'IQ',
  beirut: 'LB',
  doha: 'QA',
  abudhabi: 'AE',
  mexico: 'MX',
  havana: 'CU',
  nuuk: 'GL',
  sahel: ['ML', 'NE', 'BF'],
  haiti: 'HT',
  horn_africa: ['ET', 'SO', 'SD'],
  pak_afghan: ['PK', 'AF'],
  silicon_valley: 'US',
  wall_street: 'US',
  houston: 'US',
  cairo: 'EG',
};

export function getHotspotCountries(hotspotId: string): string[] {
  const value = HOTSPOT_COUNTRY_MAP[hotspotId];
  if (!value) return [];
  return Array.isArray(value) ? [...value] : [value as string];
}

export function getHotspotCountryScore(
  hotspotId: string,
  getScore: (countryCode: string) => number | null,
): number | null {
  const scores = getHotspotCountries(hotspotId)
    .map(getScore)
    .filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.max(...scores) : null;
}
