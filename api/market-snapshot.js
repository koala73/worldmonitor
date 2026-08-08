import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { redisPipeline } from './_upstash-json.js';
import { DATASETS, buildMarketSnapshot, marketSnapshotToMarkdown } from './_market-snapshot.js';

export const config = { runtime: 'edge' };
const NO_STORE = { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' };

export default async function handler(req) {
  if (isDisallowedOrigin(req)) return new Response('Forbidden', { status: 403, headers: NO_STORE });
  const cors = getCorsHeaders(req, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...NO_STORE, ...cors } });
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, { ...NO_STORE, ...cors });

  let entries;
  try {
    entries = await redisPipeline(DATASETS.map(({ key }) => ['GET', key]), 5_000);
  } catch {
    entries = DATASETS.map(() => ({ error: 'redis_unavailable' }));
  }
  const snapshot = buildMarketSnapshot(entries);
  const format = new URL(req.url).searchParams.get('format');
  if (format === 'markdown' || format === 'md') {
    return new Response(marketSnapshotToMarkdown(snapshot), {
      status: 200,
      headers: { ...NO_STORE, ...cors, 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="worldmonitor-market-snapshot-${snapshot.generatedAt.slice(0, 10)}.md"` },
    });
  }
  return jsonResponse(snapshot, 200, { ...NO_STORE, ...cors, 'Content-Disposition': `attachment; filename="worldmonitor-market-snapshot-${snapshot.generatedAt.slice(0, 10)}.json"` });
}
