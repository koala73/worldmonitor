import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

export default function handler(req) {
  const cfCountry = req.headers.get('cf-ipcountry');
  const country = (cfCountry && cfCountry !== 'T1' ? cfCountry : null) || req.headers.get('x-vercel-ip-country') || 'XX';
  return jsonResponse({ country }, 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-if-error=3600',
    'Access-Control-Allow-Origin': '*',
  });
}
