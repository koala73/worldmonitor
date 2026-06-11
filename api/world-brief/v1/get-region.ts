/**
 * HTTP entry — `GET /api/world-brief/v1/get-region?regionId=<id>`
 *
 * Serves one per-region brief (`news:world-brief:region:<id>:v1`) to the iOS
 * "My Briefs" feature. Body is the same `WorldBriefPayload` the global brief
 * uses, so the app decodes it with the existing model and selects the
 * requested category section client-side.
 *
 * Cache policy follows the never-cache-empty rule:
 *   • populated → 200, long CDN cache (s-maxage=300)
 *   • not yet generated → 404, no-store (never cache an empty brief)
 *   • Redis read failed → 503, no-store
 *   • bad/missing regionId → 400, no-store
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
import { getRegionBrief, getRegionBriefAt, isRegionId } from '../../../server/world-brief/v1/get-region';

export const config = { runtime: 'edge' };

/** Same "reasonably close" window the live `at=` resolution uses. */
const MAX_SLOT_DISTANCE_MS = 12 * 60 * 60 * 1000;

/**
 * Origin-level last-known-good: serve the persisted latest brief for this
 * region when the live path can't produce one. For `at=` requests the LKG
 * (a copy of `latest`) is only acceptable when its generatedAt is within
 * the same 12h window the live path applies — otherwise we'd show a brief
 * that doesn't match the requested delivery slot.
 */
async function lkgBriefResponse(
  regionId: string,
  atMs: number | null,
  jsonHeaders: Record<string, string>,
  reason: string,
): Promise<Response | null> {
  const lkg = await getLkg(`brief-${regionId}`);
  if (!lkg) return null;
  const generatedAt = (lkg.payload as { generatedAt?: number }).generatedAt ?? 0;
  if (atMs !== null && Math.abs(generatedAt - atMs) > MAX_SLOT_DISTANCE_MS) return null;
  console.warn(`[world-brief:get-region:${regionId}] serving LKG (${lkg.ageMinutes} min old, ${reason})`);
  await notifySlack(
    'world-brief-lkg',
    '🟡 *world-brief/get-region → serving last-known-good*\n' +
    `*What:* live path ${reason} for regionId=${regionId}\n` +
    `*Users:* getting the LKG brief (${lkg.ageMinutes} min old) — populated, not a 404/503\n` +
    '*Check:* Upstash latency · region-brief cron (hourly :20)',
  );
  return new Response(JSON.stringify(lkg.payload), {
    status: 200,
    headers: {
      ...jsonHeaders,
      'Cache-Control': 'public, s-maxage=60',
      'X-WM-Data-Source': 'lkg',
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');
  const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: jsonHeaders });
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: jsonHeaders });
  }

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return new Response(JSON.stringify({ error: keyCheck.error }), { status: 401, headers: jsonHeaders });
  }

  const rl = await checkRateLimit(req, corsHeaders);
  if (rl) return rl;

  // Empty/error responses must never be CDN-cached (never-cache-empty rule).
  const noStore = { ...jsonHeaders, 'Cache-Control': 'no-store' };

  const raw = new URL(req.url).searchParams.get('regionId');
  const regionId = raw && raw.trim() ? raw.trim() : null;
  if (!isRegionId(regionId)) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid regionId', regionId: regionId ?? null }),
      { status: 400, headers: noStore },
    );
  }

  // Optional `at=<unix seconds>` — fetch the snapshot for that delivery time
  // (nearest-before, else closest available). Absent/invalid → latest brief.
  const atRaw = new URL(req.url).searchParams.get('at');
  const atSeconds = atRaw != null ? Number(atRaw) : NaN;

  try {
    const result = Number.isFinite(atSeconds)
      ? await getRegionBriefAt(regionId, atSeconds * 1000)
      : await getRegionBrief(regionId);
    const atMs = Number.isFinite(atSeconds) ? atSeconds * 1000 : null;
    switch (result.status) {
      case 'ok':
        // Persist the LATEST brief as last-known-good (snapshots from `at=`
        // requests would regress the LKG to an older delivery slot).
        if (atMs === null) await maybePutLkg(`brief-${regionId}`, result.payload);
        return new Response(JSON.stringify(result.payload), {
          status: 200,
          headers: {
            ...jsonHeaders,
            // Long stale-if-error (24h) so the CDN serves the last known-good
            // brief through an extended origin/Redis outage instead of going
            // empty — matches the feed + bootstrap endpoints (never-cache-empty).
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=120, stale-if-error=86400',
          },
        });
      case 'empty': {
        // Key genuinely missing (lost/TTL-lapsed) — the LKG is strictly
        // better than a 404 here. For `at=` slots the 12h rule still applies.
        const lkgResp = await lkgBriefResponse(regionId, atMs, jsonHeaders, 'returned empty (key missing)');
        if (lkgResp) return lkgResp;
        return new Response(
          JSON.stringify({ error: 'No brief for this region yet', regionId }),
          { status: 404, headers: noStore },
        );
      }
      case 'unavailable': {
        const lkgResp = await lkgBriefResponse(regionId, atMs, jsonHeaders, 'failed (Redis read error)');
        if (lkgResp) return lkgResp;
        await notifySlack(
          'world-brief-503',
          '🔴 *world-brief/get-region → 503 (no LKG available)*\n' +
          `*What:* Redis read failed for regionId=${regionId}\n` +
          '*Users:* CDN serving last known-good brief for primed regions (stale-if-error, up to 24h); cold regions see retry state\n' +
          '*Check:* Upstash latency · region-brief cron (hourly :20) · Blob store (LKG was missing/stale)',
        );
        return new Response(
          JSON.stringify({ error: 'Brief temporarily unavailable', regionId }),
          { status: 503, headers: noStore },
        );
      }
    }
  } catch (err) {
    console.error('[world-brief:v1:get-region] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: noStore });
  }
}
