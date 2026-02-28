/**
 * OpenSens — shared Edge-cache helper.
 * Wraps responses with standardised Cache-Control headers and
 * an X-OpenSens-Meta header for transparency.
 */

/**
 * @param {Response} response
 * @param {object} opts
 * @param {number} opts.ttl           s-maxage in seconds
 * @param {number} [opts.swr]         stale-while-revalidate in seconds (default ttl/2)
 * @param {string} opts.source        upstream source label
 * @param {string} [opts.confidence]  'low'|'medium'|'high'
 * @param {string[]} [opts.warnings]
 * @returns {Response}
 */
export function withCache(response, { ttl, swr, source, confidence = 'medium', warnings = [] }) {
  const headers = new Headers(response.headers);
  const revalidate = swr ?? Math.floor(ttl / 2);
  headers.set('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=${revalidate}`);
  headers.set('X-OpenSens-Source', source);
  headers.set('X-OpenSens-Confidence', confidence);
  headers.set('X-OpenSens-CachedAt', new Date().toISOString());
  if (warnings.length) headers.set('X-OpenSens-Warnings', warnings.join('; '));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Build a coarse bucket key from lat/lon at ~0.1° resolution (~11 km).
 * Used for PVGIS cache keying to avoid re-fetching nearly identical locations.
 */
export function coarseBucket(lat, lon, precision = 1) {
  const factor = Math.pow(10, precision);
  const bLat = (Math.round(lat * factor) / factor).toFixed(precision);
  const bLon = (Math.round(lon * factor) / factor).toFixed(precision);
  return `${bLat},${bLon}`;
}

/**
 * Validate lat/lon parameters from a URL search params object.
 * Returns { lat, lon } or throws a descriptive Error.
 */
export function parseLatLon(searchParams) {
  const latRaw = searchParams.get('lat');
  const lonRaw = searchParams.get('lon');
  if (!latRaw || !lonRaw) throw new Error('lat and lon are required query parameters');
  const lat = parseFloat(latRaw);
  const lon = parseFloat(lonRaw);
  if (isNaN(lat) || lat < -90 || lat > 90) throw new Error('lat must be a number between -90 and 90');
  if (isNaN(lon) || lon < -180 || lon > 180) throw new Error('lon must be a number between -180 and 180');
  return { lat, lon };
}

/**
 * Haversine distance in metres between two WGS-84 points.
 */
export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Percentile helper over a numeric array (linear interpolation).
 */
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Fetch with a timeout; throws AbortError on expiry.
 */
export async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Standard JSON error response.
 */
export function jsonError(message, status, corsHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
