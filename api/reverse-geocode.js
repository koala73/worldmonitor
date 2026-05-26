import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash, setCachedData } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';
const CHROME_UA = 'WorldMonitor/2.0 (https://worldmonitor.app)';

export default async function handler(req, ctx) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');

  const latN = Number(lat);
  const lonN = Number(lon);
  if (!lat || !lon || Number.isNaN(latN) || Number.isNaN(lonN)
      || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
    return jsonResponse({ error: 'valid lat (-90..90) and lon (-180..180) required' }, 400, cors);
  }

  const cacheKey = `geocode:${latN.toFixed(1)},${lonN.toFixed(1)}`;

  const cached = await readJsonFromUpstash(cacheKey, 1500);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
      },
    });
  }

  try {
    const resp = await fetch(
      `${NOMINATIM_BASE}?lat=${latN}&lon=${lonN}&format=json&zoom=3&accept-language=en`,
      {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!resp.ok) {
      return jsonResponse({ error: `Nominatim ${resp.status}` }, 502, cors);
    }

    const data = await resp.json();
    const country = data.address?.country;
    const code = data.address?.country_code?.toUpperCase();

    const result = { country: country || null, code: code || null, displayName: data.display_name || country || '' };
    const body = JSON.stringify(result);

    if (country && code) {
      ctx.waitUntil(setCachedData(cacheKey, result, 604800));
    }

    return new Response(body, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    return jsonResponse({ error: 'Nominatim request failed' }, 502, cors);
  }
}
