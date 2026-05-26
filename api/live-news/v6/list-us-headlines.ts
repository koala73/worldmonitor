/**
 * HTTP entry — `GET /api/live-news/v6/list-us-headlines`
 *
 * Self-hosted RSS + Gemini-embedding-clustered feed. No LLM summary —
 * wire `summary` is the longest plaintext RSS description from the
 * cluster. `imageUrl` field is new vs v3/v4/v5; old iOS builds ignore it.
 */

// @ts-expect-error
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error
import { checkRateLimit } from '../../_rate-limit.js';
import { listUsHeadlinesV6 } from '../../../server/live-news/v6/list-us-headlines';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return new Response(JSON.stringify({ error: keyCheck.error }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const rl = await checkRateLimit(req, corsHeaders);
  if (rl) return rl;

  try {
    const body = await listUsHeadlinesV6();
    const count = body.items?.length ?? 0;
    // Truthful log line — Vercel tags each log with its region, so filtering
    // by region (e.g. iad1) shows exactly what US users were served. A bare
    // `status=200` could not distinguish a full feed from an empty one.
    console.log(`[live-news:v6] served items=${count}${count === 0 ? ' (EMPTY — not caching)' : ''}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // Never cache an empty feed (belt-and-suspenders alongside the 503
        // path): a zero-item 200 gets no-store so the CDN keeps serving its
        // last good copy. A populated feed gets a long stale window —
        // freshness is far less important than always returning SOMETHING,
        // so once a region is primed it never goes blank: stale-while-
        // revalidate serves instantly while refreshing, and stale-if-error
        // serves the last good feed for up to a day through a Redis outage.
        'Cache-Control': count === 0
          ? 'no-store'
          : 'public, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400',
      },
    });
  } catch (err) {
    // A failed digest read (strict mode throws) lands here. Return 503 with
    // no-store so we NEVER cache an empty feed: the CDN's stale-if-error=300
    // then serves the last good cached response to users instead of a blank
    // one. Caching an empty 200 here would blank an entire edge region.
    console.error('[live-news:v6] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Upstream unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }
}
