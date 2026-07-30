import type {
  ServerContext,
  GetUSNIFleetReportRequest,
  GetUSNIFleetReportResponse,
  USNIFleetReport,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const USNI_CACHE_KEY = 'usni-fleet:sebuf:v1';
const USNI_STALE_CACHE_KEY = 'usni-fleet:sebuf:stale:v1';

export function buildUSNIFleetReportForceRefreshResponse(): GetUSNIFleetReportResponse {
  return {
    report: undefined,
    cached: false,
    stale: false,
    error: 'forceRefresh is no longer supported (data is seeded by Railway relay)',
  };
}

export function buildUSNIFleetReportCacheResponse(
  report: USNIFleetReport | null,
  stale: USNIFleetReport | null,
): GetUSNIFleetReportResponse {
  if (report) {
    return { report, cached: true, stale: false, error: '' };
  }

  if (stale) {
    return { report: stale, cached: true, stale: true, error: 'Using cached data' };
  }

  return {
    report: undefined,
    cached: false,
    stale: false,
    error: 'No USNI fleet data in cache (waiting for seed)',
  };
}

// ========================================================================
// RPC handler (Redis-read-only — Railway relay seeds the data)
// ========================================================================

export async function getUSNIFleetReport(
  _ctx: ServerContext,
  req: GetUSNIFleetReportRequest,
): Promise<GetUSNIFleetReportResponse> {
  if (req.forceRefresh) {
    return buildUSNIFleetReportForceRefreshResponse();
  }

  try {
    const report = (await getCachedJson(USNI_CACHE_KEY)) as USNIFleetReport | null;
    if (report) {
      return buildUSNIFleetReportCacheResponse(report, null);
    }

    const stale = (await getCachedJson(USNI_STALE_CACHE_KEY)) as USNIFleetReport | null;
    return buildUSNIFleetReportCacheResponse(null, stale);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[USNI Fleet] Error:', message);
    return { report: undefined, cached: false, stale: false, error: message };
  }
}
