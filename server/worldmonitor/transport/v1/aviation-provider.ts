import type { FlightQueryBounds, TransportFlightRecord } from './types';

declare const process: { env: Record<string, string | undefined> };

export interface TransportAviationProvider {
  name: 'fr24' | 'opensky' | 'airlabs' | 'aviationstack' | 'aerodatabox' | 'flightaware';
  listCivilFlights(bounds: FlightQueryBounds): Promise<TransportFlightRecord[]>;
}

export class Fr24Provider implements TransportAviationProvider {
  public readonly name = 'fr24';

  public async listCivilFlights(bounds: FlightQueryBounds): Promise<TransportFlightRecord[]> {
    const enabled = (process.env.ENABLE_FR24 || 'true').toLowerCase() !== 'false';
    const apiKey = (process.env.FR24_API_KEY || '').trim();
    const baseUrl = (process.env.FR24_API_BASE_URL || '').trim();
    const apiVersion = (process.env.FR24_API_VERSION || 'v1').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('neLat', String(bounds.neLat));
      url.searchParams.set('neLon', String(bounds.neLon));
      url.searchParams.set('swLat', String(bounds.swLat));
      url.searchParams.set('swLon', String(bounds.swLon));
      url.searchParams.set('bounds', `${bounds.neLat},${bounds.swLat},${bounds.swLon},${bounds.neLon}`);

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'Accept-Version': apiVersion,
          Authorization: `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return [];
      const payload = await response.json();

      return collectFlightRows(payload)
        .map((row, index) => mapToCivilFlight(row, index))
        .filter((flight): flight is TransportFlightRecord => Boolean(flight));
    } catch {
      return [];
    }
  }
}

export class OpenSkyTransportProvider implements TransportAviationProvider {
  public readonly name = 'opensky';

  public async listCivilFlights(bounds: FlightQueryBounds): Promise<TransportFlightRecord[]> {
    const enabled = (process.env.ENABLE_OPENSKY_ADSB || 'true').toLowerCase() !== 'false';
    if (!enabled) return [];

    const clientId = (process.env.OPENSKY_CLIENT_ID || '').trim();
    const clientSecret = (process.env.OPENSKY_CLIENT_SECRET || '').trim();
    const baseUrl = (process.env.OPENSKY_API_BASE_URL || 'https://opensky-network.org/api/states/all').trim();

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('lamin', String(Math.min(bounds.swLat, bounds.neLat)));
      url.searchParams.set('lamax', String(Math.max(bounds.swLat, bounds.neLat)));
      url.searchParams.set('lomin', String(Math.min(bounds.swLon, bounds.neLon)));
      url.searchParams.set('lomax', String(Math.max(bounds.swLon, bounds.neLon)));

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (clientId && clientSecret) {
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        headers.Authorization = `Basic ${basic}`;
      }

      const response = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];

      const payload = await response.json() as { states?: unknown[] };
      const rows = Array.isArray(payload.states) ? payload.states : [];
      return rows
        .map((row, index) => mapToCivilFlight(row, index, 'opensky'))
        .filter((flight): flight is TransportFlightRecord => Boolean(flight));
    } catch {
      return [];
    }
  }
}

export class AirLabsProvider implements TransportAviationProvider {
  public readonly name = 'airlabs';

  public async listCivilFlights(bounds: FlightQueryBounds): Promise<TransportFlightRecord[]> {
    const enabled = (process.env.ENABLE_AIRLABS_ADSB || 'true').toLowerCase() !== 'false';
    const apiKey = (process.env.AIRLABS_API_KEY || '').trim();
    const baseUrl = (process.env.AIRLABS_API_BASE_URL || '').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('bbox', `${bounds.neLat},${bounds.swLat},${bounds.swLon},${bounds.neLon}`);
      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return collectFlightRows(payload)
        .map((row, index) => mapToCivilFlight(row, index, 'airlabs'))
        .filter((flight): flight is TransportFlightRecord => Boolean(flight));
    } catch {
      return [];
    }
  }
}

export class AviationStackAdsbProvider implements TransportAviationProvider {
  public readonly name = 'aviationstack';

  public async listCivilFlights(bounds: FlightQueryBounds): Promise<TransportFlightRecord[]> {
    const enabled = (process.env.ENABLE_AVIATIONSTACK_ADSB || 'true').toLowerCase() !== 'false';
    const apiKey = (process.env.AVIATIONSTACK_ADSB_API_KEY || '').trim();
    const baseUrl = (process.env.AVIATIONSTACK_ADSB_API_BASE_URL || '').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('access_key', apiKey);
      url.searchParams.set('bbox', `${bounds.neLat},${bounds.swLat},${bounds.swLon},${bounds.neLon}`);
      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return collectFlightRows(payload)
        .map((row, index) => mapToCivilFlight(row, index, 'aviationstack'))
        .filter((flight): flight is TransportFlightRecord => Boolean(flight));
    } catch {
      return [];
    }
  }
}

export class AeroDataBoxProvider implements TransportAviationProvider {
  public readonly name = 'aerodatabox';

  public async listCivilFlights(bounds: FlightQueryBounds): Promise<TransportFlightRecord[]> {
    const enabled = (process.env.ENABLE_AERODATABOX_ADSB || 'true').toLowerCase() !== 'false';
    const apiKey = (process.env.AERODATABOX_API_KEY || '').trim();
    const baseUrl = (process.env.AERODATABOX_API_BASE_URL || '').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('bbox', `${bounds.neLat},${bounds.swLat},${bounds.swLon},${bounds.neLon}`);
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-RapidAPI-Key': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return collectFlightRows(payload)
        .map((row, index) => mapToCivilFlight(row, index, 'aerodatabox'))
        .filter((flight): flight is TransportFlightRecord => Boolean(flight));
    } catch {
      return [];
    }
  }
}

export class FlightAwareProvider implements TransportAviationProvider {
  public readonly name = 'flightaware';

  public async listCivilFlights(bounds: FlightQueryBounds): Promise<TransportFlightRecord[]> {
    const enabled = (process.env.ENABLE_FLIGHTAWARE_ADSB || 'true').toLowerCase() !== 'false';
    const apiKey = (process.env.FLIGHTAWARE_API_KEY || '').trim();
    const baseUrl = (process.env.FLIGHTAWARE_API_BASE_URL || '').trim();
    if (!enabled || !apiKey || !baseUrl) return [];

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('bbox', `${bounds.neLat},${bounds.swLat},${bounds.swLon},${bounds.neLon}`);
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'x-apikey': apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return collectFlightRows(payload)
        .map((row, index) => mapToCivilFlight(row, index, 'flightaware'))
        .filter((flight): flight is TransportFlightRecord => Boolean(flight));
    } catch {
      return [];
    }
  }
}

export const DEFAULT_AVIATION_PROVIDERS: TransportAviationProvider[] = [
  new Fr24Provider(),
  new OpenSkyTransportProvider(),
  new AirLabsProvider(),
  new AviationStackAdsbProvider(),
  new AeroDataBoxProvider(),
  new FlightAwareProvider(),
];

export async function listCivilFlightsFromAllProviders(
  bounds: FlightQueryBounds,
): Promise<TransportFlightRecord[]> {
  const settled = await Promise.allSettled(DEFAULT_AVIATION_PROVIDERS.map((provider) => provider.listCivilFlights(bounds)));
  const merged = settled
    .filter((result): result is PromiseFulfilledResult<TransportFlightRecord[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value);
  return dedupeFlights(merged);
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

function collectFlightRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as Record<string, unknown>;
  const containers = [root.flights, root.aircraft, root.results, root.data];
  for (const item of containers) {
    if (Array.isArray(item)) return item;
    if (item && typeof item === 'object') {
      const values = Object.values(item as Record<string, unknown>);
      if (values.every((v) => v && typeof v === 'object')) return values;
    }
  }
  return [];
}

function mapToCivilFlight(
  row: unknown,
  index: number,
  provider: TransportAviationProvider['name'] = 'fr24',
): TransportFlightRecord | null {
  if (Array.isArray(row)) {
    const lat = getNumber(row[1]) ?? getNumber(row[2]);
    const lon = getNumber(row[2]) ?? getNumber(row[3]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const latitude = Number(lat);
    const longitude = Number(lon);

    const callsign = String(row[0] ?? '').trim();
    const id = String(row[8] ?? row[0] ?? `fr24-${index}`).trim();

    return {
      id: id || `fr24-${index}`,
      callsign: callsign || id || `FR24-${index}`,
      location: { latitude, longitude },
      altitude: getNumber(row[4]),
      heading: getNumber(row[3]),
      speed: getNumber(row[5]),
      provider,
      observedAt: getObservedAt(row[10]),
    };
  }

  if (!row || typeof row !== 'object') return null;
  const source = row as Record<string, unknown>;

  const latitude = getNumber(source.lat) ?? getNumber(source.latitude) ?? getNumber((source.position as Record<string, unknown> | undefined)?.latitude);
  const longitude = getNumber(source.lon) ?? getNumber(source.lng) ?? getNumber(source.longitude) ?? getNumber((source.position as Record<string, unknown> | undefined)?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const safeLatitude = Number(latitude);
  const safeLongitude = Number(longitude);

  const callsign = String(
    source.callsign
    ?? source.flight
    ?? source.flightNumber
    ?? source.cs
    ?? (source.identification as Record<string, unknown> | undefined)?.callsign
    ?? '',
  ).trim();
  const id = String(source.id ?? source.hex ?? source.icao24 ?? source.flight_id ?? callsign ?? `fr24-${index}`).trim();

  return {
    id: id || `fr24-${index}`,
    callsign: callsign || id || `FR24-${index}`,
    location: { latitude: safeLatitude, longitude: safeLongitude },
    altitude: getNumber(source.altitude) ?? getNumber(source.alt_baro) ?? getNumber(source.alt),
    heading: getNumber(source.heading) ?? getNumber(source.track),
    speed: getNumber(source.speed) ?? getNumber(source.gs) ?? getNumber(source.gspeed),
    provider,
    observedAt: getObservedAt(source.observedAt ?? source.timestamp ?? source.lastSeen),
  };
}

function dedupeFlights(flights: TransportFlightRecord[]): TransportFlightRecord[] {
  const byId = new Map<string, TransportFlightRecord>();
  for (const flight of flights) {
    const key = `${flight.provider}:${flight.id || flight.callsign}`;
    const prev = byId.get(key);
    if (!prev || flight.observedAt >= prev.observedAt) byId.set(key, flight);
  }
  return Array.from(byId.values());
}
