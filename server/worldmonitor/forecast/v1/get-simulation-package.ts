import type {
  ForecastServiceHandler,
  ServerContext,
  GetSimulationPackageRequest,
  GetSimulationPackageResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getRawJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';

const SIMULATION_PACKAGE_LATEST_KEY = 'forecast:simulation-package:latest';

const NOT_FOUND: GetSimulationPackageResponse = {
  found: false, runId: '', pkgKey: '', schemaVersion: '', theaterCount: 0, generatedAt: 0, note: '', error: '',
};

export const getSimulationPackage: ForecastServiceHandler['getSimulationPackage'] = async (
  ctx: ServerContext,
  req: GetSimulationPackageRequest,
): Promise<GetSimulationPackageResponse> => {
  try {
    const pointer = await getRawJson(SIMULATION_PACKAGE_LATEST_KEY) as {
      runId: string; pkgKey: string; schemaVersion: string; theaterCount: number; generatedAt: number;
    } | null;
    if (!pointer?.pkgKey) {
      markNoCacheResponse(ctx.request); // don't cache not-found — package may appear soon after a deep run
      return NOT_FOUND;
    }
    const note = req.runId && req.runId !== pointer.runId
      ? 'runId filter not yet active; returned package may differ from requested run'
      : '';
    return { found: true, runId: pointer.runId, pkgKey: pointer.pkgKey, schemaVersion: pointer.schemaVersion, theaterCount: pointer.theaterCount, generatedAt: pointer.generatedAt, note, error: '' };
  } catch (err) {
    console.warn('[getSimulationPackage] Redis error:', err instanceof Error ? err.message : String(err));
    markNoCacheResponse(ctx.request); // don't cache error state
    return { ...NOT_FOUND, error: 'redis_unavailable' };
  }
};
