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
}

const EMPTY: CountryPortActivityResponse = {
  available: false,
  ports: [],
  fetchedAt: '',
};

export async function getCountryPortActivity(
  _ctx: ServerContext,
  req: GetCountryPortActivityRequest,
): Promise<CountryPortActivityResponse> {
  const code = req.countryCode?.trim().toUpperCase() ?? '';
  if (!code || code.length !== 2) return EMPTY;

  const countriesResult = await getCachedJson(PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY, true).catch(() => null);
  const countries = Array.isArray(countriesResult) ? (countriesResult as string[]) : [];
  if (!countries.includes(code)) return EMPTY;

  const data = await getCachedJson(`${PORTWATCH_PORT_ACTIVITY_KEY_PREFIX}${code}`, true).catch(() => null);
  if (!data) return EMPTY;

  const payload = data as SeederPayload;
  const rawPorts = Array.isArray(payload.ports) ? payload.ports : [];
  const top5 = rawPorts.slice(0, 5);

  const ports: PortActivityEntry[] = top5.map((p) => {
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
