/**
 * CORS proxy for Google My Maps KML exports.
 *
 * Usage: GET /api/gmaps-kml?url=<encoded-kml-url>
 *
 * Google My Maps KML exports are blocked by CORS when fetched from a browser
 * directly. This Edge Function proxies the request server-side and returns the
 * KML with permissive CORS headers so the client can parse it.
 *
 * Only Google Maps KML export URLs are accepted (allowlisted hostname) to
 * prevent this endpoint from being used as an open proxy.
 */

export const config = { runtime: 'edge' };

const ALLOWED_HOSTNAMES = new Set(['www.google.com', 'maps.google.com']);

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const kmlUrl = searchParams.get('url');

  if (!kmlUrl) {
    return new Response('Missing ?url= parameter', { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(kmlUrl);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    return new Response('URL not allowed', { status: 403 });
  }

  const upstream = await fetch(kmlUrl, {
    headers: { 'User-Agent': 'WorldMonitor/1.0' },
  });

  if (!upstream.ok) {
    return new Response('Upstream fetch failed', { status: upstream.status });
  }

  const kmlText = await upstream.text();

  return new Response(kmlText, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.google-earth.kml+xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300, s-maxage=600',
    },
  });
}
