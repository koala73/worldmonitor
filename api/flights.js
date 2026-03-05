/**
 * OpenSky Network Proxy — Vercel Serverless Function (Node.js)
 *
 * Proxies live aircraft state vectors from OpenSky for the Gulf/CENTCOM region.
 * Uses Node.js runtime (not Edge) because OpenSky is slow and sometimes
 * rejects connections from Edge/Cloudflare IPs.
 *
 * GET /api/flights?lamin=13&lamax=43&lomin=27&lomax=57
 */

const OPENSKY_API = 'https://opensky-network.org/api/states/all';
const FETCH_TIMEOUT = 25000;

// In-memory cache (persists across warm invocations)
let cache = { data: null, timestamp: 0, key: '' };
const CACHE_TTL = 30_000; // 30 seconds

function getCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.referer || '*';
  const cors = getCorsHeaders(origin);

  // Set CORS headers
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const lamin = parseFloat(req.query.lamin);
  const lamax = parseFloat(req.query.lamax);
  const lomin = parseFloat(req.query.lomin);
  const lomax = parseFloat(req.query.lomax);

  // Validate bounding box
  if ([lamin, lamax, lomin, lomax].some(isNaN)) {
    return res.status(400).json({ error: 'Missing or invalid bounding box params (lamin, lamax, lomin, lomax)' });
  }

  // Sanity check: prevent absurdly large bounding boxes
  if (lamax - lamin > 60 || lomax - lomin > 60) {
    return res.status(400).json({ error: 'Bounding box too large (max 60° span)' });
  }

  // Check cache
  const cacheKey = `${lamin},${lamax},${lomin},${lomax}`;
  if (cache.data && cache.key === cacheKey && Date.now() - cache.timestamp < CACHE_TTL) {
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=15');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cache.data);
  }

  try {
    const openskyUrl = `${OPENSKY_API}?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;

    // Build headers — add auth if credentials are configured
    const headers = { 'Accept': 'application/json', 'User-Agent': 'WorldMonitor/2.5' };
    const clientId = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
    if (clientId && clientSecret) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    let response;
    try {
      response = await fetch(openskyUrl, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'OpenSky rate limited', retryAfter: 60 });
    }

    if (!response.ok) {
      console.error('[flights] OpenSky returned', response.status);
      return res.status(502).json({ error: 'OpenSky upstream error', status: response.status });
    }

    const data = await response.text();

    // Update cache
    cache = { data, timestamp: Date.now(), key: cacheKey };

    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=15');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(data);
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    console.error('[flights] Error:', error.message);
    return res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'OpenSky timeout' : 'Failed to fetch flight data',
      details: error.message,
    });
  }
}

// Vercel Serverless Function config — 30s max duration
export const config = {
  maxDuration: 30,
};
