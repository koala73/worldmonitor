import type { TransportVesselRecord } from './types';

declare const process: { env: Record<string, string | undefined> };

export interface TransportMaritimeProvider {
  name: 'marinetraffic' | 'aisstream' | 'vesselfinder' | 'aishub';
  listCivilVessels(): Promise<TransportVesselRecord[]>;
}

export class MarineTrafficProvider implements TransportMaritimeProvider {
  public readonly name = 'marinetraffic';

  public async listCivilVessels(): Promise<TransportVesselRecord[]> {
    const enabled = (process.env.ENABLE_MARINETRAFFIC || 'false').toLowerCase() !== 'false';
    const apiKey = (process.env.MARINETRAFFIC_API_KEY || '').trim();
    const baseUrl = (process.env.MARINETRAFFIC_API_BASE_URL || '').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      if (!url.searchParams.has('api_key')) url.searchParams.set('api_key', apiKey);
      if (!url.searchParams.has('protocol')) url.searchParams.set('protocol', 'jsono');

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];

      const payload = await response.json();
      return collectVesselRows(payload)
        .map((row, index) => mapToVesselRecord(row, index))
        .filter((row): row is TransportVesselRecord => Boolean(row));
    } catch {
      return [];
    }
  }
}

export class AisStreamProvider implements TransportMaritimeProvider {
  public readonly name = 'aisstream';

  public async listCivilVessels(): Promise<TransportVesselRecord[]> {
    const enabled = (process.env.ENABLE_AISSTREAM_AIS || 'true').toLowerCase() !== 'false';
    const apiKey = (process.env.AISSTREAM_API_KEY || '').trim();
    const baseUrl = (process.env.AISSTREAM_API_BASE_URL || '').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      if (!url.searchParams.has('api_key')) url.searchParams.set('api_key', apiKey);
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return collectVesselRows(payload)
        .map((row, index) => mapToVesselRecord(row, index, 'aisstream'))
        .filter((row): row is TransportVesselRecord => Boolean(row));
    } catch {
      return [];
    }
  }
}

export class VesselFinderProvider implements TransportMaritimeProvider {
  public readonly name = 'vesselfinder';

  public async listCivilVessels(): Promise<TransportVesselRecord[]> {
    const enabled = (process.env.ENABLE_VESSELFINDER_AIS || 'true').toLowerCase() !== 'false';
    const apiKey = (process.env.VESSELFINDER_API_KEY || '').trim();
    const baseUrl = (process.env.VESSELFINDER_API_BASE_URL || '').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      if (!url.searchParams.has('api_key')) url.searchParams.set('api_key', apiKey);
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return collectVesselRows(payload)
        .map((row, index) => mapToVesselRecord(row, index, 'vesselfinder'))
        .filter((row): row is TransportVesselRecord => Boolean(row));
    } catch {
      return [];
    }
  }
}

export class AisHubProvider implements TransportMaritimeProvider {
  public readonly name = 'aishub';

  public async listCivilVessels(): Promise<TransportVesselRecord[]> {
    const enabled = (process.env.ENABLE_AISHUB_AIS || 'true').toLowerCase() !== 'false';
    const username = (process.env.AISHUB_USERNAME || '').trim();
    const apiKey = (process.env.AISHUB_API_KEY || '').trim();
    const baseUrl = (process.env.AISHUB_API_BASE_URL || '').trim();
    if (!enabled || !username || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      if (!url.searchParams.has('username')) url.searchParams.set('username', username);
      if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');
      if (!url.searchParams.has('output')) url.searchParams.set('output', 'json');
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return collectVesselRows(payload)
        .map((row, index) => mapToVesselRecord(row, index, 'aishub'))
        .filter((row): row is TransportVesselRecord => Boolean(row));
    } catch {
      return [];
    }
  }
}

export const DEFAULT_MARITIME_PROVIDERS: TransportMaritimeProvider[] = [
  new MarineTrafficProvider(),
  new AisStreamProvider(),
  new VesselFinderProvider(),
  new AisHubProvider(),
];

export async function listCivilVesselsFromAllProviders(): Promise<TransportVesselRecord[]> {
  const settled = await Promise.allSettled(DEFAULT_MARITIME_PROVIDERS.map((provider) => provider.listCivilVessels()));
  const merged = settled
    .filter((result): result is PromiseFulfilledResult<TransportVesselRecord[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value);
  return dedupeVessels(merged);
}

function getNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getObservedAt(raw: unknown): number {
  const numeric = getNumber(raw);
  if (numeric && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function collectVesselRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const containers = [root.data, root.vessels, root.results];
  for (const container of containers) {
    if (Array.isArray(container)) return container;
  }
  return [];
}

function mapToVesselRecord(
  row: unknown,
  index: number,
  provider: TransportMaritimeProvider['name'] = 'marinetraffic',
): TransportVesselRecord | null {
  if (!row || typeof row !== 'object') return null;
  const source = row as Record<string, unknown>;

  const latitude = getNumber(source.LAT) ?? getNumber(source.lat) ?? getNumber(source.latitude);
  const longitude = getNumber(source.LON) ?? getNumber(source.lon) ?? getNumber(source.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const safeLatitude = Number(latitude);
  const safeLongitude = Number(longitude);

  const mmsi = String(source.MMSI ?? source.mmsi ?? '').trim();
  const name = String(source.SHIPNAME ?? source.shipname ?? source.name ?? '').trim();
  const id = String(source.SHIP_ID ?? source.shipId ?? source.id ?? mmsi ?? name ?? `mt-${index}`).trim();

  return {
    id: id || `mt-${index}`,
    mmsi: mmsi || undefined,
    name: name || mmsi || `Vessel-${index}`,
    location: { latitude: safeLatitude, longitude: safeLongitude },
    shipType: getNumber(source.SHIPTYPE) ?? getNumber(source.shipType),
    heading: getNumber(source.COURSE) ?? getNumber(source.heading),
    speed: getNumber(source.SPEED) ?? getNumber(source.speed),
    provider,
    observedAt: getObservedAt(source.TIMESTAMP ?? source.timestamp ?? source.LAST_POS_TIME),
  };
}

function dedupeVessels(vessels: TransportVesselRecord[]): TransportVesselRecord[] {
  const byId = new Map<string, TransportVesselRecord>();
  for (const vessel of vessels) {
    const identity = vessel.mmsi || vessel.id || vessel.name;
    const key = `${vessel.provider}:${identity}`;
    const prev = byId.get(key);
    if (!prev || vessel.observedAt >= prev.observedAt) byId.set(key, vessel);
  }
  return Array.from(byId.values());
}
