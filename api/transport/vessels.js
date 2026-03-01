import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';

export const config = { runtime: 'edge' };

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

function collectRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [payload.data, payload.vessels, payload.results];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function mapVessel(row, index, provider) {
  if (!row || typeof row !== 'object') return null;
  const lat = toNumber(row.LAT ?? row.lat ?? row.latitude);
  const lon = toNumber(row.LON ?? row.lon ?? row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const mmsi = String(row.MMSI ?? row.mmsi ?? '').trim();
  const name = String(row.SHIPNAME ?? row.shipname ?? row.name ?? '').trim();
  const id = String(row.SHIP_ID ?? row.shipId ?? row.id ?? mmsi ?? name ?? `${provider}-${index}`).trim();

  return {
    id: id || `${provider}-${index}`,
    mmsi: mmsi || undefined,
    name: name || mmsi || `${provider}-${index}`,
    provider,
    location: { latitude: lat, longitude: lon },
    shipType: toNumber(row.SHIPTYPE ?? row.shipType),
    heading: toNumber(row.COURSE ?? row.heading),
    speed: toNumber(row.SPEED ?? row.speed),
    observedAt: observedAtMs(row.TIMESTAMP ?? row.timestamp ?? row.LAST_POS_TIME),
  };
}

async function fetchMarineTraffic() {
  const enabled = (process.env.ENABLE_MARINETRAFFIC || 'false').toLowerCase() !== 'false';
  const apiKey = (process.env.MARINETRAFFIC_API_KEY || '').trim();
  const baseUrl = (process.env.MARINETRAFFIC_API_BASE_URL || '').trim();
  if (!enabled || !apiKey || !baseUrl) return [];

  const url = new URL(baseUrl);
  if (!url.searchParams.has('api_key')) url.searchParams.set('api_key', apiKey);
  if (!url.searchParams.has('protocol')) url.searchParams.set('protocol', 'jsono');

  const t = withTimeout(12000);
  try {
    const resp = await fetch(url.toString(), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey },
      signal: t.signal,
    });
    if (!resp.ok) return [];
    const payload = await resp.json();
    return collectRows(payload).map((row, i) => mapVessel(row, i, 'marinetraffic')).filter(Boolean);
  } catch {
    return [];
  } finally {
    t.done();
  }
}

async function fetchVesselFinder() {
  const enabled = (process.env.ENABLE_VESSELFINDER_AIS || 'true').toLowerCase() !== 'false';
  const apiKey = (process.env.VESSELFINDER_API_KEY || '').trim();
  const baseUrl = (process.env.VESSELFINDER_API_BASE_URL || '').trim();
  if (!enabled || !apiKey || !baseUrl) return [];

  const url = new URL(baseUrl);
  if (!url.searchParams.has('api_key')) url.searchParams.set('api_key', apiKey);

  const t = withTimeout(12000);
  try {
    const resp = await fetch(url.toString(), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey },
      signal: t.signal,
    });
    if (!resp.ok) return [];
    const payload = await resp.json();
    return collectRows(payload).map((row, i) => mapVessel(row, i, 'vesselfinder')).filter(Boolean);
  } catch {
    return [];
  } finally {
    t.done();
  }
}

async function fetchAisStreamRelay() {
  const enabled = (process.env.ENABLE_AISSTREAM_AIS || 'true').toLowerCase() !== 'false';
  const relayBaseUrl = getRelayBaseUrl();
  if (!enabled || !relayBaseUrl) return [];

  const t = withTimeout(12000);
  try {
    const resp = await fetch(`${relayBaseUrl}/ais/snapshot?vessels=true`, {
      headers: getRelayHeaders({ Accept: 'application/json' }),
      signal: t.signal,
    });
    if (!resp.ok) return [];
    const payload = await resp.json();
    const relayRows = Array.isArray(payload?.vessels)
      ? payload.vessels
      : Array.isArray(payload?.candidateReports)
      ? payload.candidateReports
      : [];
    return relayRows.map((row, i) => mapVessel(row, i, 'aisstream')).filter(Boolean);
  } catch {
    return [];
  } finally {
    t.done();
  }
}

function dedupeVessels(vessels) {
  const byKey = new Map();
  for (const vessel of vessels) {
    const identity = vessel.mmsi || vessel.id || vessel.name;
    const key = `${vessel.provider}:${identity}`;
    const prev = byKey.get(key);
    if (!prev || (vessel.observedAt || 0) >= (prev.observedAt || 0)) byKey.set(key, vessel);
  }
  return Array.from(byKey.values());
}

async function checkRelayReachable(relayBaseUrl) {
  if (!relayBaseUrl) return false;
  const t = withTimeout(3000);
  try {
    const resp = await fetch(`${relayBaseUrl}/health`, {
      headers: getRelayHeaders({ Accept: 'application/json' }),
      signal: t.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    t.done();
  }
}

async function getProviderStatus() {
  const relayBaseUrl = getRelayBaseUrl();
  const relayReachable = relayBaseUrl ? await checkRelayReachable(relayBaseUrl) : false;
  return {
    aisstream: {
      enabled: (process.env.ENABLE_AISSTREAM_AIS || 'true').toLowerCase() !== 'false',
      configured: Boolean((process.env.AISSTREAM_API_KEY || '').trim()),
      relayConfigured: Boolean(relayBaseUrl),
      relayReachable,
    },
    marinetraffic: {
      enabled: (process.env.ENABLE_MARINETRAFFIC || 'false').toLowerCase() !== 'false',
      configured: Boolean((process.env.MARINETRAFFIC_API_KEY || '').trim() && (process.env.MARINETRAFFIC_API_BASE_URL || '').trim()),
    },
    vesselfinder: {
      enabled: (process.env.ENABLE_VESSELFINDER_AIS || 'false').toLowerCase() !== 'false',
      configured: Boolean((process.env.VESSELFINDER_API_KEY || '').trim() && (process.env.VESSELFINDER_API_BASE_URL || '').trim()),
    },
  };
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

  try {
    const [aisstream, marineTraffic, vesselFinder] = await Promise.all([
      fetchAisStreamRelay(),
      fetchMarineTraffic(),
      fetchVesselFinder(),
    ]);

    const vessels = dedupeVessels([...aisstream, ...marineTraffic, ...vesselFinder]);
    return new Response(JSON.stringify({
      timestamp: new Date().toISOString(),
      count: vessels.length,
      providers: {
        aisstream: aisstream.length,
        marinetraffic: marineTraffic.length,
        vesselfinder: vesselFinder.length,
      },
      providerStatus: await getProviderStatus(),
      vessels,
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
      error: 'Transport vessel query failed',
      details: error?.message || String(error),
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
