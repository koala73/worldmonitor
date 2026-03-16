import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const CIP_ITEM_ID = '204a59b01f4443cd96718796fd102c00';
const ARCGIS_ITEM_DATA_URL = `https://www.arcgis.com/sharing/rest/content/items/${CIP_ITEM_ID}/data?f=json`;
const UA = 'Mozilla/5.0 (compatible; WorldMonitor/1.0)';
const MAX_FEATURES = 2000;

// In-memory cache (per-isolate, Vercel Edge)
let cached = null;
let cachedAt = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Discover feature layer URLs from the S2 Underground CIP web map definition.
 * Returns an array of { url, title } objects for point feature layers.
 */
async function discoverFeatureLayers() {
  const resp = await fetch(ARCGIS_ITEM_DATA_URL, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`ArcGIS item data HTTP ${resp.status}`);
  const webMap = await resp.json();

  const layers = [];
  const seen = new Set();

  function walk(items) {
    if (!Array.isArray(items)) return;
    for (const layer of items) {
      if (layer.layers) walk(layer.layers);
      if (layer.featureCollection?.layers) walk(layer.featureCollection.layers);
      const url = layer.url;
      if (url && !seen.has(url)) {
        seen.add(url);
        layers.push({ url, title: layer.title || '' });
      }
    }
  }

  walk(webMap.operationalLayers);
  return layers;
}

/**
 * Query a single ArcGIS Feature Service layer for GeoJSON point features.
 */
async function queryLayer(url, title) {
  const queryUrl = `${url}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&resultRecordCount=${MAX_FEATURES}`;
  const resp = await fetch(queryUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) return [];

  const geojson = await resp.json();
  if (!geojson.features || !Array.isArray(geojson.features)) return [];

  return geojson.features
    .filter(f => f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates))
    .map(f => {
      const [lon, lat] = f.geometry.coordinates;
      const props = f.properties || {};
      return {
        lon,
        lat,
        layerTitle: title,
        name: props.Name || props.name || props.LABEL || props.title || '',
        description: props.Description || props.description || props.snippet || props.notes || '',
        eventType: props.Event_Type || props.event_type || props.type || props.Type || title || '',
        date: props.Date || props.date || props.event_date || props.EditDate || '',
        popupInfo: props.PopupInfo || '',
      };
    })
    .filter(e => !isNaN(e.lat) && !isNaN(e.lon));
}

/**
 * Fetch and aggregate features from all discovered S2 Underground CIP layers.
 */
async function fetchS2UndergroundData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;

  const layers = await discoverFeatureLayers();
  if (layers.length === 0) {
    throw new Error('No feature layers found in S2 Underground CIP web map');
  }

  // Query layers in parallel (limit concurrency to 6)
  const CONCURRENCY = 6;
  const allEvents = [];

  for (let i = 0; i < layers.length; i += CONCURRENCY) {
    const batch = layers.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(l => queryLayer(l.url, l.title)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allEvents.push(...result.value);
      }
    }
  }

  const result = {
    source: 's2underground',
    fetchedAt: new Date().toISOString(),
    layerCount: layers.length,
    eventCount: allEvents.length,
    events: allEvents,
  };

  cached = result;
  cachedAt = now;
  return result;
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const data = await fetchS2UndergroundData();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=900, stale-while-revalidate=600',
        ...corsHeaders,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'S2 Underground fetch failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
