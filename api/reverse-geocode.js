import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

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

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey = `geocode:${latN.toFixed(1)},${lonN.toFixed(1)}`;

  if (redisUrl && redisToken) {
    try {
      const cached = await fetch(`${redisUrl}/get/${encodeURIComponent(cacheKey)}`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(1500),
      });
      if (cached.ok) {
        const data = await cached.json();
        if (data.result) {
          return new Response(data.result, {
            status: 200,
            headers: {
              ...cors,
              'Content-Type': 'application/json',
              'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
            },
          });
        }
      }
    } catch { /* cache miss, fetch fresh */ }
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

    if (redisUrl && redisToken && country && code) {
      ctx.waitUntil(
        fetch(redisUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(['SET', cacheKey, body, 'EX', 604800]),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {}),
      );
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
