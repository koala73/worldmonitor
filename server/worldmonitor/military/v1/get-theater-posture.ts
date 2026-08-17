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
