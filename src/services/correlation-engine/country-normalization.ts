import { getCountryAtCoordinates, iso3ToIso2Code, nameToCountryCode } from '@/services/country-geometry';
import { toIso2 } from '@/utils/country-codes';

export function normalizeToCountryCode(country: string | undefined, lat?: number, lon?: number): string | undefined {
  const trimmed = country?.trim();
  if (trimmed) {
    const fromCommonName = toIso2(trimmed);
    if (fromCommonName) return fromCommonName;
    const fromName = nameToCountryCode(trimmed);
    if (fromName) return fromName;
    if (trimmed.length === 3) {
      const fromIso3 = iso3ToIso2Code(trimmed);
      if (fromIso3) return fromIso3;
    }
    if (trimmed.length === 2) return trimmed.toUpperCase();
  }
  if (lat != null && lon != null && !(lat === 0 && lon === 0)) {
    return getCountryAtCoordinates(lat, lon)?.code;
  }
  return undefined;
}
