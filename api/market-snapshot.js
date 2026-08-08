import { getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { checkRateLimit } from './_rate-limit.js';
import { redisPipeline } from './_upstash-json.js';
import { DATASETS, buildMarketSnapshot, marketSnapshotToMarkdown } from './_market-snapshot.js';

export const config = { runtime: 'edge' };
const NO_STORE = { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' };
const SHARED_CACHE = {
  'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120, stale-if-error=300',
  'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120, stale-if-error=300',
};
const RATE_LIMIT = { failClosed: true, scope: 'market-snapshot', limit: 30, window: '60 s' };

function parseFormat(url) {
  const keys = Array.from(url.searchParams.keys());
  if (keys.some((key) => key !== 'format')) return null;
  const formats = url.searchParams.getAll('format');
  if (formats.length > 1) return null;
  const format = formats[0] ?? 'json';
  if (format === 'json') return 'json';
  if (format === 'markdown' || format === 'md') return 'markdown';
  return null;
}

export default async function handler(req, ctx) {
  if (isDisallowedOrigin(req)) return new Response('Forbidden', { status: 403, headers: NO_STORE });
  const cors = getPublicCorsHeaders('GET, OPTIONS');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...NO_STORE, ...cors } });
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, { ...NO_STORE, ...cors });

  const format = parseFormat(new URL(req.url));
  if (!format) return jsonResponse({ error: 'Invalid query parameters' }, 400, { ...NO_STORE, ...cors });

  const limited = await checkRateLimit(req, { ...NO_STORE, ...cors }, { ...RATE_LIMIT, ctx });
  if (limited) return limited;

  let entries;
  try {
    entries = await redisPipeline(DATASETS.map(({ key }) => ['GET', key]), 5_000);
    if (!Array.isArray(entries)) entries = DATASETS.map(() => ({ error: 'redis_unavailable' }));
  } catch {
    entries = DATASETS.map(() => ({ error: 'redis_unavailable' }));
  }
  const snapshot = buildMarketSnapshot(entries);
  const cache = snapshot.summary.error > 0 ? NO_STORE : SHARED_CACHE;
  if (format === 'markdown') {
    return new Response(marketSnapshotToMarkdown(snapshot), {
      status: 200,
      headers: { ...cache, ...cors, 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="worldmonitor-market-snapshot-${snapshot.generatedAt.slice(0, 10)}.md"` },
    });
  }
  return jsonResponse(snapshot, 200, { ...cache, ...cors, 'Content-Disposition': `attachment; filename="worldmonitor-market-snapshot-${snapshot.generatedAt.slice(0, 10)}.json"` });
}
