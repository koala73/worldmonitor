/**
 * EIA (Energy Information Administration) Oil Analytics Service
 * Tracks crude oil prices, production, and inventory data
 * Requires free API key from https://www.eia.gov/opendata/
 */

import { dataFreshness } from './data-freshness';
import { isFeatureAvailable } from './runtime-config';
import { getCSSColor } from '@/utils';

export interface OilDataPoint {
  date: string;
  value: number;
  unit: string;
}

export interface OilMetric {
  id: string;
  name: string;
  description: string;
  current: number;
  previous: number;
  changePct: number;
  unit: string;
  trend: 'up' | 'down' | 'stable';
  lastUpdated: string;
}

export interface OilAnalytics {
  wtiPrice: OilMetric | null;
  brentPrice: OilMetric | null;
  usProduction: OilMetric | null;
  usInventory: OilMetric | null;
  fetchedAt: Date;
}

// EIA API series IDs (used by api/eia.js proxy)
// PET.RWTC.W - WTI Crude Oil Price (Weekly)
// PET.RBRTE.W - Brent Crude Oil Price (Weekly)
// PET.WCRFPUS2.W - US Crude Oil Production (Weekly)
// PET.WCESTUS1.W - US Crude Oil Inventory (Weekly)

const EIA_PROXY_URL = '/api/eia';

// Cache for API responses
let cachedData: OilAnalytics | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Check if EIA API is configured
 */
export async function checkEiaStatus(): Promise<boolean> {
  if (!isFeatureAvailable('energyEia')) return false;
  try {
    const response = await fetch(`${EIA_PROXY_URL}/health`);
    const data = await response.json();
    return data.configured === true;
  } catch {
    return false;
  }
}

/**
 * Fetch oil analytics data
 */
export async function fetchOilAnalytics(): Promise<OilAnalytics> {
  if (!isFeatureAvailable('energyEia')) {
    return { wtiPrice: null, brentPrice: null, usProduction: null, usInventory: null, fetchedAt: new Date() };
  }
  // Return cached data if fresh
  if (cachedData && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedData;
  }

  const result: OilAnalytics = {
    wtiPrice: null,
    brentPrice: null,
    usProduction: null,
    usInventory: null,
    fetchedAt: new Date(),
  };

  try {
    const response = await fetch(`${EIA_PROXY_URL}/petroleum`);

    if (!response.ok) {
      if (response.status === 503) {
        console.log('[EIA] API not configured');
        return result;
      }
      throw new Error(`EIA API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.wti) {
      result.wtiPrice = parseMetric(data.wti, 'WTI Crude', '$/barrel');
    }
    if (data.brent) {
      result.brentPrice = parseMetric(data.brent, 'Brent Crude', '$/barrel');
    }
    if (data.production) {
      result.usProduction = parseMetric(data.production, 'US Production', 'Mbbl/d');
    }
    if (data.inventory) {
      result.usInventory = parseMetric(data.inventory, 'US Inventory', 'M barrels');
    }

    // Cache the result
    cachedData = result;
    cacheTimestamp = Date.now();

    // Record freshness
    const metricCount = [result.wtiPrice, result.brentPrice, result.usProduction, result.usInventory]
      .filter(Boolean).length;
    if (metricCount > 0) {
      dataFreshness.recordUpdate('oil', metricCount);
    }

    console.log(`[EIA] Fetched ${metricCount} oil metrics`);
  } catch (error) {
    console.error('[EIA] Fetch failed:', error);
    dataFreshness.recordError('oil', error instanceof Error ? error.message : 'Unknown error');
  }

  return result;
}

function parseMetric(
  data: { current?: number; previous?: number; date?: string },
  name: string,
  unit: string
): OilMetric | null {
  if (data.current == null) return null;

  const current = data.current;
  const previous = data.previous ?? current;
  const changePct = previous !== 0 ? ((current - previous) / previous) * 100 : 0;

  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    description: `${name} price/volume`,
    current,
    previous,
    changePct: Math.round(changePct * 10) / 10,
    unit,
    trend: changePct > 0.5 ? 'up' : changePct < -0.5 ? 'down' : 'stable',
    lastUpdated: data.date || new Date().toISOString(),
  };
}

/**
 * Format oil metric for display
 */
export function formatOilValue(value: number, unit: string): string {
  if (unit.includes('$')) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toFixed(1);
}

/**
 * Get trend indicator
 */
export function getTrendIndicator(trend: OilMetric['trend']): string {
  switch (trend) {
    case 'up': return '▲';
    case 'down': return '▼';
    default: return '●';
  }
}

/**
 * Get trend color
 */
export function getTrendColor(trend: OilMetric['trend'], inverse = false): string {
  // For prices, up = bad (red), down = good (green) - unless inverse
  const upColor = inverse ? getCSSColor('--semantic-normal') : getCSSColor('--semantic-critical');
  const downColor = inverse ? getCSSColor('--semantic-critical') : getCSSColor('--semantic-normal');

  switch (trend) {
    case 'up': return upColor;
    case 'down': return downColor;
    default: return getCSSColor('--text-dim');
  }
}
