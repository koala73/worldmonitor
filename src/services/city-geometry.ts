import type { CityCoord } from '../../api/data/city-coords';
import { CITY_COORDS } from '../../api/data/city-coords';

export interface CitySearchData extends CityCoord {
  city: string;
}

function normalizeCityName(city: string): string {
  return city.trim().toLowerCase();
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getCityCoords(city: string): CityCoord | null {
  return CITY_COORDS[normalizeCityName(city)] ?? null;
}

export function getCitySearchItems(): Array<{
  id: string;
  title: string;
  subtitle: string;
  data: CitySearchData;
}> {
  return Object.entries(CITY_COORDS).map(([key, coords]) => ({
    id: key,
    title: titleCase(key),
    subtitle: coords.country,
    data: { ...coords, city: key },
  }));
}
