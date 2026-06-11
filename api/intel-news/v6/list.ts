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
// @ts-expect-error
import { notifySlack } from '../../_slack.js';
// @ts-expect-error
import { maybePutLkg, getLkg } from '../../_lkg.js';
import { listIntelNewsV6 } from '../../../server/intel-news/v6/list';
import type { IntelNewsV6Item } from '../../../server/intel-news/v6/list';

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
    const count = body.items?.length ?? 0;
    // LKG: persist only the canonical all-categories response (the app's
    // request shape). A ?category= fallback re-filters it at serve time.
    if (count > 0 && !category) await maybePutLkg('intel-news-v6', body);
    console.log(`[intel-news:v6] served items=${count}${count === 0 ? ' (EMPTY — not caching)' : ''}`);
    if (count === 0 && !category) {
      // Zero items across ALL categories from a populated digest means the
      // enrich cron stopped tagging topics — every category feed is blank.
      // (A single ?category= coming back empty is legitimate and stays quiet.)
      await notifySlack(
        'intel-news-empty',
        '🟠 *intel-news/v6 → EMPTY 200 for ALL categories (no-store)*\n' +
        '*What:* digest is populated but no cluster carries any topic tag\n' +
        '*Users:* every category feed blank; CDN good copy stops refreshing while this persists\n' +
        '*Check:* enrich cron (:09/:24/:39/:54) — topic tagging likely broken',
      );
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // Never cache an empty response (feedback_never_cache_null_empty): a
        // zero-item 200 gets no-store so the CDN keeps serving its last good
        // copy. A populated response gets a 5-min CDN cache + long stale
        // windows (data only changes on the ~15-min digest refresh anyway).
        'Cache-Control': count === 0
          ? 'no-store'
          : 'public, s-maxage=300, stale-while-revalidate=600, stale-if-error=86400',
      },
    });
  } catch (err) {
    // A failed digest read (strict mode throws) OR a missing/empty digest
    // (never legitimate — also throws) lands here. Return 503 + no-store so we
    // NEVER cache or serve an empty response; the CDN's stale-if-error serves
    // the last known-good feed instead — matches live-news/conflict.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[intel-news:v6:list] handler failed:', msg);

    // Origin-level last-known-good (covers cold CDN variants). The stored
    // copy is the all-categories response; apply the ?category filter here.
    const url = new URL(req.url);
    const rawCat = url.searchParams.get('category');
    const category = rawCat && rawCat.trim() ? rawCat.trim() : null;
    const lkg = await getLkg('intel-news-v6');
    if (lkg) {
      const all = (lkg.payload.items ?? []) as IntelNewsV6Item[];
      const items = category ? all.filter((i) => (i.topics ?? []).includes(category)) : all;
      console.warn(`[intel-news:v6:list] serving LKG (${lkg.ageMinutes} min old, category=${category ?? 'all'}, ${items.length} items)`);
      await notifySlack(
        'intel-news-lkg',
        '🟡 *intel-news/v6 → serving last-known-good*\n' +
        `*What:* live path failed (${msg.slice(0, 150)})\n` +
        `*Users:* getting the LKG categories feed (${lkg.ageMinutes} min old) — populated, not blank\n` +
        '*Check:* Upstash latency/size of `live-news:v6:digest` · refresh + enrich crons',
      );
      return new Response(JSON.stringify({ ...lkg.payload, category, items }), {
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
      'intel-news-503',
      '🔴 *intel-news/v6 → 503 (no LKG available)*\n' +
      `*What:* ${msg.slice(0, 200)}\n` +
      '*Users:* CDN serving last known-good feed for primed variants (stale-if-error, up to 24h); cold variants see errors\n' +
      '*Check:* Upstash latency/size of `live-news:v6:digest` · refresh + enrich crons · Blob store (LKG was missing/stale)',
    );
    return new Response(JSON.stringify({ error: 'Upstream unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }
}
