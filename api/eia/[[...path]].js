// EIA (Energy Information Administration) passthrough.
// Redis-only reader. Railway seeder `seed-eia-petroleum.mjs` (bundled in
// `seed-bundle-energy-sources`) writes `energy:eia-petroleum:v1`; this
// endpoint reads from Redis and never hits api.eia.gov at request time.
// Gold standard per feedback_vercel_reads_only.md.

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { readJsonFromUpstash } from '../_upstash-json.js';

export const config = { runtime: 'edge' };

const CANONICAL_KEY = 'energy:eia-petroleum:v1';

export default async function handler(req) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/eia', '');

  if (path === '/health' || path === '') {
    return Response.json({ configured: true }, { headers: cors });
  }

  if (path === '/petroleum') {
    let data;
    try {
      data = await readJsonFromUpstash(CANONICAL_KEY, 3_000);
    } catch {
      data = null;
    }

    if (!data) {
      return Response.json(
        { error: 'Data not yet seeded', hint: 'Retry in a few minutes' },
        {
          status: 503,
          headers: { ...cors, 'Cache-Control': 'no-store', 'Retry-After': '300' },
        },
      );
    }

    return Response.json(data, {
      headers: {
        ...cors,
        'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=86400',
      },
    });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
}
