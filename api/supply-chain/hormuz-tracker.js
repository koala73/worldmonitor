import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { jsonResponse } from '../_json-response.js';
import { readJsonFromUpstash } from '../_upstash-json.js';

export const config = { runtime: 'edge' };

const REDIS_KEY = 'supply_chain:hormuz_tracker:v1';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 1_800_000; // 30 min

let negUntil = 0;
const NEG_TTL = 60_000;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function namedDateParts(text) {
  let m = text.match(/^(\d{4})-([A-Za-z]+)-(\d{1,2})$/);
  if (m) return { year: m[1], monthName: m[2], day: m[3] };
  m = text.match(/^([A-Za-z]+)-(\d{1,2})-(\d{4})$/);
  if (m) return { year: m[3], monthName: m[1], day: m[2] };
  return null;
}

function isoDate(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parts = namedDateParts(text);
  if (!parts) return null;
  const month = MONTH_NAMES.indexOf(parts.monthName.toLowerCase());
  const day = Number(parts.day);
  const date = new Date(Date.UTC(Number(parts.year), month, day));
  if (month < 0 || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

// Payloads seeded before the ISO fix carry 'October-31-2026' and
// '2026-October-31' dates in month-name order. Serve them as ISO, oldest
// first, until the next seed run overwrites the key.
function withIsoSeries(data) {
  if (!Array.isArray(data?.charts)) return data;
  return {
    ...data,
    charts: data.charts.map((chart) => ({
      ...chart,
      series: (Array.isArray(chart?.series) ? chart.series : [])
        .map((point) => ({ ...point, date: isoDate(point?.date) }))
        .filter((point) => point.date)
        .sort((a, b) => a.date.localeCompare(b.date)),
    })),
  };
}

async function fetchData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) return null;
  let data;
  // Seeder-owned key (#7674): scripts/seed-hormuz.mjs publishes it bare —
  // read raw in every environment so preview sees the fleet row.
  try { data = await readJsonFromUpstash(REDIS_KEY, 3_000, true); } catch { data = null; }
  if (!data) {
    negUntil = now + NEG_TTL;
    return null;
  }
  cached = withIsoSeries(data);
  cachedAt = now;
  return cached;
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }
  const data = await fetchData();
  if (!data) {
    return jsonResponse({ error: 'Hormuz tracker data temporarily unavailable' }, 503, {
      'Cache-Control': 'no-cache, no-store', ...corsHeaders,
    });
  }
  return jsonResponse(data, 200, {
    'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600, stale-if-error=7200',
    ...corsHeaders,
  });
}
