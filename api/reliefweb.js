import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson, setCachedJson } from './_upstash-cache.js';

export const config = { runtime: 'edge' };

const CACHE_KEY = 'reliefweb-reports-v1';
const CACHE_TTL = 900; // 15 minutes
const API_URL = 'https://api.reliefweb.int/v1/reports?appname=worldmonitor';

/**
 * ReliefWeb Crisis Reports API
 *
 * Fetches recent humanitarian crisis reports from the UN OCHA ReliefWeb API.
 * Returns geocoded reports with disaster type, source, and country coordinates.
 * Cached for 15 minutes via Upstash Redis.
 */
export default async function handler(req) {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    // Check cache
    const cached = await getCachedJson(CACHE_KEY);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...cors,
          'Cache-Control': 'public, max-age=120, s-maxage=900, stale-while-revalidate=120',
        },
      });
    }

    // Fetch from ReliefWeb API
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const body = {
      filter: {
        operator: 'AND',
        conditions: [
          { field: 'date.created', value: { from: thirtyDaysAgo } },
        ],
      },
      fields: {
        include: ['title', 'date.created', 'country', 'disaster', 'source', 'url'],
      },
      sort: ['date.created:desc'],
      limit: 100,
    };

    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `ReliefWeb API: ${resp.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const data = await resp.json();
    const reports = parseReports(data);

    const result = {
      generatedAt: new Date().toISOString(),
      reports,
    };

    // Cache the result
    await setCachedJson(CACHE_KEY, result, CACHE_TTL).catch(() => {});

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
        'Cache-Control': 'public, max-age=120, s-maxage=900, stale-while-revalidate=120',
      },
    });
  } catch (error) {
    console.error('[reliefweb] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}

// ── Report parsing ──

function parseReports(data) {
  const reports = [];
  const items = data?.data || [];

  for (const item of items) {
    const fields = item.fields || {};
    const title = fields.title || '';
    const date = fields.date?.created || '';
    const url = fields.url || '';
    const id = String(item.id || '');

    // Get first country with coordinates
    const countries = fields.country || [];
    const country = countries[0];
    if (!country) continue;

    const lat = country.location?.lat;
    const lon = country.location?.lon;
    if (lat == null || lon == null) continue;

    const countryName = country.name || '';

    // Get disaster type (first if available)
    const disasters = fields.disaster || [];
    const disasterType = disasters[0]?.type?.[0]?.name || '';

    // Get source (first if available)
    const sources = fields.source || [];
    const sourceName = sources[0]?.name || '';

    reports.push({
      id,
      title: title.slice(0, 200),
      date,
      country: countryName,
      lat,
      lon,
      disasterType: disasterType.slice(0, 60),
      source: sourceName.slice(0, 80),
      url,
    });
  }

  return reports;
}

// ── Test helpers (named exports for unit tests) ──
export function __testParseReports(data) {
  return parseReports(data);
}
