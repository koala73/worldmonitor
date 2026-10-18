import type {
  ServerContext,
  GetTheaterPostureRequest,
  GetTheaterPostureResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import {
  hasRedistributableProviderAttribution,
  requiresRedistributableProviders,
} from '../../../_shared/provider-redistribution';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const CACHE_KEY = 'theater-posture:sebuf:v1';
const STALE_CACHE_KEY = 'theater_posture:sebuf:stale:v1';
const BACKUP_CACHE_KEY = 'theater-posture:sebuf:backup:v1';

// All theater posture assembly (product-only OpenSky fallback + redistributable
// providers + classification)
// happens on Railway (ais-relay.cjs seedTheaterPosture loop + seed-military-flights.mjs).
// This handler reads pre-built data from Redis only.
// Gold standard: Vercel reads, Railway writes.

type ProviderAttributedPosture = GetTheaterPostureResponse & { provider?: unknown };

export async function readTheaterPostureSnapshot(ctx: ServerContext, policy: { redistributableOnly: boolean }) {
  let denied = false;
  for (const [key, status] of [[CACHE_KEY, 'live'], [STALE_CACHE_KEY, 'stale'], [BACKUP_CACHE_KEY, 'backup']] as const) {
    ctx.request.signal.throwIfAborted();
    try {
      const value = await getCachedJson(key, true) as (ProviderAttributedPosture & { fetchedAt?: unknown; computedAt?: unknown }) | null;
      if (!value || !Array.isArray(value.theaters)) continue;
      if (policy.redistributableOnly && !hasRedistributableProviderAttribution(value.provider)) { denied = true; continue; }
      const at = Number(value.fetchedAt ?? value.computedAt);
      const sourceAt = Number.isFinite(at) && at > 0 && at <= 8.64e15 ? new Date(at).toISOString() : null;
      if (!value.theaters.length && (!sourceAt || !hasRedistributableProviderAttribution(value.provider))) continue;
      return { state: 'observed' as const, status, theaters: value.theaters, provider: typeof value.provider === 'string' ? value.provider : null, sourceAt, retrievedAt: new Date().toISOString(), reason: null };
    } catch (error) { if (ctx.request.signal.aborted) throw error; }
  }
  return markNoStoreFallbackResponse(ctx.request, { state: denied ? 'locked' as const : 'unavailable' as const, status: 'fallback' as const, theaters: [], provider: null, sourceAt: null, retrievedAt: new Date().toISOString(), reason: denied ? 'Provider redistribution is not established.' : 'Posture snapshot unavailable.' });
}

function projectAllowedPosture(
  value: unknown,
  redistributableOnly: boolean,
): GetTheaterPostureResponse | null {
  const posture = value as ProviderAttributedPosture | null;
  if (!posture?.theaters?.length) return null;
  if (redistributableOnly && !hasRedistributableProviderAttribution(posture.provider)) return null;
  return { theaters: posture.theaters };
}

export async function getTheaterPosture(
  ctx: ServerContext,
  _req: GetTheaterPostureRequest,
): Promise<GetTheaterPostureResponse> {
  const redistributableOnly = requiresRedistributableProviders(ctx.request);
  try {
    const live = projectAllowedPosture(await getCachedJson(CACHE_KEY, true), redistributableOnly);
    if (live) return live;
  } catch { /* fall through to stale/backup */ }

  try {
    const stale = projectAllowedPosture(await getCachedJson(STALE_CACHE_KEY, true), redistributableOnly);
    if (stale) return stale;
  } catch { /* fall through to backup */ }

  try {
    const backup = projectAllowedPosture(await getCachedJson(BACKUP_CACHE_KEY, true), redistributableOnly);
    if (backup) return backup;
  } catch { /* empty */ }

  return markNoStoreFallbackResponse(ctx.request, { theaters: [] });
}
