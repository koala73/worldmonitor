/**
 * HTTP entry — `GET /api/conflict-archive/v5/list`
 *
 * Merges RSS-embed conflict items + legacy GDELT items. GDELT items
 * keep their LLM-generated summary (legacy data, untouched per spec);
 * RSS-embed items carry the longest-RSS-description as summary.
 */

// @ts-expect-error
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error
import { checkRateLimit } from '../../_rate-limit.js';
import { listConflictArchiveV5 } from '../../../server/conflict-archive/v5/list';

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
    const body = await listConflictArchiveV5();
    const count = body.items?.length ?? 0;
    // Truthful log line — Vercel tags each log with its region, so filtering
    // by region shows what US users were actually served (not just a 200).
    console.log(`[conflict-archive:v5] served items=${count}${count === 0 ? ' (EMPTY — not caching)' : ''}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // Never cache an empty archive; a populated one gets a long stale
        // window so a primed region never goes blank through a Redis outage.
        'Cache-Control': count === 0
          ? 'no-store'
          : 'public, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400',
      },
    });
  } catch (err) {
    // A failed RSE read (strict mode throws) lands here. Return 503 + no-store
    // so we never cache an empty archive: stale-if-error=300 then serves the
    // last good cached response instead of a blank feed for the whole region.
    console.error('[conflict-archive:v5] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Upstream unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }
}
