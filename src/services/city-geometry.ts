import type { CityCoord } from '../../api/data/city-coords';
import { CITY_COORDS } from '../../api/data/city-coords';
import { CITY_BOUNDARIES } from '../../api/data/city-boundaries';

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

function createCityBoundaryFallback(city: string, coord: CityCoord): GeoJSON.FeatureCollection {
  const normalized = normalizeCityName(city);
  const latOffset = 0.12;
  const lonScale = Math.cos(coord.lat * Math.PI / 180);
  const lonOffset = Math.min(0.75, latOffset / Math.max(0.3, lonScale));
  const lng = coord.lng;
  const lat = coord.lat;

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        city: titleCase(normalized),
        country: coord.country,
        fallback: true,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lng - lonOffset, lat - latOffset],
          [lng + lonOffset, lat - latOffset],
          [lng + lonOffset, lat + latOffset],
          [lng - lonOffset, lat + latOffset],
          [lng - lonOffset, lat - latOffset],
        ]],
      },
    }],
  };
}

export function getCityBoundary(city: string): GeoJSON.FeatureCollection | null {
  const normalized = normalizeCityName(city);
  const feature = CITY_BOUNDARIES[normalized];
  if (feature) {
    return { type: 'FeatureCollection', features: [feature] };
  }

  const coord = CITY_COORDS[normalized];
  if (!coord || coord.virtual) {
    return null;
  }

  return createCityBoundaryFallback(normalized, coord);
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
