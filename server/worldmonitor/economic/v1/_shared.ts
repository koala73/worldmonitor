/**
 * Shared helpers for the economic domain RPCs.
 */

import { CHROME_UA, yahooGate } from '../../../_shared/constants';

/**
 * Fetch JSON from a URL with a configurable timeout.
 * Rejects on non-2xx status.
 */
export async function fetchJSON(url: string, timeout = 8000): Promise<any> {
  if (url.includes('yahoo.com')) await yahooGate();
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

/**
 * Rate of change between the most recent price and the price `days` ago.
 * Returns null if there is insufficient data.
 */
export function rateOfChange(prices: number[], days: number): number | null {
  if (!prices || prices.length < days + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - days];
  if (!past || past === 0) return null;
  return ((recent! - past) / past) * 100;
}

/**
 * Simple moving average over the last `period` entries.
 */
export function smaCalc(prices: number[], period: number): number | null {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Extract closing prices from a Yahoo Finance v8 chart response.
 */
export function extractClosePrices(chart: any): number[] {
  try {
    const result = chart?.chart?.result?.[0];
    return result?.indicators?.quote?.[0]?.close?.filter((p: any) => p != null) || [];
  } catch {
    return [];
  }
}

/**
 * Extract volumes from a Yahoo Finance v8 chart response.
 */
export function extractVolumes(chart: any): number[] {
  try {
    const result = chart?.chart?.result?.[0];
    return result?.indicators?.quote?.[0]?.volume?.filter((v: any) => v != null) || [];
  } catch {
    return [];
  }
}

/**
 * Extract aligned price/volume pairs from a Yahoo Finance v8 chart response.
 * Only includes entries where both price and volume are non-null.
 */
export function extractAlignedPriceVolume(chart: any): Array<{ price: number; volume: number }> {
  try {
    const result = chart?.chart?.result?.[0];
    const closes: any[] = result?.indicators?.quote?.[0]?.close || [];
    const volumes: any[] = result?.indicators?.quote?.[0]?.volume || [];
    const pairs: Array<{ price: number; volume: number }> = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null && volumes[i] != null) {
        pairs.push({ price: closes[i], volume: volumes[i] });
      }
    }
    return pairs;
  } catch {
    return [];
  }
}
