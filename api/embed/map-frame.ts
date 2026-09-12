/**
 * GET /api/embed/map-frame?layers=…
 *
 * The single endpoint the partner map frame polls, replacing four separate
 * anonymous RPC calls. A credential published in partner HTML has a blast
 * radius equal to the set of paths that accept it, so there is one path and it
 * accepts one parameter.
 *
 * The URL — never a header — decides what a shared cache may hold, because a
 * CDN hit is answered before this function sees a header. That is #5386:
 *
 *   exact public shape   `layers=<canonical free subset>&public=1`, and
 *                        nothing else. Keyless, hourly, shared-cacheable.
 *                        Attached credentials are IGNORED here, so one cached
 *                        body means the same thing for every caller.
 *   everything else      served `private, no-store`. A valid map-scoped `wmg_`
 *                        grant unlocks all fourteen layers at ten minutes; no
 *                        grant still renders the free tier, just uncached.
 *
 * So a near-miss URL degrades to "correct but uncached" rather than to a
 * shared entry that could answer the wrong caller. The keyless tier is a
 * deliberate growth surface and must keep working with no credential at all.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import {
  checkEndpointRateLimit,
  type EndpointRateLimitOptions,
} from '../../server/_shared/rate-limit';
import { getCachedJson } from '../../server/_shared/redis';
import { drainResponseHeaders, markNoCacheResponse } from '../../server/_shared/response-headers';
import { BOOTSTRAP_CACHE_KEYS } from '../../shared/bootstrap-tier-keys.js';
import {
  verifyEmbedGrant,
  type EmbedGrantClaims,
} from '../../server/_shared/embed-grant';
import {
  cacheControlForEmbedFrame,
  composeEmbedMapFrame,
  parseRequestedLayers,
  type EmbedMapFrameSources,
  type EmbedMapFrameTier,
} from '../../server/_shared/embed-map-frame';
import {
  classifyPublicEmbedFrameRequest,
  EMBED_MAP_FRAME_PATH,
  type EmbedMapFrameResponse,
} from '../../shared/embed-map-frame';
import type { EmbedLayerId } from '../../shared/embed-panels';
import { listAcledEvents } from '../../server/worldmonitor/conflict/v1/list-acled-events';
import { listEarthquakes } from '../../server/worldmonitor/seismology/v1/list-earthquakes';
import { listNaturalEvents } from '../../server/worldmonitor/natural/v1/list-natural-events';
import { listUnrestEvents } from '../../server/worldmonitor/unrest/v1/list-unrest-events';

const WEATHER_CACHE_KEY = BOOTSTRAP_CACHE_KEYS.weatherAlerts;

/** Build the generated handler context for an in-process source read. */
function handlerContext(req: Request) {
  return { request: req, pathParams: {}, headers: Object.fromEntries(req.headers) };
}

function buildSources(req: Request): EmbedMapFrameSources {
  const ctx = handlerContext(req);
  // Each upstream is called with ITS OWN defaults — zeros mean "handler
  // default" across these generated requests. Forwarding a caller-supplied
  // window or page size here would hand a stolen credential the knobs this
  // endpoint exists to remove.
  return {
    listConflicts: async () => {
      // Isolate this source's fallback signal from the other parallel readers.
      const conflictReq = new Request(req);
      const response = await listAcledEvents(handlerContext(conflictReq), { start: 0, end: 0, pageSize: 0, cursor: '', country: '' });
      if (drainResponseHeaders(conflictReq)?.['X-No-Cache']) {
        markNoCacheResponse(req);
        throw new Error('Conflict seed unavailable');
      }
      return response.events;
    },
    listEarthquakes: async () =>
      (await listEarthquakes(ctx, { minMagnitude: 0, start: 0, end: 0, pageSize: 0, cursor: '' })).earthquakes,
    listNaturalEvents: async () => (await listNaturalEvents(ctx, { days: 30 })).events,
    listProtests: async () =>
      (await listUnrestEvents(ctx, {
        country: '',
        start: 0,
        end: 0,
        pageSize: 0,
        cursor: '',
        // The handler reads neither the bbox nor minSeverity; these are here
        // only to satisfy the generated request type. Kept at their zero values
        // so that if it ever starts reading them, the embed asks for no filter
        // rather than silently inheriting one.
        minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED',
        neLat: 0,
        neLon: 0,
        swLat: 0,
        swLon: 0,
      })).events,
    listWeatherAlerts: async () => {
      const cached = await getCachedJson(WEATHER_CACHE_KEY, true) as { alerts?: unknown[] } | null;
      return cached?.alerts ?? [];
    },
  };
}

function grantFromHeaders(headers: Headers): string | null {
  const grant = (headers.get('X-WorldMonitor-Grant') ?? '').trim();
  return grant || null;
}

export interface EmbedMapFrameHandlerDeps {
  getCorsHeaders: (req: Request) => Record<string, string>;
  verifyGrant: (grant: string | null) => Promise<EmbedGrantClaims | null>;
  checkRateLimit: (
    req: Request,
    pathname: string,
    cors: Record<string, string>,
    options?: EndpointRateLimitOptions,
  ) => Promise<Response | null>;
  composeFrame: (
    layers: readonly EmbedLayerId[],
    tier: EmbedMapFrameTier,
    req: Request,
  ) => Promise<EmbedMapFrameResponse>;
}

const defaultDeps: EmbedMapFrameHandlerDeps = {
  getCorsHeaders,
  verifyGrant: verifyEmbedGrant,
  checkRateLimit: checkEndpointRateLimit,
  composeFrame: (layers, tier, req) => composeEmbedMapFrame(layers, tier, buildSources(req)),
};

export async function handleEmbedMapFrame(
  req: Request,
  deps: EmbedMapFrameHandlerDeps = defaultDeps,
): Promise<Response> {
  const cors = deps.getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'GET, HEAD, OPTIONS' },
    });
  }

  // Classify BEFORE reading any credential. This is the only branch that may
  // produce a shared-cacheable body, and it is decided purely by the URL.
  const sharedLayers = classifyPublicEmbedFrameRequest(req.url, req.method);

  let tier: EmbedMapFrameTier = 'free';
  let principalUserId: string | undefined;
  if (sharedLayers === null) {
    const claims = await deps.verifyGrant(grantFromHeaders(req.headers));
    // An absent or expired grant is not an error: it drops to the free tier,
    // which is what the frame renders while it re-mints. A grant minted for a
    // different panel does not unlock this one.
    if (claims && claims.panel === 'map') {
      tier = 'keyed';
      principalUserId = claims.accountId;
    }
  }

  const limited = await deps.checkRateLimit(
    req,
    EMBED_MAP_FRAME_PATH,
    cors,
    principalUserId ? { principalUserId } : {},
  );
  if (limited) return limited;

  const url = new URL(req.url);
  const layers = sharedLayers ?? parseRequestedLayers(url.searchParams.get('layers'));
  const frame = await deps.composeFrame(layers, tier, req);

  const headers: Record<string, string> = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': cacheControlForEmbedFrame(sharedLayers !== null),
  };
  if (drainResponseHeaders(req)?.['X-No-Cache']) {
    headers['Cache-Control'] = cacheControlForEmbedFrame(false);
  }
  // Only the uncacheable branch reads the grant header, and only there can the
  // body depend on it. Declaring Vary on the shared entry would fragment it on
  // a header that cannot change the answer — the tier is already in the cache
  // key, because it is in the URL.
  if (sharedLayers === null) headers.Vary = 'X-WorldMonitor-Grant';

  return new Response(JSON.stringify(frame), { status: 200, headers });
}

export default function handler(req: Request): Promise<Response> {
  return handleEmbedMapFrame(req);
}
