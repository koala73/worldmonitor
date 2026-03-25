import type {
  ForecastServiceHandler,
  ServerContext,
  GetSimulationPackageRequest,
  GetSimulationPackageResponse,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { getRawJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { SIMULATION_PACKAGE_LATEST_KEY } from '../../../_shared/cache-keys';

type PackagePointer = { runId: string; pkgKey: string; schemaVersion: string; theaterCount: number; generatedAt: number };

function isPackagePointer(v: unknown): v is PackagePointer {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['runId'] === 'string' && typeof o['pkgKey'] === 'string'
    && typeof o['schemaVersion'] === 'string' && typeof o['theaterCount'] === 'number'
    && typeof o['generatedAt'] === 'number';
}

const NOT_FOUND: GetSimulationPackageResponse = {
  found: false, runId: '', pkgKey: '', schemaVersion: '', theaterCount: 0, generatedAt: 0, note: '', error: '',
};

export const getSimulationPackage: ForecastServiceHandler['getSimulationPackage'] = async (
  ctx: ServerContext,
  req: GetSimulationPackageRequest,
): Promise<GetSimulationPackageResponse> => {
  try {
    const raw = await getRawJson(SIMULATION_PACKAGE_LATEST_KEY);
    const pointer = isPackagePointer(raw) ? raw : null;
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
