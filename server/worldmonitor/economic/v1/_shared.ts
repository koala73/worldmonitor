/**
 * Shared helpers for the economic domain RPCs.
 */

import { CHROME_UA, yahooGate } from '../../../_shared/constants';
import { fetchWithTimeout } from './_fetch-with-timeout';

/**
 * Fetch JSON from a URL with a configurable timeout.
 * Rejects on non-2xx status.
 */
export async function fetchJSON(url: string, timeout = 8000): Promise<any> {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'yahoo.com' || parsed.hostname.endsWith('.yahoo.com')) {
      await yahooGate();
    }
  } catch {
    // Let fetchWithTimeout surface invalid URLs.
  }
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': CHROME_UA } }, timeout);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
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
