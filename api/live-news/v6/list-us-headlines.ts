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
// @ts-expect-error
import { notifySlack } from '../../_slack.js';
// @ts-expect-error
import { maybePutLkg, getLkg } from '../../_lkg.js';
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
    // App version (CFBundleShortVersionString) — selects the per-version feed
    // cap. Part of the URL, so the CDN caches each version separately.
    const av = new URL(req.url).searchParams.get('av');
    const body = await listUsHeadlinesV6(av);
    const count = body.items?.length ?? 0;
    // Persist as last-known-good (throttled; the LKG is what we serve when
    // the live path throws AND the CDN has no primed copy for this variant).
    if (count > 0) await maybePutLkg('live-news-v6', body);
    // Truthful log line — Vercel tags each log with its region, so filtering
    // by region (e.g. iad1) shows exactly what US users were served. A bare
    // `status=200` could not distinguish a full feed from an empty one.
    console.log(`[live-news:v6] served items=${count}${count === 0 ? ' (EMPTY — not caching)' : ''}`);
    if (count === 0) {
      // Populated digest filtered down to zero — suspicious (min-sources gate
      // eating everything?) and the response is no-store, so the CDN copy has
      // stopped refreshing. Worth a human look.
      await notifySlack(
        'live-news-empty',
        '🟠 *live-news/v6 → EMPTY 200 (no-store)*\n' +
        '*What:* digest is populated but zero items pass the min-sources gate\n' +
        '*Users:* blank feed served live; CDN good copy stops refreshing while this persists\n' +
        '*Check:* `WM_V6_MIN_SOURCES` env · enrich cron output · digest source counts',
      );
    }
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
          : 'public, s-maxage=300, stale-while-revalidate=600, stale-if-error=86400',
      },
    });
  } catch (err) {
    // A failed digest read (strict mode throws) OR a missing/empty digest
    // (never legitimate — also throws) lands here. Return 503 with no-store
    // so we NEVER cache or serve an empty feed: the CDN's stale-if-error
    // serves the last good cached response instead of a blank one.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[live-news:v6] handler failed:', msg);

    // Origin-level last-known-good: serve the persisted copy so even COLD
    // CDN variants (quiet hours, new ?av=, fresh deploy) get a populated
    // feed. Short s-maxage so the CDN absorbs the fallback load but recovers
    // within a minute once the live path returns.
    const lkg = await getLkg('live-news-v6');
    if (lkg) {
      console.warn(`[live-news:v6] serving LKG (${lkg.ageMinutes} min old)`);
      await notifySlack(
        'live-news-lkg',
        '🟡 *live-news/v6 → serving last-known-good*\n' +
        `*What:* live path failed (${msg.slice(0, 150)})\n` +
        `*Users:* getting the LKG feed (${lkg.ageMinutes} min old) — populated, not blank\n` +
        '*Check:* Upstash latency/size of `live-news:v6:digest` · refresh cron (:03/:18/:33/:48)',
      );
      return new Response(JSON.stringify(lkg.payload), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, s-maxage=60',
          'X-WM-Data-Source': 'lkg',
        },
      });
    }

    await notifySlack(
      'live-news-503',
      '🔴 *live-news/v6 → 503 (no LKG available)*\n' +
      `*What:* ${msg.slice(0, 200)}\n` +
      '*Users:* CDN serving last known-good feed for primed variants (stale-if-error, up to 24h); cold variants see errors\n' +
      '*Check:* Upstash latency/size of `live-news:v6:digest` · refresh cron (:03/:18/:33/:48) · Blob store (LKG was missing/stale)',
    );
    return new Response(JSON.stringify({ error: 'Upstream unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }
}
