/**
 * Shared climate zone definitions.
 * ZONES = original 15 geopolitical zones
 * CLIMATE_ZONES = 7 additional climate-specific zones
 * ALL_ZONES = ZONES + CLIMATE_ZONES
 *
 * Single source of truth — import this in both seeders to keep them in sync.
 */

export const ZONES = [
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
];

export const CLIMATE_ZONES = [
  { name: 'Arctic', lat: 70.0, lon: 0.0 },
  { name: 'Greenland', lat: 72.0, lon: -42.0 },
  { name: 'WestAntarctic', lat: -78.0, lon: -100.0 },
  { name: 'TibetanPlateau', lat: 31.0, lon: 91.0 },
  { name: 'CongoBasin', lat: -1.0, lon: 24.0 },
  { name: 'CoralTriangle', lat: -5.0, lon: 128.0 },
  { name: 'NorthAtlantic', lat: 55.0, lon: -30.0 },
];

export const ALL_ZONES = [...ZONES, ...CLIMATE_ZONES];

export const MIN_ZONES = Math.ceil(ALL_ZONES.length * 2 / 3); // 15
