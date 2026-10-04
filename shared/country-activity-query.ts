import { countryBox, splitCountryBox } from './country-bbox';

export function countryActivityQueries(code: string) {
  const box = countryBox(code);
  if (!box) return [];
  return splitCountryBox(box).map(bounds => ({
    ne_lat: Math.min(90, bounds.north + 2),
    ne_lon: Math.min(180, bounds.east + 2),
    sw_lat: Math.max(-90, bounds.south - 2),
    sw_lon: Math.max(-180, bounds.west - 2),
  }));
}
