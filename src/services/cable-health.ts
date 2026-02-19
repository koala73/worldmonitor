import type { CableHealthResponse, CableHealthRecord } from '@/types';

const CABLE_HEALTH_URL = '/api/cable-health';

let lastResponse: CableHealthResponse | null = null;
let lastFetchMs = 0;
const MIN_FETCH_INTERVAL_MS = 60_000; // Don't re-fetch within 1 minute

/**
 * Fetches cable health data from the backend.
 * Returns a map of cableId -> CableHealthRecord.
 * Uses a simple local cache to avoid redundant fetches.
 */
export async function fetchCableHealth(): Promise<CableHealthResponse> {
  const now = Date.now();
  if (lastResponse && now - lastFetchMs < MIN_FETCH_INTERVAL_MS) {
    return lastResponse;
  }

  try {
    const response = await fetch(CABLE_HEALTH_URL, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Cable health API error: ${response.status}`);
    }

    const data: CableHealthResponse = await response.json();
    lastResponse = data;
    lastFetchMs = now;

    const cableIds = Object.keys(data.cables || {});
    const faultCount = cableIds.filter(id => data.cables[id]?.status === 'fault').length;
    const degradedCount = cableIds.filter(id => data.cables[id]?.status === 'degraded').length;
    console.log(
      `[CableHealth] Fetched health for ${cableIds.length} cables ` +
      `(${faultCount} fault, ${degradedCount} degraded)`
    );

    return data;
  } catch (error) {
    console.error('[CableHealth] Failed to fetch cable health:', error);
    // Return last known state or empty response
    return lastResponse || { generatedAt: new Date().toISOString(), cables: {} };
  }
}

/**
 * Looks up a cable's health record from the last fetched response.
 */
export function getCableHealthRecord(cableId: string): CableHealthRecord | null {
  return lastResponse?.cables[cableId] ?? null;
}

/**
 * Returns the full cached health map (or empty object).
 */
export function getCableHealthMap(): Record<string, CableHealthRecord> {
  return lastResponse?.cables ?? {};
}
