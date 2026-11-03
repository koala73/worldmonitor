import { AviationServiceClient } from './generated-rpc-clients';
import { getRpcBaseUrl } from './rpc-client';
import { EMERGENCY_CODES, type EmergencySnapshot } from '../../shared/aircraft-emergencies';

const client = new AviationServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

export async function fetchAircraftEmergencies(signal?: AbortSignal): Promise<EmergencySnapshot> {
  try {
    return await client.listAircraftEmergencies({}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  } catch {
    return { observations: [], feeds: EMERGENCY_CODES.map(squawk => ({ source: 'adsb.lol', squawk, status: 'unavailable', fetchedAt: Date.now(), message: 'Aircraft feed unavailable' })) };
  }
}
