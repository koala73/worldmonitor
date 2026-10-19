import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readChinaFuturesRss } from './_china-futures-news.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) return jsonResponse({ error: 'Origin not allowed' }, 403, cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, Allow: 'GET, HEAD, OPTIONS' } });
  if (!['GET', 'HEAD'].includes(req.method)) return jsonResponse({ error: 'Method not allowed' }, 405, { ...cors, Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' });
  const rss = await readChinaFuturesRss();
  if (rss === null) return new Response(req.method === 'HEAD' ? null : JSON.stringify({ error: 'SHFE notices unavailable or stale' }), {
    status: 503, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '300' },
  });
  return new Response(req.method === 'HEAD' ? null : rss, {
    headers: { ...getPublicCorsHeaders(), 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=60' },
  });
}
