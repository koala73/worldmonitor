import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const BASE_URL = 'https://gpsjam.org/data';
const UA = 'Mozilla/5.0 (compatible; WorldMonitor/1.0)';
const MIN_AIRCRAFT = 3;

// In-memory cache (per-isolate, Vercel Edge)
let cached = null;
let cachedAt = 0;
const CACHE_TTL = 3600_000; // 1 hour

async function fetchGpsJamData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;

  // 1. Get latest date from manifest
  const manifestResp = await fetch(`${BASE_URL}/manifest.csv`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!manifestResp.ok) throw new Error(`Manifest HTTP ${manifestResp.status}`);
  const manifest = await manifestResp.text();
  const lines = manifest.trim().split('\n');
  const latestDate = lines[lines.length - 1].split(',')[0];

  // 2. Fetch hex data
  const hexResp = await fetch(`${BASE_URL}/${latestDate}-h3_4.csv`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!hexResp.ok) throw new Error(`Hex data HTTP ${hexResp.status}`);
  const csv = await hexResp.text();
  const rows = csv.trim().split('\n');

  // 3. Filter medium/high only
  const hexes = [];
  for (let i = 1; i < rows.length; i++) {
    const parts = rows[i].split(',');
    if (parts.length < 3) continue;
    const hex = parts[0];
    const good = parseInt(parts[1], 10);
    const bad = parseInt(parts[2], 10);
    const total = good + bad;
    if (total < MIN_AIRCRAFT) continue;
    const pct = (bad / total) * 100;
    let level;
    if (pct > 10) level = 'high';
    else if (pct >= 2) level = 'medium';
    else continue;
    hexes.push({ h3: hex, pct: Math.round(pct * 10) / 10, good, bad, total, level });
  }

  // Sort: high first, then by pct desc
  hexes.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
    return b.pct - a.pct;
  });

  const result = {
    date: latestDate,
    fetchedAt: new Date().toISOString(),
    source: 'gpsjam.org',
    stats: {
      totalHexes: rows.length - 1,
      highCount: hexes.filter(h => h.level === 'high').length,
      mediumCount: hexes.filter(h => h.level === 'medium').length,
    },
    hexes,
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

  try {
    const data = await fetchGpsJamData();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=1800',
        ...corsHeaders,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
