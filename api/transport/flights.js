import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';

export const config = { runtime: 'edge' };

function parseNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseBounds(url) {
  const neLat = parseNumber(url.searchParams.get('neLat'));
  const neLon = parseNumber(url.searchParams.get('neLon'));
  const swLat = parseNumber(url.searchParams.get('swLat'));
  const swLon = parseNumber(url.searchParams.get('swLon'));
  if ([neLat, neLon, swLat, swLon].every((v) => Number.isFinite(v))) {
    return { neLat, neLon, swLat, swLon };
  }
  return null;
}

function withTimeout(ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function getRelayBaseUrl() {
  const relayUrl = (process.env.WS_RELAY_URL || process.env.VITE_WS_RELAY_URL || 'ws://localhost:3004').trim();
  if (!relayUrl) return null;
  return relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
}

function getRelayHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  const relaySecret = (process.env.RELAY_SHARED_SECRET || '').trim();
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function observedAtMs(value) {
  const numeric = toNumber(value);
  if (numeric && numeric > 0) return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function mapFlightRow(row, index, provider) {
  if (Array.isArray(row)) {
    // OpenSky state vector shape:
    // [0]=icao24 [1]=callsign [5]=lon [6]=lat [7]=baro_alt [9]=velocity [10]=track [4]=last_contact
    const lat = toNumber(row[6]);
    const lon = toNumber(row[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const callsign = String(row[1] || row[0] || '').trim();
    const id = String(row[0] || `${provider}-${index}`).trim();
    return {
      id: id || `${provider}-${index}`,
      callsign: callsign || id || `${provider}-${index}`,
      provider,
      location: { latitude: lat, longitude: lon },
      altitude: toNumber(row[7]),
      heading: toNumber(row[10]),
      speed: toNumber(row[9]),
      observedAt: observedAtMs(row[4]),
    };
  }

  if (!row || typeof row !== 'object') return null;
  const source = row;
  const position = source.position && typeof source.position === 'object' ? source.position : {};
  const latitude = toNumber(source.lat) ?? toNumber(source.latitude) ?? toNumber(position.latitude);
  const longitude = toNumber(source.lon) ?? toNumber(source.lng) ?? toNumber(source.longitude) ?? toNumber(position.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const callsign = String(source.callsign ?? source.flight ?? source.flightNumber ?? source.cs ?? '').trim();
  const id = String(source.id ?? source.hex ?? source.icao24 ?? source.flight_id ?? callsign ?? `${provider}-${index}`).trim();
  return {
    id: id || `${provider}-${index}`,
    callsign: callsign || id || `${provider}-${index}`,
    provider,
    location: { latitude, longitude },
    altitude: toNumber(source.altitude) ?? toNumber(source.alt_baro) ?? toNumber(source.alt),
    heading: toNumber(source.heading) ?? toNumber(source.track),
    speed: toNumber(source.speed) ?? toNumber(source.gs) ?? toNumber(source.gspeed),
    observedAt: observedAtMs(source.observedAt ?? source.timestamp ?? source.lastSeen),
  };
}

function collectRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const containers = [payload.flights, payload.aircraft, payload.results, payload.data, payload.states];
  for (const c of containers) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === 'object') {
      const values = Object.values(c);
      if (values.every((v) => v && typeof v === 'object')) return values;
    }
  }
  return [];
}

async function fetchFr24(bounds) {
  const enabled = (process.env.ENABLE_FR24 || 'true').toLowerCase() !== 'false';
  const apiKey = (process.env.FR24_API_KEY || '').trim();
  const baseUrl = (process.env.FR24_API_BASE_URL || '').trim();
  const apiVersion = (process.env.FR24_API_VERSION || 'v1').trim();
  if (!enabled || !apiKey || !baseUrl) return [];

  const url = new URL(baseUrl);
  url.searchParams.set('neLat', String(bounds.neLat));
  url.searchParams.set('neLon', String(bounds.neLon));
  url.searchParams.set('swLat', String(bounds.swLat));
  url.searchParams.set('swLon', String(bounds.swLon));
  url.searchParams.set('bounds', `${bounds.neLat},${bounds.swLat},${bounds.swLon},${bounds.neLon}`);

  const t = withTimeout(12000);
  try {
    const resp = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Version': apiVersion,
        Authorization: `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
      },
      signal: t.signal,
    });
    if (!resp.ok) return [];
    const payload = await resp.json();
    return collectRows(payload)
      .map((row, i) => mapFlightRow(row, i, 'fr24'))
      .filter(Boolean);
  } finally {
    t.done();
  }
}

async function fetchOpenSky(bounds) {
  const enabled = (process.env.ENABLE_OPENSKY_ADSB || 'true').toLowerCase() !== 'false';
  if (!enabled) return [];

  const directBaseUrl = (process.env.OPENSKY_API_BASE_URL || 'https://opensky-network.org/api/states/all').trim();
  const clientId = (process.env.OPENSKY_CLIENT_ID || '').trim();
  const clientSecret = (process.env.OPENSKY_CLIENT_SECRET || '').trim();

  const lamin = String(Math.min(bounds.swLat, bounds.neLat));
  const lamax = String(Math.max(bounds.swLat, bounds.neLat));
  const lomin = String(Math.min(bounds.swLon, bounds.neLon));
  const lomax = String(Math.max(bounds.swLon, bounds.neLon));
  const headers = { Accept: 'application/json' };
  if (clientId && clientSecret) {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  }

  // Prefer local relay first (handles OpenSky OAuth + rate limits better).
  const relayBaseUrl = getRelayBaseUrl();
  if (relayBaseUrl) {
    const relayUrl = new URL(`${relayBaseUrl}/opensky/states/all`);
    relayUrl.searchParams.set('lamin', lamin);
    relayUrl.searchParams.set('lamax', lamax);
    relayUrl.searchParams.set('lomin', lomin);
    relayUrl.searchParams.set('lomax', lomax);
    const relayTimeout = withTimeout(12000);
    try {
      const relayResp = await fetch(relayUrl.toString(), {
        headers: getRelayHeaders({ Accept: 'application/json' }),
        signal: relayTimeout.signal,
      });
      if (relayResp.ok) {
        const relayPayload = await relayResp.json();
        const relayRows = collectRows(relayPayload);
        const mapped = relayRows.map((row, i) => mapFlightRow(row, i, 'opensky')).filter(Boolean);
        if (mapped.length > 0) return mapped;
      }
    } catch {
      // Fall through to direct OpenSky request.
    } finally {
      relayTimeout.done();
    }
  }

  const url = new URL(directBaseUrl);
  url.searchParams.set('lamin', lamin);
  url.searchParams.set('lamax', lamax);
  url.searchParams.set('lomin', lomin);
  url.searchParams.set('lomax', lomax);

  const t = withTimeout(12000);
  try {
    const resp = await fetch(url.toString(), { headers, signal: t.signal });
    if (!resp.ok) return [];
    const payload = await resp.json();
    return collectRows(payload)
      .map((row, i) => mapFlightRow(row, i, 'opensky'))
      .filter(Boolean);
  } finally {
    t.done();
  }
}

function getProviderStatus() {
  const fr24Enabled = (process.env.ENABLE_FR24 || 'true').toLowerCase() !== 'false';
  const fr24Configured = Boolean((process.env.FR24_API_KEY || '').trim() && (process.env.FR24_API_BASE_URL || '').trim());
  const openskyEnabled = (process.env.ENABLE_OPENSKY_ADSB || 'true').toLowerCase() !== 'false';
  const openskyAuthConfigured = Boolean((process.env.OPENSKY_CLIENT_ID || '').trim() && (process.env.OPENSKY_CLIENT_SECRET || '').trim());

  return {
    fr24: {
      enabled: fr24Enabled,
      configured: fr24Configured,
    },
    opensky: {
      enabled: openskyEnabled,
      authConfigured: openskyAuthConfigured,
      mode: openskyAuthConfigured ? 'authenticated' : 'anonymous',
    },
  };
}

function dedupeFlights(flights) {
  const byKey = new Map();
  const providerPriority = { opensky: 2, fr24: 1 };
  for (const flight of flights) {
    const id = String(flight.id || '').trim().toLowerCase();
    const callsign = String(flight.callsign || '').trim().toUpperCase().replace(/\s+/g, '');
    const lat = Number.isFinite(flight?.location?.latitude) ? flight.location.latitude : 0;
    const lon = Number.isFinite(flight?.location?.longitude) ? flight.location.longitude : 0;
    const key = id
      ? `id:${id}`
      : callsign
      ? `cs:${callsign}`
      : `geo:${lat.toFixed(2)},${lon.toFixed(2)}`;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, flight);
      continue;
    }

    const currPriority = providerPriority[flight.provider] || 0;
    const prevPriority = providerPriority[prev.provider] || 0;
    if (currPriority > prevPriority) {
      byKey.set(key, flight);
      continue;
    }
    if (currPriority === prevPriority && (flight.observedAt || 0) >= (prev.observedAt || 0)) {
      byKey.set(key, flight);
    }
  }
  return Array.from(byKey.values());
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const requestUrl = new URL(req.url);
  const bounds = parseBounds(requestUrl);
  if (!bounds) {
    return new Response(JSON.stringify({ error: 'Missing bounds: neLat, neLon, swLat, swLon' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const [fr24, opensky] = await Promise.all([
      fetchFr24(bounds),
      fetchOpenSky(bounds),
    ]);

    const flights = dedupeFlights([...fr24, ...opensky]);
    return new Response(JSON.stringify({
      timestamp: new Date().toISOString(),
      count: flights.length,
      providers: {
        fr24: fr24.length,
        opensky: opensky.length,
      },
      providerStatus: getProviderStatus(),
      flights,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        ...corsHeaders,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Transport flight query failed',
      details: error?.message || String(error),
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
