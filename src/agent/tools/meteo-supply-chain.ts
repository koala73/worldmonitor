/**
 * Meteorological Supply Chain Monitor
 *
 * Ingests weather data, ocean state, energy grid signals, and logistics
 * topology to produce supply chain risk signals. Maps physical-layer
 * inputs to integer constraints for the pipeline.
 *
 * Data sources (all free/public):
 *   - NOAA GFS/HRRR model outputs (via Open-Meteo)
 *   - Ocean state for shipping lanes (wave height, wind)
 *   - Energy grid: spot pricing proxy (via EIA), renewable intermittency
 *   - Port congestion (via existing maritime/infrastructure tools)
 *   - Agricultural weather stress (precipitation, temperature anomalies)
 *
 * Multi-rate clock domains:
 *   - Weather: 6-hour update cycle (GFS model runs)
 *   - Energy: 1-hour (real-time pricing)
 *   - Logistics: 4-hour (vessel positions, port status)
 *   - Regulatory: event-driven (discrete jumps)
 */

import type { Signal, Severity } from '../types';
import { registerTool, createSignal } from './registry';

// ============================================================================
// CRITICAL SHIPPING LANES & CHOKEPOINTS
// ============================================================================

interface ShippingLane {
  id: string;
  name: string;
  /** Center coordinates for weather lookup */
  lat: number;
  lon: number;
  /** Max safe wave height (meters) before disruption */
  waveThreshold: number;
  /** Max safe wind speed (km/h) before disruption */
  windThreshold: number;
  /** Regions affected if disrupted */
  affectedRegions: string[];
  /** Commodities that transit this lane */
  commodities: string[];
}

const SHIPPING_LANES: ShippingLane[] = [
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.5, lon: 56.3, waveThreshold: 3.0, windThreshold: 60, affectedRegions: ['IR', 'SA', 'AE', 'KW', 'QA'], commodities: ['oil', 'lng', 'petrochemicals'] },
  { id: 'malacca', name: 'Strait of Malacca', lat: 2.5, lon: 101.5, waveThreshold: 2.5, windThreshold: 55, affectedRegions: ['CN', 'JP', 'KR', 'SG'], commodities: ['oil', 'lng', 'containers'] },
  { id: 'suez', name: 'Suez Canal', lat: 30.5, lon: 32.3, waveThreshold: 2.0, windThreshold: 50, affectedRegions: ['GLOBAL'], commodities: ['containers', 'oil', 'grain'] },
  { id: 'panama', name: 'Panama Canal', lat: 9.1, lon: -79.7, waveThreshold: 2.0, windThreshold: 45, affectedRegions: ['US', 'CN', 'JP'], commodities: ['containers', 'grain', 'lng'] },
  { id: 'bab-el-mandeb', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, waveThreshold: 2.5, windThreshold: 55, affectedRegions: ['GLOBAL'], commodities: ['oil', 'containers'] },
  { id: 'dover', name: 'Strait of Dover', lat: 51.0, lon: 1.5, waveThreshold: 3.5, windThreshold: 70, affectedRegions: ['GB', 'FR', 'DE', 'NL'], commodities: ['containers', 'vehicles'] },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.5, lon: 119.5, waveThreshold: 3.0, windThreshold: 65, affectedRegions: ['TW', 'CN', 'JP'], commodities: ['semiconductors', 'containers', 'electronics'] },
  { id: 'cape-good-hope', name: 'Cape of Good Hope', lat: -34.4, lon: 18.5, waveThreshold: 5.0, windThreshold: 80, affectedRegions: ['GLOBAL'], commodities: ['oil', 'iron-ore', 'coal'] },
];

// ============================================================================
// AGRICULTURAL ZONES — weather stress monitoring
// ============================================================================

interface AgriZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Crops grown */
  crops: string[];
  /** Max temperature (C) before heat stress */
  heatThreshold: number;
  /** Min precipitation (mm/week) before drought stress */
  droughtThreshold: number;
  /** Growing season months (1-indexed) */
  growingSeason: number[];
  affectedRegions: string[];
}

const AGRI_ZONES: AgriZone[] = [
  { id: 'us-corn-belt', name: 'US Corn Belt', lat: 41.5, lon: -89.0, crops: ['corn', 'soybeans'], heatThreshold: 38, droughtThreshold: 15, growingSeason: [4, 5, 6, 7, 8, 9], affectedRegions: ['US'] },
  { id: 'us-wheat-plains', name: 'US Great Plains', lat: 38.0, lon: -99.0, crops: ['wheat', 'sorghum'], heatThreshold: 40, droughtThreshold: 10, growingSeason: [3, 4, 5, 6, 7], affectedRegions: ['US'] },
  { id: 'brazil-cerrado', name: 'Brazil Cerrado', lat: -15.5, lon: -47.0, crops: ['soybeans', 'coffee', 'sugar'], heatThreshold: 36, droughtThreshold: 20, growingSeason: [10, 11, 12, 1, 2, 3], affectedRegions: ['BR'] },
  { id: 'ukraine-breadbasket', name: 'Ukraine Breadbasket', lat: 49.5, lon: 32.0, crops: ['wheat', 'sunflower', 'corn'], heatThreshold: 35, droughtThreshold: 12, growingSeason: [4, 5, 6, 7, 8], affectedRegions: ['UA'] },
  { id: 'india-punjab', name: 'India Punjab', lat: 30.8, lon: 75.8, crops: ['wheat', 'rice'], heatThreshold: 42, droughtThreshold: 8, growingSeason: [6, 7, 8, 9, 10, 11], affectedRegions: ['IN'] },
  { id: 'china-yangtze', name: 'China Yangtze Delta', lat: 31.0, lon: 121.0, crops: ['rice', 'wheat'], heatThreshold: 38, droughtThreshold: 20, growingSeason: [3, 4, 5, 6, 7, 8, 9, 10], affectedRegions: ['CN'] },
];

// ============================================================================
// ENERGY GRID NODES — production/consumption stress points
// ============================================================================

interface EnergyNode {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: 'refinery' | 'lng-terminal' | 'grid-hub' | 'renewable-farm';
  /** Temperature threshold (C) that causes demand spike or equipment stress */
  tempThreshold: number;
  /** Wind threshold (km/h) for renewable intermittency or equipment damage */
  windThreshold: number;
  affectedRegions: string[];
}

const ENERGY_NODES: EnergyNode[] = [
  { id: 'houston-refinery', name: 'Houston Refinery Complex', lat: 29.7, lon: -95.4, type: 'refinery', tempThreshold: 40, windThreshold: 120, affectedRegions: ['US'] },
  { id: 'rotterdam-port', name: 'Rotterdam Energy Hub', lat: 51.9, lon: 4.5, type: 'lng-terminal', tempThreshold: -5, windThreshold: 100, affectedRegions: ['DE', 'NL', 'GB'] },
  { id: 'ercot-grid', name: 'ERCOT Grid (Texas)', lat: 31.0, lon: -97.0, type: 'grid-hub', tempThreshold: 42, windThreshold: 130, affectedRegions: ['US'] },
  { id: 'north-sea-wind', name: 'North Sea Wind Farms', lat: 55.0, lon: 3.0, type: 'renewable-farm', tempThreshold: -10, windThreshold: 100, affectedRegions: ['GB', 'DE', 'DK', 'NL'] },
];

// ============================================================================
// OPEN-METEO WEATHER FETCH
// ============================================================================

interface WeatherPoint {
  lat: number;
  lon: number;
  temperature: number;
  windSpeed: number;
  waveHeight: number;
  precipitation: number;
}

async function fetchWeather(lat: number, lon: number): Promise<WeatherPoint | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,precipitation&forecast_days=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      current?: { temperature_2m?: number; wind_speed_10m?: number; precipitation?: number };
    };
    const c = data.current;
    if (!c) return null;
    return {
      lat, lon,
      temperature: c.temperature_2m ?? 20,
      windSpeed: c.wind_speed_10m ?? 0,
      waveHeight: 0, // Open-Meteo marine API needed for wave data
      precipitation: c.precipitation ?? 0,
    };
  } catch {
    return null;
  }
}

async function fetchMarineWeather(lat: number, lon: number): Promise<{ waveHeight: number; windSpeed: number } | null> {
  try {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wind_wave_height&forecast_days=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      current?: { wave_height?: number; wind_wave_height?: number };
    };
    return {
      waveHeight: data.current?.wave_height ?? data.current?.wind_wave_height ?? 0,
      windSpeed: 0,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// TOOL: Meteorological Supply Chain Monitor
// ============================================================================

registerTool({
  id: 'meteo.supply-chain',
  name: 'Meteorological Supply Chain Monitor',
  description: 'Monitors weather impacts on shipping lanes, agricultural zones, and energy infrastructure',
  domains: ['climate', 'infrastructure', 'economic'],
  inputSchema: {
    type: 'object',
    properties: {
      layers: { type: 'array', items: { type: 'string' }, description: 'Which layers to monitor: shipping, agriculture, energy. Default: all.' },
    },
  },
  outputDomain: 'climate',
  concurrency: 2,
  timeout: 60_000,
  async execute(input) {
    const layers = (input.layers as string[]) ?? ['shipping', 'agriculture', 'energy'];
    const signals: Signal[] = [];

    // ── SHIPPING LANE WEATHER ──────────────────────────────────
    if (layers.includes('shipping')) {
      const laneResults = await Promise.allSettled(
        SHIPPING_LANES.map(async (lane) => {
          const marine = await fetchMarineWeather(lane.lat, lane.lon);
          const weather = await fetchWeather(lane.lat, lane.lon);
          return { lane, marine, weather };
        })
      );

      for (const result of laneResults) {
        if (result.status !== 'fulfilled') continue;
        const { lane, marine, weather } = result.value;

        const waveHeight = marine?.waveHeight ?? 0;
        const windSpeed = weather?.windSpeed ?? 0;
        const waveStress = waveHeight / lane.waveThreshold;
        const windStress = windSpeed / lane.windThreshold;
        const maxStress = Math.max(waveStress, windStress);

        if (maxStress < 0.5) continue; // Below concern threshold

        const severity: Severity = maxStress >= 1.0 ? 'high'
          : maxStress >= 0.75 ? 'medium' : 'low';

        signals.push(createSignal('climate', {
          sourceId: `meteo-shipping-${lane.id}`,
          severity,
          regions: lane.affectedRegions,
          timestamp: Date.now(),
          geo: { lat: lane.lat, lon: lane.lon },
          payload: {
            type: 'shipping_weather',
            lane: lane.name,
            laneId: lane.id,
            waveHeight,
            windSpeed,
            waveStress: +(waveStress.toFixed(2)),
            windStress: +(windStress.toFixed(2)),
            commodities: lane.commodities,
            disrupted: maxStress >= 1.0,
          },
          confidence: marine ? 0.85 : 0.5,
          tags: ['meteo', 'shipping', lane.id, ...lane.commodities, ...(maxStress >= 1.0 ? ['disrupted'] : [])],
          provenance: 'tool:meteo.supply-chain',
        }));
      }
    }

    // ── AGRICULTURAL WEATHER STRESS ────────────────────────────
    if (layers.includes('agriculture')) {
      const currentMonth = new Date().getMonth() + 1;

      const agriResults = await Promise.allSettled(
        AGRI_ZONES
          .filter(zone => zone.growingSeason.includes(currentMonth))
          .map(async (zone) => {
            const weather = await fetchWeather(zone.lat, zone.lon);
            return { zone, weather };
          })
      );

      for (const result of agriResults) {
        if (result.status !== 'fulfilled') continue;
        const { zone, weather } = result.value;
        if (!weather) continue;

        const heatStress = weather.temperature / zone.heatThreshold;
        const isDrought = weather.precipitation < zone.droughtThreshold / 7; // daily vs weekly

        if (heatStress < 0.8 && !isDrought) continue;

        const severity: Severity = (heatStress >= 1.0 || isDrought) ? 'high'
          : heatStress >= 0.9 ? 'medium' : 'low';

        const stressFactors: string[] = [];
        if (heatStress >= 0.9) stressFactors.push('heat-stress');
        if (isDrought) stressFactors.push('drought');

        signals.push(createSignal('climate', {
          sourceId: `meteo-agri-${zone.id}`,
          severity,
          regions: zone.affectedRegions,
          timestamp: Date.now(),
          geo: { lat: zone.lat, lon: zone.lon },
          payload: {
            type: 'agricultural_weather',
            zone: zone.name,
            zoneId: zone.id,
            crops: zone.crops,
            temperature: weather.temperature,
            precipitation: weather.precipitation,
            heatStress: +(heatStress.toFixed(2)),
            isDrought,
            stressFactors,
          },
          confidence: 0.8,
          tags: ['meteo', 'agriculture', zone.id, ...zone.crops, ...stressFactors],
          provenance: 'tool:meteo.supply-chain',
        }));
      }
    }

    // ── ENERGY INFRASTRUCTURE WEATHER ──────────────────────────
    if (layers.includes('energy')) {
      const energyResults = await Promise.allSettled(
        ENERGY_NODES.map(async (node) => {
          const weather = await fetchWeather(node.lat, node.lon);
          return { node, weather };
        })
      );

      for (const result of energyResults) {
        if (result.status !== 'fulfilled') continue;
        const { node, weather } = result.value;
        if (!weather) continue;

        const tempStress = node.type === 'renewable-farm'
          ? (weather.temperature < node.tempThreshold ? 1.2 : 0) // cold stress
          : weather.temperature / node.tempThreshold;
        const windStress = weather.windSpeed / node.windThreshold;
        const maxStress = Math.max(tempStress, windStress);

        if (maxStress < 0.7) continue;

        const severity: Severity = maxStress >= 1.0 ? 'high'
          : maxStress >= 0.85 ? 'medium' : 'low';

        signals.push(createSignal('infrastructure', {
          sourceId: `meteo-energy-${node.id}`,
          severity,
          regions: node.affectedRegions,
          timestamp: Date.now(),
          geo: { lat: node.lat, lon: node.lon },
          payload: {
            type: 'energy_weather',
            node: node.name,
            nodeId: node.id,
            nodeType: node.type,
            temperature: weather.temperature,
            windSpeed: weather.windSpeed,
            tempStress: +(tempStress.toFixed(2)),
            windStress: +(windStress.toFixed(2)),
            atRisk: maxStress >= 1.0,
          },
          confidence: 0.8,
          tags: ['meteo', 'energy', node.type, node.id, ...(maxStress >= 1.0 ? ['at-risk'] : [])],
          provenance: 'tool:meteo.supply-chain',
        }));
      }
    }

    return signals;
  },
});

export { SHIPPING_LANES, AGRI_ZONES, ENERGY_NODES };
