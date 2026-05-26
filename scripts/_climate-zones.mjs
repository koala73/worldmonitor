export const CLIMATE_ZONES = [
  { name: 'Ukraine', lat: 48.4, lon: 31.2 },
  { name: 'Middle East', lat: 33.0, lon: 44.0 },
  { name: 'Sahel', lat: 14.0, lon: 0.0 },
  { name: 'Horn of Africa', lat: 8.0, lon: 42.0 },
  { name: 'South Asia', lat: 25.0, lon: 78.0 },
  { name: 'California', lat: 36.8, lon: -119.4 },
  { name: 'Amazon', lat: -3.4, lon: -60.0 },
  { name: 'Australia', lat: -25.0, lon: 134.0 },
  { name: 'Mediterranean', lat: 38.0, lon: 20.0 },
  { name: 'Taiwan Strait', lat: 24.0, lon: 120.0 },
  { name: 'Myanmar', lat: 19.8, lon: 96.7 },
  { name: 'Central Africa', lat: 4.0, lon: 22.0 },
  { name: 'Southern Africa', lat: -25.0, lon: 28.0 },
  { name: 'Central Asia', lat: 42.0, lon: 65.0 },
  { name: 'Caribbean', lat: 19.0, lon: -72.0 },
  { name: 'Arctic', lat: 70.0, lon: 0.0 },
  { name: 'Greenland', lat: 72.0, lon: -42.0 },
  { name: 'Western Antarctic Ice Sheet', lat: -78.0, lon: -100.0 },
  { name: 'Tibetan Plateau', lat: 31.0, lon: 91.0 },
  { name: 'Congo Basin', lat: -1.0, lon: 24.0 },
  { name: 'Coral Triangle', lat: -5.0, lon: 128.0 },
  { name: 'North Atlantic', lat: 55.0, lon: -30.0 },
];

export const REQUIRED_CLIMATE_ZONE_NAMES = [
  'Arctic',
  'Greenland',
  'Western Antarctic Ice Sheet',
  'Tibetan Plateau',
  'Congo Basin',
  'Coral Triangle',
  'North Atlantic',
];

export const MIN_CLIMATE_ZONE_COUNT = Math.ceil(CLIMATE_ZONES.length * 2 / 3);

export function hasRequiredClimateZones(items, getName = (item) => item?.zone ?? item?.name) {
  const present = new Set(items.map((item) => getName(item)).filter(Boolean));
  return REQUIRED_CLIMATE_ZONE_NAMES.every((name) => present.has(name));
}
