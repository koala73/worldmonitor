import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

const CATEGORY_FILTERS = {
  shelter: ['["amenity"="shelter"]', '["social_facility"="shelter"]', '["emergency"="shelter"]'],
  hospital: ['["amenity"="hospital"]', '["healthcare"="hospital"]'],
  pharmacy: ['["amenity"="pharmacy"]', '["healthcare"="pharmacy"]'],
  fuel: ['["amenity"="fuel"]'],
  water: ['["amenity"="drinking_water"]', '["amenity"="water_point"]', '["man_made"="water_well"]'],
};

function fetchWithTimeout(url, options, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseFloat(value || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseCategories(raw) {
  const requested = (raw || '')
    .split(',')
    .map((category) => category.trim())
    .filter(Boolean);
  const allowed = requested.filter((category) => Object.hasOwn(CATEGORY_FILTERS, category));
  return allowed.length > 0 ? allowed : Object.keys(CATEGORY_FILTERS);
}

function buildCategoryQuery(category, lat, lon, radiusMeters) {
  const filters = CATEGORY_FILTERS[category] || [];
  const clauses = filters.flatMap((filter) => ([
    `node(around:${radiusMeters},${lat},${lon})${filter};`,
    `way(around:${radiusMeters},${lat},${lon})${filter};`,
    `relation(around:${radiusMeters},${lat},${lon})${filter};`,
  ]));
  return `[out:json][timeout:20];(${clauses.join('')});out center tags;`;
}

function fallbackName(category) {
  return {
    shelter: 'Nearby shelter option',
    hospital: 'Nearby hospital',
    pharmacy: 'Nearby pharmacy',
    fuel: 'Nearby fuel stop',
    water: 'Nearby water source',
  }[category] || 'Nearby logistics option';
}

function deriveStatus(tags = {}) {
  const openingHours = String(tags.opening_hours || '');
  if (openingHours.includes('24/7')) return 'open';
  if (openingHours) return 'limited';
  if (tags.emergency === 'yes') return 'open';
  return 'unknown';
}

function deriveHazardCompatibility(category) {
  if (category === 'shelter') return 'evacuation';
  if (category === 'hospital' || category === 'pharmacy') return 'medical';
  if (category === 'fuel' || category === 'water') return 'supply';
  return 'general';
}

function formatAddress(tags = {}) {
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:city'],
    tags['addr:state'],
  ].filter(Boolean);
  return parts.join(' ').trim();
}

function normalizeElement(category, element, lat, lon, fetchedAt) {
  const resolvedLat = typeof element.lat === 'number' ? element.lat : element.center?.lat;
  const resolvedLon = typeof element.lon === 'number' ? element.lon : element.center?.lon;
  if (!Number.isFinite(resolvedLat) || !Number.isFinite(resolvedLon)) return null;

  const tags = element.tags || {};
  const address = formatAddress(tags);
  return {
    id: `${category}:${element.type}:${element.id}`,
    category,
    name: String(tags.name || fallbackName(category)).trim(),
    lat: resolvedLat,
    lon: resolvedLon,
    distanceKm: haversineKm(lat, lon, resolvedLat, resolvedLon),
    source: 'OpenStreetMap / Overpass',
    freshness: 'fresh',
    status: deriveStatus(tags),
    hazardCompatibility: deriveHazardCompatibility(category),
    fetchedAt,
    ...(address ? { address } : {}),
    ...(tags.website ? { url: tags.website } : {}),
  };
}

async function fetchCategoryNodes(category, lat, lon, radiusMeters, limitPerCategory) {
  const query = buildCategoryQuery(category, lat, lon, radiusMeters);
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: query,
      }, 15_000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const fetchedAt = new Date().toISOString();
      return (payload?.elements || [])
        .map((element) => normalizeElement(category, element, lat, lon, fetchedAt))
        .filter(Boolean)
        .sort((left, right) => left.distanceKm - right.distanceKm)
        .slice(0, limitPerCategory);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Overpass fetch failed');
}

export default async function handler(req) {
  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (isDisallowedOrigin(req)) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403, headers: cors });
  }

  const url = new URL(req.url);
  const lat = clampNumber(url.searchParams.get('lat'), -90, 90, Number.NaN);
  const lon = clampNumber(url.searchParams.get('lon'), -180, 180, Number.NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: 'lat and lon are required' }, {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const radiusKm = clampNumber(url.searchParams.get('radiusKm'), 1, 50, 25);
  const limitPerCategory = Math.trunc(clampNumber(url.searchParams.get('limitPerCategory'), 1, 5, 3));
  const categories = parseCategories(url.searchParams.get('categories'));

  const results = await Promise.allSettled(
    categories.map((category) => fetchCategoryNodes(category, lat, lon, Math.round(radiusKm * 1000), limitPerCategory)),
  );

  const nodes = results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);
  const failures = results.filter((result) => result.status === 'rejected');

  if (nodes.length === 0 && failures.length > 0) {
    return Response.json({
      error: 'Local logistics lookup failed',
      categories,
    }, {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  return Response.json({
    categories,
    nodes,
    fetchedAt: new Date().toISOString(),
    partial: failures.length > 0,
  }, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...cors,
    },
  });
}
