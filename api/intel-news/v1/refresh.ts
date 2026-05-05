/**
 * HTTP entry — `GET /api/intel-news/v1/refresh`
 *
 * Cron-only endpoint. Sequentially refreshes all 10 GDELT topic
 * accumulators with 5.5-second pacing between calls (per GDELT's
 * fair-use rate limit).
 *
 * Triggered by Vercel cron (configured in `vercel.json`'s `crons`
 * block, default schedule `*​/15 * * * *`). Manual invocation requires
 * the `CRON_SECRET` env var as a Bearer token — Vercel auto-attaches
 * this header to scheduled cron requests when the secret is set.
 *
 * Vercel Pro plan supports `maxDuration: 60` on edge runtime, which
 * comfortably accommodates a full pass (≈55 s) over the topic list.
 */

// @ts-expect-error — sibling .js helpers without local type declarations
import { getCorsHeaders } from '../../_cors.js';
import { refreshAllTopics } from '../../../server/intel-news/v1/refresh';

export const config = {
  runtime: 'edge',
  maxDuration: 60,
};

function isAuthorizedCron(req: Request): boolean {
  // Vercel cron sends Authorization: Bearer ${CRON_SECRET} when the env
  // var is set. We allow either:
  //   - matching CRON_SECRET (the safe path)
  //   - the `vercel-cron` user-agent (fallback for envs where the
  //     secret isn't yet configured — still cron-only)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth === `Bearer ${secret}`) return true;
  }
  const ua = req.headers.get('user-agent') ?? '';
  if (ua.toLowerCase().includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (!isAuthorizedCron(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const result = await refreshAllTopics();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // Cron should never be cached. Leave the response body for
        // diagnostic / monitoring purposes.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    console.error('[intel-news:refresh] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
