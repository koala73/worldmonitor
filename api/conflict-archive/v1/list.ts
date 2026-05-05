/**
 * HTTP entry — `GET /api/conflict-archive/v1/list`
 *
 * Read-only conflict archive endpoint. Returns up to 500 conflict-flagged
 * items (LLM-classified live-news + GDELT conflict topic) from the last
 * 30 days, regardless of whether they're still in the upstream news
 * windows. iOS feed and map both consume this for the CONFLICT chip.
 */

// @ts-expect-error — sibling .js helpers without local type declarations
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error
import { checkRateLimit } from '../../_rate-limit.js';
import { listConflictArchive } from '../../../server/conflict-archive/v1/list';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return new Response(JSON.stringify({ error: keyCheck.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const rateLimitResponse = await checkRateLimit(req, corsHeaders);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await listConflictArchive();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // 30 s fresh, 60 s SWR, 5 min stale-if-error — same policy as live-news.
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60, stale-if-error=300',
      },
    });
  } catch (err) {
    console.error('[conflict-archive] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
