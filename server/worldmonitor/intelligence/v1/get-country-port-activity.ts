import type {
  ServerContext,
  GetCountryPortActivityRequest,
  CountryPortActivityResponse,
  PortActivityEntry,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import {
  PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY,
  PORTWATCH_PORT_ACTIVITY_KEY_PREFIX,
} from '../../../_shared/cache-keys';

interface SeederPort {
  portId?: string | null;
  portName?: string | null;
  lat?: number | null;
  lon?: number | null;
  tankerCalls30d?: number | null;
  trendDelta?: number | null;
  importTankerDwt30d?: number | null;
  exportTankerDwt30d?: number | null;
  anomalySignal?: boolean | null;
}

interface SeederPayload {
  iso2?: string | null;
  ports?: SeederPort[] | null;
  fetchedAt?: string | null;
  cacheWrittenAt?: number | null;
}

const EMPTY: CountryPortActivityResponse = {
  available: false,
  ports: [],
  fetchedAt: '',
};

// Keep the consumer's hard-expiry boundary aligned with the PortWatch seeder.
// The scheduler can retain an expired payload under its Redis key solely to
// preserve the durable refresh cursor while the last-good canonical pointer is
// held. That state must never become consumer-visible again.
export const PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS = 7 * 86_400_000;

export function isCurrentPortActivityPayload(
  payload: unknown,
  now = Date.now(),
  maxCacheAgeMs = PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS,
): payload is SeederPayload {
  if (!payload || typeof payload !== 'object') return false;
  const cacheWrittenAt = (payload as SeederPayload).cacheWrittenAt;
  return typeof cacheWrittenAt === 'number'
    && Number.isFinite(cacheWrittenAt)
    && (now - cacheWrittenAt) < maxCacheAgeMs;
}

export async function getCountryPortActivity(
  _ctx: ServerContext,
  req: GetCountryPortActivityRequest,
): Promise<CountryPortActivityResponse> {
  // ISO 3166-1 alpha-2 shape, not merely "two code units". The payload read below
  // now runs concurrently with the allowlist read, so this guard — not the
  // allowlist — is what bounds the key space a caller can reach (676, not ~1.1M).
  // The gateway applies no field validation to this request (the sibling
  // GetCountryRiskRequest carries stringPattern ^[A-Z]{2}$), so it must be here.
  const code = req.countryCode?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(code)) return EMPTY;

  // PERF: allowlist + payload reads run concurrently; the gate is applied on
  // the combined result. Valid codes save a serial RTT; invalid ones cost one
  // extra small read instead of one extra RTT on every valid request.
  const [countriesResult, data] = await Promise.all([
    getCachedJson(PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY, true).catch(() => null),
    getCachedJson(`${PORTWATCH_PORT_ACTIVITY_KEY_PREFIX}${code}`, true).catch(() => null),
  ]);
  const countries = Array.isArray(countriesResult) ? (countriesResult as string[]) : [];
  if (!countries.includes(code)) return EMPTY;
  if (!data) return EMPTY;

  const payload = data as SeederPayload;
  if (!isCurrentPortActivityPayload(payload)) return EMPTY;
  const rawPorts = Array.isArray(payload.ports) ? payload.ports : [];
  const topPorts = rawPorts.slice(0, 25);

  const ports: PortActivityEntry[] = topPorts.map((p) => {
    const calls30d = typeof p.tankerCalls30d === 'number' ? Math.round(p.tankerCalls30d) : 0;

    return {
      portId: p.portId ?? '',
      portName: p.portName ?? '',
      lat: typeof p.lat === 'number' ? p.lat : 0,
      lon: typeof p.lon === 'number' ? p.lon : 0,
      tankerCalls30d: calls30d,
      trendDeltaPct: typeof p.trendDelta === 'number' ? p.trendDelta : 0,
      importTankerDwt: typeof p.importTankerDwt30d === 'number' ? p.importTankerDwt30d : 0,
      exportTankerDwt: typeof p.exportTankerDwt30d === 'number' ? p.exportTankerDwt30d : 0,
      anomalySignal: p.anomalySignal === true,
    };
  });

  return {
    available: true,
    ports,
    fetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : '',
  };
}
