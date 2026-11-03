import type { AviationServiceHandler } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { EMERGENCY_CODES, type EmergencySnapshot } from '../../../../shared/aircraft-emergencies';
import { cachedFetchJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { parseEmergencyResponse } from './aircraft-emergency-source';

export async function fetchEmergencySnapshot(): Promise<EmergencySnapshot> {
  const slices = await Promise.all(EMERGENCY_CODES.map(async squawk => {
    try {
      const response = await fetch(`https://api.adsb.lol/v2/sqk/${squawk}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0 (aircraft emergency layer)' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseEmergencyResponse(await response.json(), squawk, Date.now());
    } catch {
      return { observations: [], feeds: [{ source: 'adsb.lol', squawk, status: 'unavailable', fetchedAt: Date.now(), message: 'Aircraft feed unavailable' }] };
    }
  }));
  return { observations: slices.flatMap(slice => slice.observations), feeds: slices.flatMap(slice => slice.feeds) };
}

// A snapshot in which every code query failed is an outage, not data. Returning
// null keeps it out of the positive cache and sends the no-store response below.
export async function fetchCacheableEmergencySnapshot(): Promise<EmergencySnapshot | null> {
  const snapshot = await fetchEmergencySnapshot();
  return snapshot.feeds.some(feed => feed.status !== 'unavailable') ? snapshot : null;
}

export const listAircraftEmergencies: AviationServiceHandler['listAircraftEmergencies'] = async ctx => {
  const snapshot = await cachedFetchJson<EmergencySnapshot>('aviation:emergency-squawks:v1', 30, fetchCacheableEmergencySnapshot, 15)
    .catch(() => null);
  if (snapshot) return snapshot;
  markNoCacheResponse(ctx.request);
  // Failures must remain visible. Do not replace them with an empty success or last-good data.
  return { observations: [], feeds: EMERGENCY_CODES.map(squawk => ({ source: 'adsb.lol', squawk, status: 'unavailable', fetchedAt: Date.now(), message: 'Aircraft feed unavailable' })) };
};
