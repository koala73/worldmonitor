import type {
  ServerContext,
  GetTheaterPostureRequest,
  GetTheaterPostureResponse,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'theater-posture:sebuf:v1';
const STALE_CACHE_KEY = 'theater_posture:sebuf:stale:v1';
const BACKUP_CACHE_KEY = 'theater-posture:sebuf:backup:v1';

// All theater posture assembly (OpenSky + Wingbits + classification)
// happens on Railway (ais-relay.cjs seedTheaterPosture loop + seed-military-flights.mjs).
// This handler reads pre-built data from Redis only.
// Gold standard: Vercel reads, Railway writes.

export async function getTheaterPosture(
  _ctx: ServerContext,
  _req: GetTheaterPostureRequest,
): Promise<GetTheaterPostureResponse> {
  try {
    const live = await getCachedJson(CACHE_KEY, true) as GetTheaterPostureResponse | null;
    if (live?.theaters?.length) return live;
  } catch { /* fall through to stale/backup */ }

  try {
    const stale = await getCachedJson(STALE_CACHE_KEY, true) as GetTheaterPostureResponse | null;
    if (stale?.theaters?.length) return stale;
  } catch { /* fall through to backup */ }

  try {
    const backup = await getCachedJson(BACKUP_CACHE_KEY, true) as GetTheaterPostureResponse | null;
    if (backup?.theaters?.length) return backup;
  } catch { /* empty */ }

  return { theaters: [] };
}
