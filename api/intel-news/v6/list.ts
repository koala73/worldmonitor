/**
 * HTTP entry — `GET /api/intel-news/v6/list[?category=<id>]`
 *
 * v6 GDELT-category feeds. Reads the RSS-embedding digest and returns the
 * clusters carrying ≥1 category tag. Additive — the live-news + conflict
 * endpoints are unchanged.
 */

// @ts-expect-error
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error
import { checkRateLimit } from '../../_rate-limit.js';
import { listIntelNewsV6 } from '../../../server/intel-news/v6/list';

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
    const url = new URL(req.url);
    const raw = url.searchParams.get('category');
    const category = raw && raw.trim() ? raw.trim() : null;
    // App version (CFBundleShortVersionString) — selects the per-version
    // per-topic cap. Part of the URL, so the CDN caches each version separately.
    const av = url.searchParams.get('av');
    const body = await listIntelNewsV6(category, av);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60, stale-if-error=300',
      },
    });
  } catch (err) {
    console.error('[intel-news:v6:list] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
